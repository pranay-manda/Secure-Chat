import { ERROR_CODE } from '@secure-chat/shared/constants';
import { objectIdSchema } from '@secure-chat/shared/validation';

import { Session } from '../models/Session.js';
import { HttpError } from './errors.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

const unauthenticated = () =>
  new HttpError(401, ERROR_CODE.UNAUTHENTICATED, 'Authentication required');

/**
 * Requires a valid access token AND a live session. The session lookup is what makes
 * logout and device revocation take effect immediately, before the JWT expires.
 * On success sets `req.auth = { userId, sessionId, deviceId }`.
 *
 * @param {{ tokenService: ReturnType<typeof import('../modules/auth/tokenService.js').createTokenService> }} deps
 */
export function createAuthenticate({ tokenService }) {
  return async function authenticate(req, res, next) {
    res.set('WWW-Authenticate', 'Bearer');

    const match = BEARER.exec(req.headers.authorization ?? '');
    if (!match) throw unauthenticated();

    let claims;
    try {
      claims = await tokenService.verifyAccessToken(match[1]);
    } catch {
      throw unauthenticated();
    }
    if (
      !objectIdSchema.safeParse(claims.userId).success ||
      !objectIdSchema.safeParse(claims.sessionId).success
    ) {
      throw unauthenticated();
    }

    const session = await Session.findOne({
      _id: claims.sessionId,
      userId: claims.userId,
      revokedAt: null,
    })
      .select('deviceId expiresAt')
      .lean();
    if (!session || session.deviceId !== claims.deviceId || session.expiresAt <= new Date()) {
      throw unauthenticated();
    }

    res.removeHeader('WWW-Authenticate');
    req.auth = claims;
    next();
  };
}
