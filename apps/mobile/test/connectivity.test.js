/* global jest */
import {
  applyNetworkState,
  CONNECTIVITY,
  connectivityStatus,
  markReachable,
  markUnreachable,
  OFFLINE_AFTER_MS,
  offlineReason,
  useConnectivityStore,
} from '../src/lib/connectivity';

/**
 * Online / connecting / offline is derived from the network interface, NetInfo's reachability
 * probe, whether the API answered recently, and the realtime connection — never from the
 * interface alone.
 */
const T0 = 1_000_000;
const base = { network: 'connected', internetReachable: null, reachableAt: 0, unreachableAt: 0 };

beforeEach(() => {
  useConnectivityStore.setState({
    network: 'unknown',
    networkType: null,
    internetReachable: null,
    reachableAt: 0,
    unreachableAt: 0,
  });
});

describe('connectivity status', () => {
  it('an interface alone is only "connecting"; the backend answering makes it online', () => {
    expect(connectivityStatus(base, 'idle', T0)).toBe(CONNECTIVITY.CONNECTING);
    expect(connectivityStatus({ ...base, reachableAt: T0 - 1000 }, 'idle', T0)).toBe(
      CONNECTIVITY.ONLINE,
    );
  });

  it('a live realtime connection is online regardless of request history', () => {
    expect(connectivityStatus({ ...base, unreachableAt: T0 }, 'connected', T0)).toBe(
      CONNECTIVITY.ONLINE,
    );
  });

  it('connected to Wi-Fi with no internet is offline; so is no interface at all', () => {
    expect(
      connectivityStatus({ ...base, internetReachable: false, reachableAt: T0 }, 'connected', T0),
    ).toBe(CONNECTIVITY.OFFLINE);
    expect(connectivityStatus({ ...base, network: 'none', reachableAt: T0 }, 'connected', T0)).toBe(
      CONNECTIVITY.OFFLINE,
    );
  });

  it('requests failing after a recent success: reconnecting first, offline after the timeout', () => {
    const failing = { ...base, reachableAt: T0, unreachableAt: T0 + 2_000 };
    expect(connectivityStatus(failing, 'unavailable', T0 + 3_000)).toBe(CONNECTIVITY.CONNECTING);
    expect(connectivityStatus(failing, 'unavailable', T0 + OFFLINE_AFTER_MS)).toBe(
      CONNECTIVITY.OFFLINE,
    );
    // Once it answers again it is online at once, and realtime (re)connecting reads as such.
    const recovered = { ...failing, reachableAt: T0 + OFFLINE_AFTER_MS + 1 };
    expect(connectivityStatus(recovered, 'unavailable', T0 + OFFLINE_AFTER_MS + 2)).toBe(
      CONNECTIVITY.ONLINE,
    );
    expect(connectivityStatus(recovered, 'connecting', T0 + OFFLINE_AFTER_MS + 2)).toBe(
      CONNECTIVITY.CONNECTING,
    );
  });

  it('says whether the phone has no internet or only our server is unreachable', () => {
    const now = T0 + OFFLINE_AFTER_MS;
    const serverDown = { ...base, internetReachable: true, reachableAt: T0, unreachableAt: now };
    expect(connectivityStatus(serverDown, 'failed', now)).toBe(CONNECTIVITY.OFFLINE);
    expect(offlineReason(serverDown, 'failed', now)).toBe('server');
    expect(offlineReason({ ...serverDown, internetReachable: false }, 'failed', now)).toBe(
      'network',
    );
    expect(offlineReason({ ...serverDown, network: 'none' }, 'failed', now)).toBe('network');
    // Not offline: no reason at all.
    expect(offlineReason({ ...serverDown, reachableAt: now }, 'failed', now)).toBeNull();
    expect(offlineReason(serverDown, 'connected', now)).toBeNull();
  });

  it('the API client records reachability from responses and failures', () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    markUnreachable();
    expect(useConnectivityStore.getState()).toMatchObject({ reachableAt: 0, unreachableAt: T0 });
    jest.setSystemTime(T0 + 500);
    markReachable();
    expect(useConnectivityStore.getState().reachableAt).toBe(T0 + 500);
    jest.useRealTimers();
  });

  it('tells a network switch apart from coming online or going offline', () => {
    expect(applyNetworkState({ isConnected: true, type: 'wifi' })).toMatchObject({
      cameOnline: true,
      switched: false,
      wentOffline: false,
    });
    expect(applyNetworkState({ isConnected: true, type: 'wifi' })).toMatchObject({
      cameOnline: false,
      switched: false,
    }); // same again: nothing changed
    expect(applyNetworkState({ isConnected: true, type: 'cellular' })).toMatchObject({
      cameOnline: false,
      switched: true,
    });
    expect(applyNetworkState({ isConnected: false, type: 'none' })).toMatchObject({
      wentOffline: true,
      switched: false,
      cameOnline: false,
    });
    expect(
      applyNetworkState({ isConnected: true, type: 'cellular', isInternetReachable: false }),
    ).toMatchObject({ cameOnline: true, switched: false });
    expect(useConnectivityStore.getState()).toMatchObject({
      network: 'connected',
      networkType: 'cellular',
      internetReachable: false,
    });
    // Unknown state (NetInfo not ready): neither online nor offline.
    expect(applyNetworkState({ isConnected: null, type: 'unknown' })).toMatchObject({
      cameOnline: false,
      wentOffline: false,
      switched: false,
    });
    expect(useConnectivityStore.getState().network).toBe('unknown');
  });
});
