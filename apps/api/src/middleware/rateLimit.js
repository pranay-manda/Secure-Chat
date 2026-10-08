import { ERROR_CODE } from '@secure-chat/shared/constants';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

import { HttpError } from './errors.js';

/** Limits per abuse vector. Identifier keys are HMACs, never raw numbers or emails. */
export const RATE_LIMITS = Object.freeze({
  otpRequestPerIdentifier: { points: 5, duration: 60 * 60 },
  otpRequestPerIp: { points: 20, duration: 60 * 60 },
  otpVerifyPerIdentifier: { points: 15, duration: 60 * 60 },
  otpVerifyPerIp: { points: 50, duration: 15 * 60 },
  refreshPerIp: { points: 60, duration: 15 * 60 },
  authenticatedPerUser: { points: 120, duration: 60 },
  /** Bundle fetches consume one-time pre-keys: limit draining another user's pool. */
  bundleFetchPerUser: { points: 30, duration: 60 },
  messageSendPerUser: { points: 60, duration: 60 },
});

/**
 * @param {{ redis?: import('ioredis').Redis, inMemory?: boolean }} options
 *   inMemory is for tests only; production limits must be shared across API instances.
 */
export function createRateLimiters({ redis, inMemory = false }) {
  const limiters = Object.fromEntries(
    Object.entries(RATE_LIMITS).map(([name, opts]) => [
      name,
      inMemory
        ? new RateLimiterMemory({ keyPrefix: `rl:${name}`, ...opts })
        : new RateLimiterRedis({
            storeClient: redis,
            keyPrefix: `rl:${name}`,
            rejectIfRedisNotReady: true,
            ...opts,
          }),
    ]),
  );

  /** Consumes one point or throws 429 (limit hit) / 503 (limiter store unavailable). */
  async function consume(name, key) {
    try {
      await limiters[name].consume(key);
    } catch (result) {
      if (result instanceof RateLimiterRes) {
        throw new HttpError(429, ERROR_CODE.RATE_LIMITED, 'Too many requests, try again later', {
          retryAfterSeconds: Math.max(1, Math.ceil(result.msBeforeNext / 1000)),
        });
      }
      // Fail closed: without a working limiter, auth endpoints must not run unthrottled.
      throw new HttpError(503, ERROR_CODE.SERVICE_UNAVAILABLE, 'Service temporarily unavailable');
    }
  }

  /** Express middleware limiting by client IP (honours TRUST_PROXY_HOPS). */
  function byIp(name) {
    return async (req, res, next) => {
      await consume(name, req.ip);
      next();
    };
  }

  /** Express middleware limiting by authenticated user; place after `authenticate`. */
  function byUser(name) {
    return async (req, res, next) => {
      await consume(name, req.auth.userId);
      next();
    };
  }

  return { consume, byIp, byUser };
}
