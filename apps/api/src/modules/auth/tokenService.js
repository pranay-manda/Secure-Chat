import { randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

import { generateToken, sha256 } from '../../lib/crypto.js';

const ALGORITHM = 'HS256';
const REFRESH_TOKEN_PATTERN = /^([a-f\d]{24})\.([A-Za-z0-9_-]{43})$/;
/** A refresh-token secret: 32 random bytes, base64url (as generateToken(32) produces). */
export const REFRESH_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Access tokens: short-lived HS256 JWTs (sub = userId, sid = sessionId, did = deviceId).
 * Refresh tokens: opaque `<sessionId>.<256-bit random secret>`; only SHA-256(secret) is stored.
 * A fast hash is appropriate because the secret is high-entropy random, not a password.
 *
 * @param {{ jwtAccessSecret: string, jwtIssuer: string, jwtAudience: string,
 *           accessTokenTtlSeconds: number, refreshTokenTtlDays: number }} config
 */
export function createTokenService(config) {
  const key = new TextEncoder().encode(config.jwtAccessSecret);

  async function signAccessToken({ userId, sessionId, deviceId }, { expiresInSeconds } = {}) {
    const ttl = expiresInSeconds ?? config.accessTokenTtlSeconds;
    const accessToken = await new SignJWT({ sid: sessionId, did: deviceId })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(config.jwtIssuer)
      .setAudience(config.jwtAudience)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .sign(key);
    return { accessToken, accessTokenExpiresIn: ttl };
  }

  /** Returns verified claims or throws. Algorithm, issuer and audience are pinned. */
  async function verifyAccessToken(token) {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [ALGORITHM],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      clockTolerance: 5,
      requiredClaims: ['sub', 'sid', 'did', 'exp', 'iat'],
    });
    return { userId: payload.sub, sessionId: payload.sid, deviceId: payload.did };
  }

  /**
   * A new refresh token for `sessionId`. The secret is generated here, or is the one the client
   * proposed for this rotation (so the client knows its next token even if the response never
   * arrives; see authService.refresh).
   */
  function createRefreshToken(sessionId, { secret = generateToken(32) } = {}) {
    return {
      refreshToken: `${sessionId}.${secret}`,
      refreshTokenHash: sha256(secret),
      expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
    };
  }

  /** Splits a refresh token into its session id and the hash of its secret, or returns null. */
  function parseRefreshToken(refreshToken) {
    const match = REFRESH_TOKEN_PATTERN.exec(refreshToken);
    if (!match) return null;
    return { sessionId: match[1], refreshTokenHash: sha256(match[2]) };
  }

  return { signAccessToken, verifyAccessToken, createRefreshToken, parseRefreshToken };
}
