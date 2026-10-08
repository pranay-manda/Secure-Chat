import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Build configuration (app.json + app.config.js + eas.json): EAS-provided Firebase file,
 * release API URL rules, blocked Android permissions. No secrets in any of it.
 */
const root = path.join(__dirname, '..');
const appJson = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8'));
const easJson = JSON.parse(readFileSync(path.join(root, 'eas.json'), 'utf8'));
const appConfig = require('../app.config.js');

const saved = {};
const ENV_KEYS = ['EAS_BUILD_PROFILE', 'EXPO_PUBLIC_API_URL', 'GOOGLE_SERVICES_JSON'];
beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const resolve = () => appConfig({ config: structuredClone(appJson.expo) });

describe('Firebase client config for EAS cloud builds', () => {
  it('uses the EAS secret file variable when present, else the local (gitignored) file', () => {
    expect(resolve().android.googleServicesFile).toBe('./google-services.json');

    process.env.GOOGLE_SERVICES_JSON = '/tmp/eas/secret-file-abc/google-services.json';
    expect(resolve().android.googleServicesFile).toBe(
      '/tmp/eas/secret-file-abc/google-services.json',
    );
  });

  it('only changes googleServicesFile; the rest of app.json is untouched', () => {
    process.env.GOOGLE_SERVICES_JSON = '/tmp/x.json';
    const config = resolve();
    const { googleServicesFile: _a, ...android } = config.android;
    const { googleServicesFile: _b, ...original } = appJson.expo.android;
    expect(android).toEqual(original);
    const { android: _c, ...rest } = config;
    const { android: _d, ...originalRest } = appJson.expo;
    expect(rest).toEqual(originalRest);
  });

  it('the Firebase file and service-account keys are never in the repository config', () => {
    const files = ['app.json', 'app.config.js', 'eas.json'].map((f) =>
      readFileSync(path.join(root, f), 'utf8'),
    );
    for (const text of files) {
      expect(text).not.toMatch(/"type"\s*:\s*"service_account"|BEGIN [A-Z ]*PRIVATE KEY/);
      expect(text).not.toMatch(/AIza[0-9A-Za-z_-]{30,}/); // Firebase API key
      expect(text).not.toMatch(/"project_info"|"client_info"/); // google-services.json content
    }
    const gitignore = readFileSync(path.join(root, '../../.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^google-services\.json$/m);
    expect(gitignore).toMatch(/service-account/);
  });
});

describe('API URL of preview/production builds', () => {
  it('stops a release build at configuration time without a real https:// API URL', () => {
    for (const profile of ['preview', 'production']) {
      process.env.EAS_BUILD_PROFILE = profile;
      for (const bad of [
        undefined,
        '',
        'http://api.example.com',
        'https://localhost:4000',
        'https://127.0.0.1',
      ]) {
        if (bad === undefined) delete process.env.EXPO_PUBLIC_API_URL;
        else process.env.EXPO_PUBLIC_API_URL = bad;
        expect(resolve).toThrow(/EXPO_PUBLIC_API_URL must be set to an https:\/\/ server/);
      }
      process.env.EXPO_PUBLIC_API_URL = 'https://api.example.com';
      expect(resolve).not.toThrow();
    }
  });

  it('development builds keep their local URLs', () => {
    for (const profile of ['development', 'development-device', undefined]) {
      if (profile) process.env.EAS_BUILD_PROFILE = profile;
      process.env.EXPO_PUBLIC_API_URL = 'http://10.0.2.2:4000';
      expect(resolve).not.toThrow();
    }
    expect(easJson.build.development.env.EXPO_PUBLIC_API_URL).toBe('http://10.0.2.2:4000');
  });

  it('preview/production read their variables from the EAS environment; no URL is hardcoded', () => {
    expect(easJson.build.preview.environment).toBe('preview');
    expect(easJson.build.production.environment).toBe('production');
    for (const profile of ['preview', 'production']) {
      expect(easJson.build[profile].env?.EXPO_PUBLIC_API_URL).toBeUndefined();
    }
  });

  it('the build-time check and the app’s runtime check agree', () => {
    global.__DEV__ = true;
    process.env.EXPO_PUBLIC_API_URL = 'http://api.test'; // the module validates it on load
    const { isAllowedApiUrl } = require('../src/config/env');
    for (const url of [
      'https://api.example.com',
      'https://chat.example.org/v1',
      'http://api.example.com',
      'https://localhost',
      'https://[::1]:4000',
      'https://0.0.0.0',
      'garbage',
    ]) {
      expect([url, appConfig.isReleaseApiUrl(url)]).toEqual([
        url,
        isAllowedApiUrl(url, { dev: false }),
      ]);
    }
  });
});

describe('Android permissions', () => {
  it('blocks permissions the app does not use, keeps the ones it needs', () => {
    const blocked = appJson.expo.android.blockedPermissions;
    for (const permission of [
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.WRITE_CONTACTS',
    ]) {
      expect(blocked).toContain(permission);
    }
    for (const needed of ['READ_CONTACTS', 'USE_BIOMETRIC', 'USE_FINGERPRINT', 'INTERNET']) {
      expect(blocked).not.toContain(`android.permission.${needed}`);
    }
  });
});
