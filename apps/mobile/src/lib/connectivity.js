import { create } from 'zustand';

/**
 * What the app knows about its connection to the backend. "Online" is never inferred from the
 * network interface alone: a phone can be on Wi-Fi with no internet. The API client reports
 * every response (reachable) and every network failure (unreachable); NetInfo reports the
 * interface. The user-facing status is derived from all three plus the realtime connection.
 */

/** Without a successful backend contact for this long after a failure, we are offline. */
export const OFFLINE_AFTER_MS = 15_000;

export const CONNECTIVITY = Object.freeze({
  ONLINE: 'online',
  CONNECTING: 'connecting',
  OFFLINE: 'offline',
});

export const useConnectivityStore = create(() => ({
  /** NetInfo: 'unknown' | 'connected' | 'none'. */
  network: 'unknown',
  /** NetInfo type (wifi, cellular, ...); a change means the phone switched networks. */
  networkType: null,
  /** NetInfo's own reachability probe, when it has one (null = unknown). */
  internetReachable: null,
  /** Last time any API response arrived (even an error response proves reachability). */
  reachableAt: 0,
  /** Last time a request failed to reach the API at all (timeout, DNS, no route). */
  unreachableAt: 0,
}));

export const markReachable = () => useConnectivityStore.setState({ reachableAt: Date.now() });
export const markUnreachable = () => useConnectivityStore.setState({ unreachableAt: Date.now() });

/** NetInfo state → store. Returns what changed, for the engine to react to. */
export function applyNetworkState(net) {
  const previous = useConnectivityStore.getState();
  const network = net?.isConnected === false ? 'none' : net?.isConnected ? 'connected' : 'unknown';
  const networkType = net?.type ?? null;
  const internetReachable =
    typeof net?.isInternetReachable === 'boolean' ? net.isInternetReachable : null;
  useConnectivityStore.setState({ network, networkType, internetReachable });
  return {
    cameOnline: network === 'connected' && previous.network !== 'connected',
    wentOffline: network === 'none' && previous.network !== 'none',
    // Wi-Fi ⇄ mobile data: existing sockets may hang on the old interface.
    switched:
      network === 'connected' &&
      previous.network === 'connected' &&
      previous.networkType !== null &&
      networkType !== previous.networkType,
  };
}

/**
 * The status to show.
 *  - offline: no interface, NetInfo says the internet is unreachable, or the API has not
 *    answered for OFFLINE_AFTER_MS since it last failed.
 *  - connecting: an interface exists but the backend has not answered yet (or realtime is
 *    still (re)connecting after a failure).
 *  - online: a live realtime connection, or the API answered recently and nothing failed since.
 *
 * @param {{ network: string, internetReachable: boolean|null, reachableAt: number,
 *           unreachableAt: number }} state
 * @param {string} realtime messaging realtime state (connected, connecting, ...)
 * @param {number} [now]
 */
export function connectivityStatus(state, realtime, now = Date.now()) {
  if (state.network === 'none' || state.internetReachable === false) return CONNECTIVITY.OFFLINE;
  if (realtime === 'connected') return CONNECTIVITY.ONLINE;
  const failing = state.unreachableAt > state.reachableAt;
  if (failing) {
    return now - state.reachableAt >= OFFLINE_AFTER_MS &&
      now - state.unreachableAt < OFFLINE_AFTER_MS * 4
      ? CONNECTIVITY.OFFLINE
      : CONNECTIVITY.CONNECTING;
  }
  if (state.reachableAt === 0 || realtime === 'connecting') return CONNECTIVITY.CONNECTING;
  return CONNECTIVITY.ONLINE;
}

/**
 * Why we are offline, so the user is told the right thing:
 *  - `network`: no interface, or the phone itself reports no internet.
 *  - `server`: the phone is online but our backend does not answer (server down or blocked;
 *    in development, also a USB/adb tunnel that went away).
 * Null when not offline.
 */
export function offlineReason(state, realtime, now = Date.now()) {
  if (connectivityStatus(state, realtime, now) !== CONNECTIVITY.OFFLINE) return null;
  return state.network === 'none' || state.internetReachable === false ? 'network' : 'server';
}

/** Hook form of connectivityStatus for screens. */
export function useConnectivity(realtime) {
  const state = useConnectivityStore();
  return connectivityStatus(state, realtime);
}

/** Hook form of offlineReason. */
export function useOfflineReason(realtime) {
  const state = useConnectivityStore();
  return offlineReason(state, realtime);
}
