import { ERROR_CODE, OTP_CHANNEL } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { safeEqualHex, sha256 } from '../../lib/crypto.js';
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
export function createAuthService({
  otpService,
  tokenService,
  keyService,
  callService,
  presenceService,
  logger,
}) {
  /**
   * Email sign-in: the account is the email's. A new account needs a phone number (saved
   * unverified); an existing one without a number gets this one; a different number than the
   * account's is refused. Runs only after the code was verified, so nothing here reveals
   * whether an email or number is registered to someone who does not own the mailbox.
   */
  async function findOrCreateEmailUser(email, profilePhone) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const user = await User.findOne({ email });
      if (user) {
        if (!profilePhone || user.phoneNumber === profilePhone) return { user, isNew: false };
        if (user.phoneNumber) {
          throw new HttpError(
            409,
            ERROR_CODE.PHONE_NUMBER_MISMATCH,
            'This email is registered with a different phone number',
          );
        }
        await attachPhone(user._id, profilePhone);
        return { user: await User.findById(user._id), isNew: false };
      }
      if (!profilePhone) {
        throw new HttpError(
          400,
          ERROR_CODE.PHONE_NUMBER_REQUIRED,
          'A phone number is required to create an account',
        );
      }
      try {
        const created = await User.create({ email, phoneNumber: profilePhone, displayName: '' });
        return { user: created, isNew: true };
      } catch (err) {
        if (err?.code !== 11000) throw err;
        if (err.keyPattern?.phoneNumber) throw phoneTaken();
        // Two first sign-ins for one email at once: the loser finds the new user next round.
      }
    }
    throw new Error('unreachable');
  }

  const phoneTaken = () =>
    new HttpError(
      409,
      ERROR_CODE.PHONE_NUMBER_TAKEN,
      'This phone number is already used by another account',
    );

  /** Sets the phone number of an account that has none (never replaces one). */
  async function attachPhone(userId, phoneNumber) {
    try {
      const result = await User.collection.updateOne(
        { _id: userId, phoneNumber: { $exists: false } },
        { $set: { phoneNumber, updatedAt: new Date() } },
      );
      if (result.matchedCount === 0) {
        throw new HttpError(409, ERROR_CODE.ALREADY_SET, 'This account already has a phone number');
      }
    } catch (err) {
      if (err?.code === 11000) throw phoneTaken();
      throw err;
    }
  }

  async function findOrCreateUser({ channel, value }, profilePhone) {
    if (channel === OTP_CHANNEL.EMAIL) return findOrCreateEmailUser(value, profilePhone);
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
  async function loginWithOtp({ identity, otp, device, profilePhone }) {
    await otpService.verifyOtp(identity, otp);

    const { user, isNew } = await findOrCreateUser(identity, profilePhone);
    if (identity.channel === OTP_CHANNEL.PHONE && !user.phoneVerifiedAt) {
      // The SMS code proved this number.
      const verifiedAt = new Date();
      await User.updateOne(
        { _id: user._id, phoneVerifiedAt: null },
        { $set: { phoneVerifiedAt: verifiedAt } },
      );
      user.phoneVerifiedAt = verifiedAt;
    }
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

    // Any other device was just signed out: a call on it cannot continue, and its online
    // status no longer stands (the new device reports its own).
    await callService?.endCallsForUser(userId, 'signed_in_elsewhere');
    await presenceService?.clear(userId);
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

  /** A rotated refresh token was presented outside a recognised retry: theft. Always throws. */
  async function revokeForReuse(session) {
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

  /** The token is bound to its device, and a revoked device gets nothing. Returns the device. */
  async function checkDevice(session, deviceId) {
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
    return device;
  }

  /**
   * Whether a request is a repeat of the rotation that produced the session's current token:
   * the presented token is the one that rotation consumed (the immediate predecessor), and the
   * proposed next secret IS the current token's secret. Knowing that secret is proof of holding
   * the current token, so this reveals nothing to someone who only has an old token.
   */
  const isRetryOfLastRotation = (session, presentedHash, proposedHash) =>
    proposedHash !== null &&
    safeEqualHex(presentedHash, session.usedRefreshTokenHashes.at(-1)) &&
    safeEqualHex(proposedHash, session.refreshTokenHash);

  async function issueTokens(session, deviceId, refresh, device, now) {
    await Device.updateOne({ _id: device._id }, { $set: { lastActiveAt: now } });
    const access = await tokenService.signAccessToken({
      userId: session.userId.toString(),
      sessionId: session._id.toString(),
      deviceId,
    });
    return {
      tokens: {
        ...access,
        refreshToken: refresh.refreshToken,
        refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
      },
    };
  }

  /** Answers a repeated rotation (its first answer was lost): no new rotation, a new access token. */
  async function answerRetry(session, deviceId, nextRefreshSecret) {
    const device = await checkDevice(session, deviceId);
    const now = new Date();
    await Session.updateOne({ _id: session._id, revokedAt: null }, { $set: { lastUsedAt: now } });
    logger.info(
      { userId: session.userId.toString(), sessionId: session._id.toString() },
      'Refresh retried after an interrupted response',
    );
    const current = {
      refreshToken: `${session._id.toString()}.${nextRefreshSecret}`,
      expiresAt: session.expiresAt,
    };
    return issueTokens(session, deviceId, current, device, now);
  }

  /**
   * Rotates a refresh token. Each token works exactly once; presenting an already-rotated
   * token is treated as theft and revokes the whole session.
   *
   * Interrupted rotations: the app proposes the next token's secret (`nextRefreshSecret`, 32
   * random bytes) and saves it before sending. If the answer never arrives (app reloaded or
   * killed, timeout, dropped connection), or two copies of the request race, it sends exactly
   * the same request again. That repeat is answered, without rotating again, only when
   * isRetryOfLastRotation holds and the device checks pass. Any other use of a rotated token
   * (no or another proposed secret, an older token, another device) is still reuse.
   */
  async function refresh({ refreshToken, deviceId, nextRefreshSecret }) {
    const parsed = tokenService.parseRefreshToken(refreshToken);
    if (!parsed) throw invalidRefresh();

    const session = await Session.findById(parsed.sessionId).lean();
    if (!session || session.revokedAt || session.expiresAt <= new Date()) throw invalidRefresh();
    const proposedHash = nextRefreshSecret ? sha256(nextRefreshSecret) : null;

    if (!safeEqualHex(parsed.refreshTokenHash, session.refreshTokenHash)) {
      if (isRetryOfLastRotation(session, parsed.refreshTokenHash, proposedHash)) {
        return answerRetry(session, deviceId, nextRefreshSecret);
      }
      if (session.usedRefreshTokenHashes.includes(parsed.refreshTokenHash)) {
        await revokeForReuse(session);
      }
      throw invalidRefresh();
    }

    const device = await checkDevice(session, deviceId);

    // The next token must be new: not the current secret, not one used before.
    if (
      proposedHash &&
      (safeEqualHex(proposedHash, session.refreshTokenHash) ||
        session.usedRefreshTokenHashes.some((used) => safeEqualHex(proposedHash, used)))
    ) {
      throw new HttpError(400, ERROR_CODE.VALIDATION_ERROR, 'The next refresh token must be new');
    }

    const now = new Date();
    const next = tokenService.createRefreshToken(
      session._id.toString(),
      nextRefreshSecret ? { secret: nextRefreshSecret } : {},
    );
    // Compare-and-swap on the current hash so two concurrent refreshes cannot both rotate.
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
      // Another request rotated this token first. An identical copy of this request (same
      // proposed secret) is the same rotation; anything else is reuse.
      const latest = await Session.findById(session._id).lean();
      if (!latest || latest.revokedAt) throw invalidRefresh();
      if (isRetryOfLastRotation(latest, parsed.refreshTokenHash, proposedHash)) {
        return answerRetry(latest, deviceId, nextRefreshSecret);
      }
      await revokeForReuse(session);
    }

    return issueTokens(session, deviceId, next, device, now);
  }

  /** Ends the session and stops push notifications to this device. */
  async function logout({ sessionId, userId, deviceId }) {
    await revokeSession(sessionId, 'logout');
    await Device.updateOne({ userId, deviceId }, { $set: { pushToken: null } });
    await callService?.endCallsForUser(userId, 'signed_out', { deviceId });
    await presenceService?.clear(userId, { deviceId });
  }

  return { loginWithOtp, refresh, logout, attachPhone, phoneTaken };
}
