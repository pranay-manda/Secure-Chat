/* global jest */
/**
 * Signal key setup gates messaging (realtime, sync, heartbeats, calls). An app opened while the
 * server cannot be reached must keep trying, or it stays offline for the whole session even
 * after the connection is back.
 */
jest.mock('../src/crypto/signalService', () => ({ ensureKeysRegistered: jest.fn() }));
jest.mock('../modules/signal-protocol', () => ({ isSignalAvailable: () => true }));

let act;
let create;
let ensureKeysRegistered;
let api;
let hook;
let result;
let appStateListeners;

function Probe() {
  result = hook.useSignalSetup();
  return null;
}

const STATUS = { registered: true, oneTimePreKeyCount: 50 };
const offline = () => new api.NetworkError();
const netListeners = () => [...(globalThis.__device.netListeners ?? [])];

async function mount() {
  let tree;
  await act(async () => {
    tree = create(<Probe />);
  });
  return tree;
}

/** Lets the attempt's promise chain settle (fake timers leave microtasks alone). */
const settle = () => act(async () => {});

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  globalThis.__device.netListeners = new Set();
  appStateListeners = new Set();
  // Loaded after the reset so the renderer and the hook share one React.
  ({ act, create } = require('react-test-renderer'));
  const { AppState } = require('react-native');
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  });
  ({ ensureKeysRegistered } = require('../src/crypto/signalService'));
  api = require('../src/lib/api');
  hook = require('../src/crypto/useSignalSetup');
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Signal key setup', () => {
  it('opened offline: retries on a timer and becomes ready once the server answers', async () => {
    ensureKeysRegistered.mockRejectedValueOnce(offline()).mockResolvedValueOnce(STATUS);
    const tree = await mount();
    expect(result.state).toBe('error');
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTimeAsync(hook.SETUP_RETRY_DELAYS_MS[0]));
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ state: 'ready', status: STATUS, error: null });
    await act(async () => tree.unmount());
  });

  it('backs off between attempts and never loops tightly', async () => {
    ensureKeysRegistered.mockRejectedValue(offline());
    const tree = await mount();
    const [d0, d1, d2, d3] = hook.SETUP_RETRY_DELAYS_MS;
    for (const [delay, calls] of [
      [d0, 2],
      [d1, 3],
      [d2, 4],
      [d3, 5],
      [d3, 6], // the last delay repeats
    ]) {
      await act(async () => jest.advanceTimersByTimeAsync(delay - 1));
      expect(ensureKeysRegistered).toHaveBeenCalledTimes(calls - 1);
      await act(async () => jest.advanceTimersByTimeAsync(1));
      expect(ensureKeysRegistered).toHaveBeenCalledTimes(calls);
    }
    expect(result.state).toBe('error');
    await act(async () => tree.unmount());
  });

  it('the network coming back or the app returning to the screen retries at once', async () => {
    ensureKeysRegistered
      .mockRejectedValueOnce(offline())
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce(STATUS);
    const tree = await mount();
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(1);

    await act(async () => netListeners().forEach((listener) => listener({ isConnected: true })));
    await settle();
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(2);

    await act(async () => [...appStateListeners].forEach((listener) => listener('active')));
    await settle();
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(3);
    expect(result.state).toBe('ready');

    // Ready: further network or foreground events do not register again.
    await act(async () => netListeners().forEach((listener) => listener({ isConnected: true })));
    await act(async () => jest.advanceTimersByTimeAsync(60_000));
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(3);
    await act(async () => tree.unmount());
  });

  it('server errors and rate limits are retried; other failures are not', async () => {
    ensureKeysRegistered
      .mockRejectedValueOnce(new api.ApiError(503, 'HTTP_ERROR', 'Service unavailable'))
      .mockRejectedValueOnce(new api.ApiError(429, 'RATE_LIMITED', 'Too many requests'))
      .mockRejectedValueOnce(new api.ApiError(400, 'VALIDATION_ERROR', 'Bad request'));
    const tree = await mount();
    await act(async () => jest.advanceTimersByTimeAsync(60_000));
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(3); // stopped at the 400
    expect(result.state).toBe('error');
    // A non-network failure is not retried by network events either.
    await act(async () => netListeners().forEach((listener) => listener({ isConnected: true })));
    await settle();
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(3);
    await act(async () => tree.unmount());
  });

  it('a native (key store) failure is not retried', async () => {
    ensureKeysRegistered.mockRejectedValueOnce(new Error('keystore unavailable'));
    const tree = await mount();
    await act(async () => jest.advanceTimersByTimeAsync(60_000));
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(1);
    expect(result.state).toBe('error');
    await act(async () => tree.unmount());
  });

  it('stops retrying and listening once unmounted (sign-out)', async () => {
    ensureKeysRegistered.mockRejectedValue(offline());
    const tree = await mount();
    await act(async () => tree.unmount());
    await act(async () => jest.advanceTimersByTimeAsync(120_000));
    expect(ensureKeysRegistered).toHaveBeenCalledTimes(1);
    expect(netListeners()).toHaveLength(0);
    expect(appStateListeners.size).toBe(0);
  });
});
