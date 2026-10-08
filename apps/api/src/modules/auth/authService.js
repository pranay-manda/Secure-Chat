import { ERROR_CODE, OTP_CHANNEL } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { safeEqualHex } from '../../lib/crypto.js';
import { HttpError } from '../../middleware/errors.js';
import { Device } from '../../models/Device.js';
import { Session, USED_TOKEN_HISTORY } from '../../models/Session.js';
import { User } from '../../models/User.js';

/** User field that identifies the account for each sign-in channel. */
const USER_FIELD = Object.freeze({
  [OTP_CHANNEL.EMAIL]: 'email',
  [OTP_CHANNEL.PHONE]: 'phoneNumber',
});

const invalidRefresh = () =>
  new HttpError(401, ERROR_CODE.REFRESH_TOKEN_INVALID, 'Session is invalid, please sign in again');

/**
 * @param {{
 *   otpService: ReturnType<typeof import('./otpService.js').createOtpService>,
 *   tokenService: ReturnType<typeof import('./tokenService.js').createTokenService>,
 *   logger: import('pino').Logger,
 * }} deps
 */
export function createAuthService({ otpService, tokenService, keyService, logger }) {
  async function findOrCreateUser({ channel, value }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await User.findOneAndUpdate(
          { [USER_FIELD[channel]]: value },
          { $setOnInsert: { displayName: '' } },
          { upsert: true, new: true, includeResultMetadata: true },
        );
        return { user: result.value, isNew: !result.lastErrorObject?.updatedExisting };
      } catch (err) {
        // Two concurrent first logins for one identifier: the loser retries and finds the user.
        if (err?.code !== 11000 || attempt === 1) throw err;
      }
    }
    throw new Error('unreachable');
  }

  async function revokeSession(sessionId, reason) {
    await Session.updateOne(
      { _id: sessionId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
  }

  /**
   * Verifies the OTP, then (in one transaction) registers the device, revokes the user's
   * other devices and sessions (single active device), and opens a new session.
   */
  async function loginWithOtp({ identity, otp, device }) {
    await otpService.verifyOtp(identity, otp);

    const { user, isNew } = await findOrCreateUser(identity);
    const userId = user._id;
    let issued;

    await mongoose.connection.transaction(async (session) => {
      const now = new Date();

      const existing = await Device.findOne({ userId, deviceId: device.deviceId })
        .select('revokedAt')
        .session(session)
        .lean();
      if (existing?.revokedAt) {
        throw new HttpError(
          403,
          ERROR_CODE.DEVICE_REVOKED,
          'This device was signed out. Reinstall or reset the app to sign in again',
        );
      }

      // v1 policy: one active device per user. Signing in here signs out everywhere else.
      await Device.updateMany(
        { userId, deviceId: mongoose.trusted({ $ne: device.deviceId }), revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'replaced_by_new_login', pushToken: null } },
        { session },
      );
      await Session.updateMany(
        { userId, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'new_login' } },
        { session },
      );

      await Device.updateOne(
        { userId, deviceId: device.deviceId },
        {
          $set: {
            platform: device.platform,
            name: device.name ?? '',
            appVersion: device.appVersion ?? '',
            osVersion: device.osVersion ?? '',
            lastActiveAt: now,
          },
        },
        { upsert: true, runValidators: true, session },
      );
      // A login starts from wiped local state (logout deletes local keys), so any public keys
      // registered for this install are stale; the app registers fresh ones after login.
      await keyService.resetDeviceKeys({ userId, deviceId: device.deviceId }, { session });

      const sessionId = new mongoose.Types.ObjectId();
      const refresh = tokenService.createRefreshToken(sessionId.toString());
      await Session.create(
        [
          {
            _id: sessionId,
            userId,
            deviceId: device.deviceId,
            refreshTokenHash: refresh.refreshTokenHash,
            expiresAt: refresh.expiresAt,
          },
        ],
        { session },
      );
      issued = { sessionId: sessionId.toString(), refresh };
    });

    const access = await tokenService.signAccessToken({
      userId: userId.toString(),
      sessionId: issued.sessionId,
      deviceId: device.deviceId,
    });

    logger.info({ userId: userId.toString(), isNewUser: isNew }, 'User signed in');

    return {
      user: { ...user.toJSON(), isNew },
      device: { deviceId: device.deviceId },
      tokens: {
        ...access,
        refreshToken: issued.refresh.refreshToken,
        refreshTokenExpiresAt: issued.refresh.expiresAt.toISOString(),
      },
    };
  }

  /**
   * Rotates a refresh token. Each token works exactly once; presenting an already-rotated
   * token is treated as theft and revokes the whole session.
   */
  async function refresh({ refreshToken, deviceId }) {
    const parsed = tokenService.parseRefreshToken(refreshToken);
    if (!parsed) throw invalidRefresh();

    const session = await Session.findById(parsed.sessionId).lean();
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw invalidRefresh();

    if (!safeEqualHex(parsed.refreshTokenHash, session.refreshTokenHash)) {
      if (session.usedRefreshTokenHashes.includes(parsed.refreshTokenHash)) {
        await revokeSession(session._id, 'refresh_token_reuse');
        logger.warn(
          { userId: session.userId.toString(), sessionId: session._id.toString() },
          'Refresh token reuse detected; session revoked',
        );
        throw new HttpError(
          401,
          ERROR_CODE.REFRESH_TOKEN_REUSED,
          'Session ended for your security, please sign in again',
        );
      }
      throw invalidRefresh();
    }

    // Token is valid but presented for another device: treat as stolen.
    if (session.deviceId !== deviceId) {
      await revokeSession(session._id, 'device_mismatch');
      logger.warn(
        { userId: session.userId.toString(), sessionId: session._id.toString() },
        'Refresh token presented by a different device; session revoked',
      );
      throw invalidRefresh();
    }

    const device = await Device.findOne({ userId: session.userId, deviceId })
      .select('revokedAt')
      .lean();
    if (!device || device.revokedAt) {
      await revokeSession(session._id, 'device_revoked');
      throw new HttpError(401, ERROR_CODE.DEVICE_REVOKED, 'This device was signed out');
    }

    const now = new Date();
    const next = tokenService.createRefreshToken(session._id.toString());
    // Compare-and-swap on the current hash so two concurrent refreshes cannot both succeed.
    const rotated = await Session.findOneAndUpdate(
      { _id: session._id, refreshTokenHash: parsed.refreshTokenHash, revokedAt: null },
      {
        $set: {
          refreshTokenHash: next.refreshTokenHash,
          expiresAt: next.expiresAt,
          lastUsedAt: now,
        },
        $push: {
          usedRefreshTokenHashes: { $each: [parsed.refreshTokenHash], $slice: -USED_TOKEN_HISTORY },
        },
      },
      { new: true, projection: { _id: 1 } },
    );
    if (!rotated) {
      await revokeSession(session._id, 'refresh_token_reuse');
      throw new HttpError(
        401,
        ERROR_CODE.REFRESH_TOKEN_REUSED,
        'Session ended for your security, please sign in again',
      );
    }

    await Device.updateOne({ _id: device._id }, { $set: { lastActiveAt: now } });

    const access = await tokenService.signAccessToken({
      userId: session.userId.toString(),
      sessionId: session._id.toString(),
      deviceId,
    });
    return {
      tokens: {
        ...access,
        refreshToken: next.refreshToken,
        refreshTokenExpiresAt: next.expiresAt.toISOString(),
      },
    };
  }

  /** Ends the session and stops push notifications to this device. */
  async function logout({ sessionId, userId, deviceId }) {
    await revokeSession(sessionId, 'logout');
    await Device.updateOne({ userId, deviceId }, { $set: { pushToken: null } });
  }

  return { loginWithOtp, refresh, logout };
}
