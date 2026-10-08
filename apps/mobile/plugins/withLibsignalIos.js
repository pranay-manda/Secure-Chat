const fs = require('fs');
const path = require('path');

const { withDangerousMod } = require('expo/config-plugins');

/**
 * iOS build requirements of the official libsignal (LibSignalClient), used by
 * modules/signal-protocol:
 *
 * 1. The pod itself. Signal does not publish LibSignalClient to the CocoaPods trunk; it is
 *    consumed straight from the libsignal git repository at a version tag (exactly how the
 *    Signal iOS app does it). The module's podspec declares `s.dependency 'LibSignalClient'`
 *    and this plugin adds the source line to the generated Podfile.
 *
 * 2. The prebuilt Rust core. LibSignalClient's podspec downloads the precompiled
 *    libsignal_ffi.a for this version from build-artifacts.signal.org and verifies it against
 *    LIBSIGNAL_FFI_PREBUILD_CHECKSUM (an integrity checksum, not a secret; published in
 *    Signal-iOS's Podfile for each version). Without the checksum, `pod install` builds the
 *    Rust core from source, which needs a Rust toolchain on the Mac.
 *
 * Keep VERSION in lockstep with org.signal:libsignal-android (withLibsignalAndroid.js /
 * modules/signal-protocol/android/build.gradle) and @signalapp/libsignal-client.
 */
const VERSION = 'v0.105.0';
const PREBUILD_CHECKSUM = '556a82414b545490085a0e21d94990788bdcbee4d769043f7889397872443faf';
const MARKER = '# withLibsignalIos';

const ENV_LINE = `ENV['LIBSIGNAL_FFI_PREBUILD_CHECKSUM'] ||= '${PREBUILD_CHECKSUM}' ${MARKER}`;
const POD_LINE = `  pod 'LibSignalClient', git: 'https://github.com/signalapp/libsignal.git', tag: '${VERSION}' ${MARKER}`;

/** Pure text transform (exported for tests; prebuild for iOS cannot run on Windows). */
function addLibsignalToPodfile(contents) {
  if (contents.includes(MARKER)) return contents;
  const target = /^(target\s+['"][^'"]+['"]\s+do\s*)$/m;
  if (!target.test(contents)) {
    throw new Error('withLibsignalIos: no target block found in the generated Podfile');
  }
  return `${ENV_LINE}\n${contents.replace(target, `$1\n${POD_LINE}`)}`;
}

module.exports = function withLibsignalIos(config) {
  return withDangerousMod(config, [
    'ios',
    (mod) => {
      const podfilePath = path.join(mod.modRequest.platformProjectRoot, 'Podfile');
      fs.writeFileSync(podfilePath, addLibsignalToPodfile(fs.readFileSync(podfilePath, 'utf8')));
      return mod;
    },
  ]);
};
module.exports.addLibsignalToPodfile = addLibsignalToPodfile;
