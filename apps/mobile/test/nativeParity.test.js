import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The Signal native bridge exists three times (Kotlin for Android, Swift for iOS, the Node
 * test double) and MUST stay one contract, so the shared JS never needs platform branches.
 * These checks are static: they prove parity of names, error codes, versions and registration,
 * not that the Swift code compiles (that needs macOS/Xcode).
 */
const mobile = path.join(__dirname, '..');
const read = (...parts) => readFileSync(path.join(mobile, ...parts), 'utf8');

const kotlin = read(
  'modules/signal-protocol/android/src/main/java/expo/modules/signalprotocol/SignalProtocolModule.kt',
);
const swift = read('modules/signal-protocol/ios/SignalProtocolModule.swift');
const mock = read('test/mocks/signalNativeMock.js');

const asyncFunctions = (source) =>
  [...source.matchAll(/AsyncFunction\("(\w+)"\)/g)].map((m) => m[1]).sort();

describe('Signal native bridge parity (Android / iOS / test double)', () => {
  const androidFunctions = asyncFunctions(kotlin);
  const iosFunctions = asyncFunctions(swift);

  it('exposes the same functions on Android, iOS and in the test double', () => {
    expect(iosFunctions).toEqual(androidFunctions);
    const mocked = [...mock.matchAll(/^\s*'(\w+)',\s*$/gm)].map((m) => m[1]).sort();
    expect(mocked).toEqual(androidFunctions);
  });

  it('covers every native call the shared JS makes, and JS uses every bridge function', () => {
    const sources = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) sources.push(readFileSync(full, 'utf8'));
      }
    };
    walk(path.join(mobile, 'src'));
    // Calls on the module directly or via `const native = getSignalNative()`.
    const calls = new Set();
    for (const source of sources.filter((s) => s.includes('getSignalNative'))) {
      for (const match of source.matchAll(/(?:getSignalNative\(\)|\bnative)\s*\.\s*(\w+)\s*\(/g)) {
        calls.add(match[1]);
      }
    }
    expect([...calls].sort()).toEqual(androidFunctions); // exactly the bridge, all of it
    expect(calls.size).toBeGreaterThanOrEqual(9);
    for (const name of calls) expect(iosFunctions).toContain(name);
  });

  it('maps libsignal failures to the same stable error codes on both platforms', () => {
    for (const code of [
      'UNTRUSTED_IDENTITY',
      'DUPLICATE_MESSAGE',
      'NO_SESSION',
      'MISSING_PREKEY',
      'SIGNAL_ERROR',
    ]) {
      expect(kotlin).toContain(`"${code}"`);
      expect(swift).toContain(`"${code}"`);
    }
  });

  it('pins the SAME official libsignal version everywhere (never a different crypto build)', () => {
    const versions = {
      android: /org\.signal:libsignal-android:(\d+\.\d+\.\d+)/.exec(
        read('modules/signal-protocol/android/build.gradle'),
      )?.[1],
      ios: /const VERSION = 'v(\d+\.\d+\.\d+)'/.exec(read('plugins/withLibsignalIos.js'))?.[1],
      tests: JSON.parse(read('package.json')).devDependencies['@signalapp/libsignal-client'],
    };
    expect(versions.android).toBeDefined();
    expect(versions.ios).toBe(versions.android);
    expect(versions.tests).toBe(versions.android);
  });

  it('registers the module for both platforms and ships an iOS podspec', () => {
    const config = JSON.parse(read('modules/signal-protocol/expo-module.config.json'));
    expect(config.platforms.sort()).toEqual(['android', 'apple']);
    expect(config.android.modules).toEqual(['expo.modules.signalprotocol.SignalProtocolModule']);
    expect(config.apple.modules).toEqual(['SignalProtocolModule']);
    const podspec = read('modules/signal-protocol/ios/SignalProtocol.podspec');
    expect(podspec).toContain("s.dependency 'LibSignalClient'");
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    const appJson = JSON.parse(read('app.json'));
    expect(appJson.expo.plugins).toContain('./plugins/withLibsignalIos');
    expect(appJson.expo.ios.bundleIdentifier).toBe('com.securechat.app');
  });

  it('adds the LibSignalClient pod (and its prebuild checksum) to a generated Podfile', () => {
    // `expo prebuild --platform ios` refuses to run on Windows, so the plugin's transform is
    // tested directly against the shape Expo generates.
    const { addLibsignalToPodfile } = require('../plugins/withLibsignalIos');
    const podfile = [
      "require File.join(File.dirname(`node --print \"require.resolve('expo/package.json')\"`), 'scripts/autolinking')",
      "platform :ios, '15.1'",
      'prepare_react_native_project!',
      "target 'SecureChat' do",
      '  use_expo_modules!',
      '  config = use_native_modules!',
      'end',
    ].join('\n');

    const once = addLibsignalToPodfile(podfile);
    expect(once.startsWith("ENV['LIBSIGNAL_FFI_PREBUILD_CHECKSUM'] ||= '")).toBe(true);
    expect(once).toMatch(
      /target 'SecureChat' do\n {2}pod 'LibSignalClient', git: 'https:\/\/github\.com\/signalapp\/libsignal\.git', tag: 'v\d+\.\d+\.\d+'/,
    );
    expect(addLibsignalToPodfile(once)).toBe(once); // idempotent on re-runs of prebuild
    expect(() => addLibsignalToPodfile('no targets here')).toThrow(/no target block/);
    // The checksum is an integrity pin for the prebuilt Rust core, not a secret.
    expect(once).toMatch(/LIBSIGNAL_FFI_PREBUILD_CHECKSUM'\] \|\|= '[0-9a-f]{64}'/);
  });

  it('never implements crypto in the bridges: every operation delegates to libsignal', () => {
    // No hand-rolled primitives in either bridge (libsignal's own SessionCipher etc. are fine).
    for (const source of [kotlin, swift]) {
      expect(source).not.toMatch(
        /MessageDigest|javax\.crypto|CryptoKit|CommonCrypto|SecRandomCopyBytes/,
      );
    }
    expect(swift).toContain('import LibSignalClient');
  });
});
