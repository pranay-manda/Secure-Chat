/**
 * ICE configuration and connection-path classification for voice calls. Pure functions (no
 * native code), so they are unit-tested directly.
 */

const ICE_URL = /^(stuns?|turns?):/i;

/**
 * A fresh, validated copy of the ICE servers the API returned for this call: only stun:/stuns:/
 * turn:/turns: URLs, and string credentials. A fresh copy also matters because
 * react-native-webrtc rewrites the server objects it is given.
 *
 * @param {unknown} iceServers
 * @returns {Array<{ urls: string[], username?: string, credential?: string }>}
 */
export function sanitizeIceServers(iceServers) {
  if (!Array.isArray(iceServers)) return [];
  return iceServers.flatMap((server) => {
    const urls = []
      .concat(server?.urls ?? [])
      .filter((url) => typeof url === 'string' && ICE_URL.test(url));
    if (urls.length === 0) return [];
    const copy = { urls };
    if (typeof server.username === 'string') copy.username = server.username;
    if (typeof server.credential === 'string') copy.credential = server.credential;
    return [copy];
  });
}

/** `relay` only if the API asked for it; anything else means `all`. */
export const iceTransportPolicyOf = (value) => (value === 'relay' ? 'relay' : 'all');

export const ICE_ROUTE = Object.freeze({
  /** Both phones reached each other on their own addresses (typically the same network). */
  HOST: 'host',
  /** Direct, through NAT: one side's address was learned from STUN (srflx). */
  REFLEXIVE: 'reflexive',
  /**
   * Direct, but the path type cannot be told: an address learned from the peer's own
   * connectivity check (prflx) may be a plain host address or a NAT mapping.
   */
  DIRECT: 'direct',
  /** Through the TURN server. Media is still DTLS-SRTP encrypted end to end. */
  RELAY: 'relay',
  /** Connected, but the stats name no selected candidate pair (yet). */
  UNDETERMINED: 'undetermined',
});

const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const PROTOCOLS = new Set(['udp', 'tcp']);
const RELAY_PROTOCOLS = new Set(['udp', 'tcp', 'tls']);

function reportsOf(stats) {
  if (!stats) return [];
  const all = typeof stats.values === 'function' ? [...stats.values()] : Object.values(stats);
  return all.filter((report) => report && typeof report === 'object');
}

/** The candidate pair carrying the media, by the standard field or the older fallbacks. */
function selectedPair(reports, byId) {
  for (const report of reports) {
    if (report.type === 'transport' && byId.has(report.selectedCandidatePairId)) {
      return byId.get(report.selectedCandidatePairId);
    }
  }
  const pairs = reports.filter((report) => report.type === 'candidate-pair');
  return (
    pairs.find((pair) => pair.selected === true) ??
    pairs.find((pair) => pair.nominated === true && pair.state === 'succeeded') ??
    null
  );
}

/**
 * Which network path a connected call uses, from `RTCPeerConnection.getStats()`. Reads only
 * candidate TYPES and protocols, never addresses or ports, so the result identifies no network
 * and no person and is safe to show or keep.
 *
 * @returns {null | { route: string, local: string, remote: string,
 *                    protocol: 'udp'|'tcp'|null, relayProtocol: 'udp'|'tcp'|'tls'|null }}
 */
export function classifyRoute(stats) {
  const reports = reportsOf(stats);
  const byId = new Map(reports.map((report) => [report.id, report]));
  const pair = selectedPair(reports, byId);
  if (!pair) return null;
  const local = byId.get(pair.localCandidateId);
  const remote = byId.get(pair.remoteCandidateId);
  if (!CANDIDATE_TYPES.has(local?.candidateType) || !CANDIDATE_TYPES.has(remote?.candidateType)) {
    return null;
  }
  const types = [local.candidateType, remote.candidateType];
  let route = ICE_ROUTE.DIRECT; // only prflx/host left: direct, type not knowable
  if (types.includes('relay')) {
    route = ICE_ROUTE.RELAY; // only when the selected pair really uses a relay candidate
  } else if (types.includes('srflx')) {
    route = ICE_ROUTE.REFLEXIVE;
  } else if (types[0] === 'host' && types[1] === 'host') {
    route = ICE_ROUTE.HOST;
  }
  return {
    route,
    local: local.candidateType,
    remote: remote.candidateType,
    protocol: PROTOCOLS.has(local.protocol) ? local.protocol : null,
    relayProtocol:
      local.candidateType === 'relay' && RELAY_PROTOCOLS.has(local.relayProtocol)
        ? local.relayProtocol
        : null,
  };
}

const ROUTE_TEXT = {
  [ICE_ROUTE.HOST]: 'Direct · same network',
  [ICE_ROUTE.REFLEXIVE]: 'Direct · through NAT (STUN)',
  [ICE_ROUTE.DIRECT]: 'Direct',
  [ICE_ROUTE.RELAY]: 'Relayed · TURN',
  [ICE_ROUTE.UNDETERMINED]: 'Route unknown',
};

export const routeText = (route) => ROUTE_TEXT[route] ?? '';
