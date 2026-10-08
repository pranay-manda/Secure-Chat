/* global jest */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resetDevice } from './helpers';

/**
 * Developer tools and session diagnostics exist only in development builds. A release build
 * (`__DEV__ === false`) must neither render them nor even load the developer E2EE card.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  Stack: { Screen: () => null },
}));

const DEV_TEXT =
  /Access token expires|Token refreshes|Live updates|Invalidate access token|E2EE|DEVELOPER|Developer|Reply to last sender|Sync inbox/;

let mounted = [];

async function renderSecurityScreen() {
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const Screen = require('../src/app/(app)/security').default;
  let tree;
  await act(async () => {
    tree = create(React.createElement(Screen));
  });
  mounted.push({ tree, act });
  return tree;
}

const realDev = global.__DEV__;
const realApiUrl = process.env.EXPO_PUBLIC_API_URL;
afterEach(async () => {
  // Unmount (stops the diagnostics timer) before the next test resets modules.
  for (const { tree, act } of mounted) await act(async () => tree.unmount());
  mounted = [];
  global.__DEV__ = realDev;
  process.env.EXPO_PUBLIC_API_URL = realApiUrl;
  jest.dontMock('../src/components/E2EEDevCard');
});

/** Release builds only accept an https:// API (see config/env.js). */
function asReleaseBuild() {
  global.__DEV__ = false;
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test';
}

beforeEach(() => {
  jest.resetModules();
  resetDevice();
});

describe('release build (__DEV__ = false)', () => {
  it('shows no developer tools or session diagnostics on the Security screen', async () => {
    asReleaseBuild();
    // Loading the developer card at all would fail this test.
    jest.doMock('../src/components/E2EEDevCard', () => {
      throw new Error('developer E2EE card loaded in a release build');
    });

    const tree = await renderSecurityScreen();
    const text = JSON.stringify(tree.toJSON());

    expect(text).toMatch(/End-to-end encrypted/);
    expect(text).toMatch(/Device ID/);
    expect(text).not.toMatch(DEV_TEXT);
    expect(tree.root.findAll((n) => n.props.testID === 'developer-diagnostics')).toHaveLength(0);
  });

  it('the token test helper does nothing outside development', async () => {
    asReleaseBuild();
    const tokenStore = require('../src/auth/tokenStore');
    await tokenStore.saveSession({ accessToken: 'h.p.s', refreshToken: 'r', user: { id: 'u' } });
    await tokenStore.devInvalidateAccessToken();
    expect(JSON.parse(globalThis.__device.secureStore.get('auth.session')).accessToken).toBe(
      'h.p.s',
    );
  });
});

describe('development build (__DEV__ = true)', () => {
  it('keeps the developer tools available for testing', async () => {
    global.__DEV__ = true;
    jest.doMock('../src/components/E2EEDevCard', () => ({
      E2EEDevCard: () => require('react').createElement('Text', null, 'E2EE (developer)'),
    }));

    const text = JSON.stringify((await renderSecurityScreen()).toJSON());

    expect(text).toMatch(/Access token expires/);
    expect(text).toMatch(/Token refreshes/);
    expect(text).toMatch(/Invalidate access token/);
    expect(text).toMatch(/E2EE \(developer\)/);
  });
});

describe('API URL of release builds', () => {
  it('requires https and a real host outside development; development allows local URLs', () => {
    const { isAllowedApiUrl } = require('../src/config/env');
    const release = (url) => isAllowedApiUrl(url, { dev: false });
    for (const bad of [
      'http://api.example.com',
      'http://localhost:4000',
      'https://localhost:4000',
      'https://127.0.0.1',
      'https://0.0.0.0:4000',
      'https://[::1]:4000',
      'ftp://api.example.com',
      'not a url',
      '',
    ]) {
      expect([bad, release(bad)]).toEqual([bad, false]);
    }
    expect(release('https://api.example.com')).toBe(true);
    expect(release('https://chat.example.org/api')).toBe(true);
    for (const local of [
      'http://localhost:4000',
      'http://10.0.2.2:4000',
      'http://192.168.1.100:4000',
    ]) {
      expect(isAllowedApiUrl(local, { dev: true })).toBe(true);
    }
  });

  it('a release build with a missing, http or localhost API URL refuses to start', () => {
    global.__DEV__ = false;
    for (const value of [undefined, 'http://api.example.com', 'https://localhost:4000']) {
      jest.resetModules();
      if (value === undefined) delete process.env.EXPO_PUBLIC_API_URL;
      else process.env.EXPO_PUBLIC_API_URL = value;
      expect(() => require('../src/config/env')).toThrow(/Invalid app configuration/);
    }
    jest.resetModules();
    process.env.EXPO_PUBLIC_API_URL = 'https://api.example.com/';
    expect(require('../src/config/env').env.apiUrl).toBe('https://api.example.com');
  });
});

describe('source guard', () => {
  it('developer-only modules are only ever reached behind __DEV__', () => {
    const src = path.join(__dirname, '../src');
    const security = readFileSync(path.join(src, 'app/(app)/security.js'), 'utf8');
    // No static import of the card (a static import is always bundled).
    expect(security).not.toMatch(/import\s*\{[^}]*E2EEDevCard[^}]*\}\s*from/);
    expect(security).toMatch(/__DEV__ \? require\('..\/..\/components\/E2EEDevCard'\)/);
    const tokenStore = readFileSync(path.join(src, 'auth/tokenStore.js'), 'utf8');
    expect(tokenStore).toMatch(/if \(!__DEV__/);
  });
});
