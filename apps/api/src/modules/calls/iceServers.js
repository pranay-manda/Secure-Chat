import { createHmac } from 'node:crypto';

/**
 * ICE servers handed to the two phones of a call (WebRTC `RTCPeerConnection` configuration).
 *
 *  - STUN: lets each phone learn its public address so the phones can connect directly.
 *  - TURN: relays the (still DTLS-SRTP encrypted) media when no direct path exists.
 *
 * TURN credentials are minted per call with the standard "TURN REST API" scheme that coturn
 * implements (`use-auth-secret` / `static-auth-secret`):
 *   username   = "<unix expiry>:<opaque id>"
 *   credential = base64(HMAC-SHA1(sharedSecret, username))
 * The TURN server recomputes the HMAC and refuses expired usernames, so the app only ever holds
 * short-lived credentials and the shared secret never leaves this server. The opaque id is the
 * call id, not a user id, so the TURN server learns nothing about who is calling.
 *
 * Other TURN providers (Twilio, Cloudflare, Metered...) mint credentials through their own
 * APIs; they would plug in here behind the same `buildIceServers` result.
 *
 * @param {{ stunUrls: readonly string[], turn: null | {
 *   urls: readonly string[], secret: string, credentialTtlSeconds: number } }} config
 * @param {{ callId: string, now?: number }} options
 * @returns {Array<{ urls: string[], username?: string, credential?: string }>}
 */
export function buildIceServers(config, { callId, now = Date.now() }) {
  const servers = [];
  if (config.stunUrls.length > 0) servers.push({ urls: [...config.stunUrls] });
  if (config.turn) {
    const expiry = Math.floor(now / 1000) + config.turn.credentialTtlSeconds;
    const username = `${expiry}:${callId}`;
    const credential = createHmac('sha1', config.turn.secret).update(username).digest('base64');
    servers.push({ urls: [...config.turn.urls], username, credential });
  }
  return servers;
}
