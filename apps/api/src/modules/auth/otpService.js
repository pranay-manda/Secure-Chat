import { ERROR_CODE, OTP_CHANNEL, OTP_LENGTH } from '@secure-chat/shared/constants';

import { generateNumericCode, hmacSha256, safeEqualHex } from '../../lib/crypto.js';
import { HttpError } from '../../middleware/errors.js';

/**
 * OTPs live only in Redis, only as HMAC hashes, and only until they expire, are used,
 * or run out of attempts. Redis keys use an HMAC of the identifier (phone number or email),
 * never the identifier itself. Generation, storage and verification are shared by all
 * channels; only delivery differs.
 *
 *   otp:{identityKey}     hash { codeHash, attempts }  TTL = OTP_TTL_SECONDS
 *   otp:cd:{identityKey}  "1"                          TTL = OTP_RESEND_COOLDOWN_SECONDS
 *
 * An identity is `{ channel: 'email' | 'phone', value }` with `value` already normalised
 * (lower-case email, E.164 phone number).
 *
 * @param {{
 *   redis: import('ioredis').Redis,
 *   delivery: ReturnType<typeof import('./otpDelivery.js').createOtpDelivery>,
 *   config: { hmacSecret: string, ttlSeconds: number, maxAttempts: number, resendCooldownSeconds: number },
 *   logger: import('pino').Logger,
 * }} deps
 */
export function createOtpService({ redis, delivery, config, logger }) {
  // `phone:` prefix keeps keys identical to Phase 1, so codes in flight survive a deploy.
  // `purpose` separates codes for other uses (e.g. adding an email to an account) from sign-in
  // codes: one can never be used as the other. Sign-in keys are unchanged.
  const identityKey = ({ channel, value, purpose }) =>
    hmacSha256(config.hmacSecret, `${purpose ? `${purpose}:` : ''}${channel}:${value}`);
  const codeHash = (key, otp) => hmacSha256(config.hmacSecret, `otp:${key}:${otp}`);
  const otpKey = (key) => `otp:${key}`;
  const cooldownKey = (key) => `otp:cd:${key}`;

  function deliver({ channel, value }, otp) {
    return channel === OTP_CHANNEL.EMAIL
      ? delivery.sendEmailOTP(value, otp)
      : delivery.sendPhoneOTP(value, otp);
  }

  async function requestOtp(identity) {
    if (!delivery.isEnabled(identity.channel)) {
      throw new HttpError(
        503,
        ERROR_CODE.OTP_CHANNEL_UNAVAILABLE,
        identity.channel === OTP_CHANNEL.PHONE
          ? 'Phone sign-in is not available yet, use email'
          : 'Email sign-in is not available',
      );
    }

    const key = identityKey(identity);

    // One OTP per cooldown window per identifier (atomic SET NX).
    const acquired = await redis.set(
      cooldownKey(key),
      '1',
      'EX',
      config.resendCooldownSeconds,
      'NX',
    );
    if (acquired !== 'OK') {
      const ttl = await redis.ttl(cooldownKey(key));
      throw new HttpError(
        429,
        ERROR_CODE.OTP_COOLDOWN,
        'Please wait before requesting a new code',
        {
          retryAfterSeconds: ttl > 0 ? ttl : config.resendCooldownSeconds,
        },
      );
    }

    const otp = generateNumericCode(OTP_LENGTH);
    // A new OTP replaces any previous one and resets the attempt counter.
    await redis
      .multi()
      .del(otpKey(key))
      .hset(otpKey(key), { codeHash: codeHash(key, otp), attempts: 0 })
      .expire(otpKey(key), config.ttlSeconds)
      .exec();

    try {
      await deliver(identity, otp);
    } catch (err) {
      await redis.del(otpKey(key), cooldownKey(key));
      logger.error({ err, channel: identity.channel }, 'OTP delivery failed');
      throw new HttpError(
        502,
        ERROR_CODE.OTP_DELIVERY_FAILED,
        'Could not send the code, try again',
      );
    }

    return {
      expiresInSeconds: config.ttlSeconds,
      resendAfterSeconds: config.resendCooldownSeconds,
    };
  }

  /** Resolves if the OTP is correct (and consumes it); throws HttpError otherwise. */
  async function verifyOtp(identity, otp) {
    const key = identityKey(identity);
    const redisKey = otpKey(key);

    // Count the attempt and read the stored hash in one transaction.
    const [[, attempts], [, storedHash], [, pttl]] = await redis
      .multi()
      .hincrby(redisKey, 'attempts', 1)
      .hget(redisKey, 'codeHash')
      .pttl(redisKey)
      .exec();

    const invalid = () =>
      new HttpError(400, ERROR_CODE.OTP_INVALID, 'The code is incorrect or has expired');

    if (!storedHash || pttl < 0) {
      // No live OTP: HINCRBY may have just created a stray key, so remove it.
      await redis.del(redisKey);
      throw invalid();
    }

    const exhausted = () =>
      new HttpError(
        429,
        ERROR_CODE.OTP_ATTEMPTS_EXCEEDED,
        'Too many incorrect attempts, request a new code',
      );

    if (attempts > config.maxAttempts) {
      await redis.del(redisKey);
      throw exhausted();
    }

    if (!safeEqualHex(codeHash(key, otp), storedHash)) {
      if (attempts >= config.maxAttempts) {
        await redis.del(redisKey);
        throw exhausted();
      }
      const error = invalid();
      error.details = { attemptsRemaining: config.maxAttempts - attempts };
      throw error;
    }

    // Single use: only the request that actually deletes the key wins a concurrent race.
    const deleted = await redis.del(redisKey);
    if (deleted !== 1) throw invalid();
  }

  return { requestOtp, verifyOtp, identityKey };
}
