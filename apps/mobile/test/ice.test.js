import {
  classifyRoute,
  ICE_ROUTE,
  iceTransportPolicyOf,
  routeText,
  sanitizeIceServers,
} from '../src/calls/ice';

/**
 * ICE configuration handling and connection-path classification (pure functions). The stats
 * below have the shape libwebrtc's getStats() reports; whether real phones produce exactly
 * these pairs (host, srflx, relay) can only be seen on devices.
 */

const TURN = {
  urls: ['turn:turn.example.com:3478?transport=udp'],
  username: '1760000000:11111111-1111-4111-8111-111111111111',
  credential: 'c2VjcmV0LWNyZWRlbnRpYWw=',
};

/** A getStats() result: Map of id -> report, with addresses like the real ones carry. */
function stats({ local, remote, pair = {}, transport = true }) {
  const reports = [
    {
      id: 'L1',
      type: 'local-candidate',
      address: '192.0.2.10',
      ip: '192.0.2.10',
      port: 50000,
      url: 'turn:turn.example.com:3478',
      ...local,
    },
    {
      id: 'R1',
      type: 'remote-candidate',
      address: '198.51.100.7',
      port: 60000,
      ...remote,
    },
    {
      id: 'P1',
      type: 'candidate-pair',
      localCandidateId: 'L1',
      remoteCandidateId: 'R1',
      state: 'succeeded',
      ...pair,
    },
    // A second, unused pair that must not be picked.
    { id: 'P2', type: 'candidate-pair', localCandidateId: 'R1', remoteCandidateId: 'L1' },
  ];
  if (transport) reports.push({ id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' });
  return new Map(reports.map((report) => [report.id, report]));
}

describe('ICE servers from the API', () => {
  it('are passed on as a validated copy (react-native-webrtc rewrites what it is given)', () => {
    const input = [{ urls: ['stun:stun.example.com:3478'] }, TURN];
    const copy = sanitizeIceServers(input);
    expect(copy).toEqual(input);
    expect(copy[1]).not.toBe(input[1]);
    expect(copy[1].urls).not.toBe(input[1].urls);
    copy[1].urls.length = 0;
    expect(input[1].urls).toHaveLength(1); // the API response is untouched
  });

  it('keep only STUN/TURN URLs and string credentials', () => {
    expect(
      sanitizeIceServers([
        { urls: 'turns:turn.example.com:5349', username: 'u', credential: 'c' },
        { urls: ['https://evil.example.com', 'javascript:alert(1)'] },
        { urls: ['stun:ok.example.com', 'http://no.example.com'], username: 42, credential: {} },
        null,
        { username: 'no-urls' },
      ]),
    ).toEqual([
      { urls: ['turns:turn.example.com:5349'], username: 'u', credential: 'c' },
      { urls: ['stun:ok.example.com'] },
    ]);
    expect(sanitizeIceServers(undefined)).toEqual([]);
    expect(sanitizeIceServers({ urls: ['stun:x'] })).toEqual([]);
  });

  it('use relay-only transport only when the API says so', () => {
    expect(iceTransportPolicyOf('relay')).toBe('relay');
    for (const value of ['all', undefined, null, 'RELAY', 'direct', 1]) {
      expect(iceTransportPolicyOf(value)).toBe('all');
    }
  });
});

describe('connection path of a connected call', () => {
  it('both phones on their own addresses: same network', () => {
    expect(
      classifyRoute(
        stats({
          local: { candidateType: 'host', protocol: 'udp' },
          remote: { candidateType: 'host' },
        }),
      ),
    ).toEqual({
      route: ICE_ROUTE.HOST,
      local: 'host',
      remote: 'host',
      protocol: 'udp',
      relayProtocol: null,
    });
  });

  it('an address learned through STUN or from the peer: direct through NAT', () => {
    expect(
      classifyRoute(
        stats({
          local: { candidateType: 'srflx', protocol: 'udp' },
          remote: { candidateType: 'prflx' },
        }),
      ).route,
    ).toBe(ICE_ROUTE.REFLEXIVE);
    expect(
      classifyRoute(
        stats({
          local: { candidateType: 'host', protocol: 'udp' },
          remote: { candidateType: 'srflx' },
        }),
      ).route,
    ).toBe(ICE_ROUTE.REFLEXIVE);
  });

  it('a peer-reflexive address with no STUN or relay candidate: direct, type not claimed', () => {
    // prflx = learned from the peer's own check: it may be a host address or a NAT mapping.
    for (const [local, remote] of [
      ['host', 'prflx'],
      ['prflx', 'host'],
      ['prflx', 'prflx'],
    ]) {
      expect(
        classifyRoute(
          stats({
            local: { candidateType: local, protocol: 'udp' },
            remote: { candidateType: remote },
          }),
        ).route,
      ).toBe(ICE_ROUTE.DIRECT);
    }
  });

  it('a relay candidate on either side: relayed through TURN', () => {
    expect(
      classifyRoute(
        stats({
          local: { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' },
          remote: { candidateType: 'srflx' },
        }),
      ),
    ).toEqual({
      route: ICE_ROUTE.RELAY,
      local: 'relay',
      remote: 'srflx',
      protocol: 'udp',
      relayProtocol: 'tls',
    });
    expect(
      classifyRoute(
        stats({
          local: { candidateType: 'host', protocol: 'tcp' },
          remote: { candidateType: 'relay' },
        }),
      ),
    ).toMatchObject({ route: ICE_ROUTE.RELAY, protocol: 'tcp', relayProtocol: null });
  });

  it('finds the selected pair without a transport report (older stats)', () => {
    const local = { candidateType: 'srflx', protocol: 'udp' };
    const remote = { candidateType: 'srflx' };
    expect(
      classifyRoute(stats({ local, remote, transport: false, pair: { selected: true } })).route,
    ).toBe(ICE_ROUTE.REFLEXIVE);
    expect(
      classifyRoute(stats({ local, remote, transport: false, pair: { nominated: true } })).route,
    ).toBe(ICE_ROUTE.REFLEXIVE);
    // Not nominated and not selected: no path yet.
    expect(classifyRoute(stats({ local, remote, transport: false }))).toBeNull();
  });

  it('says nothing when the stats are missing, incomplete or odd', () => {
    expect(classifyRoute(null)).toBeNull();
    expect(classifyRoute(new Map())).toBeNull();
    expect(
      classifyRoute(
        stats({ local: { candidateType: 'weird' }, remote: { candidateType: 'host' } }),
      ),
    ).toBeNull();
    const broken = stats({ local: { candidateType: 'host' }, remote: { candidateType: 'host' } });
    broken.delete('R1');
    expect(classifyRoute(broken)).toBeNull();
    // Plain objects work too.
    const plain = Object.fromEntries(
      stats({ local: { candidateType: 'host' }, remote: { candidateType: 'host' } }),
    );
    expect(classifyRoute(plain).route).toBe(ICE_ROUTE.HOST);
  });

  it('never carries an address, port or server URL', () => {
    const result = classifyRoute(
      stats({
        local: { candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp' },
        remote: { candidateType: 'host' },
      }),
    );
    expect(Object.keys(result).sort()).toEqual([
      'local',
      'protocol',
      'relayProtocol',
      'remote',
      'route',
    ]);
    const text = JSON.stringify(result);
    for (const leak of ['192.0.2.10', '198.51.100.7', '50000', '60000', 'turn.example.com']) {
      expect(text).not.toContain(leak);
    }
  });

  it('has a short label for each path', () => {
    expect(routeText(ICE_ROUTE.HOST)).toMatch(/same network/);
    expect(routeText(ICE_ROUTE.REFLEXIVE)).toMatch(/NAT/);
    expect(routeText(ICE_ROUTE.RELAY)).toMatch(/TURN/);
    expect(routeText(ICE_ROUTE.DIRECT)).toBe('Direct'); // no NAT/TURN claim
    expect(routeText(ICE_ROUTE.UNDETERMINED)).toBe('Route unknown');
    expect(routeText('unknown')).toBe('');
  });
});
