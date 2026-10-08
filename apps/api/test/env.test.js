import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from '../src/config/env.js';
import { TEST_ENV } from './helpers.js';

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadEnv(TEST_ENV);

    expect(config.nodeEnv).toBe('test');
    expect(config.port).toBe(4000);
    expect(config.corsOrigins).toEqual([]);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('parses comma-separated CORS origins', () => {
    const config = loadEnv({ ...TEST_ENV, CORS_ORIGINS: 'https://a.example, https://b.example' });
    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('fails fast when required variables are missing', () => {
    expect(() => loadEnv({ NODE_ENV: 'test' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ NODE_ENV: 'test' })).toThrow(/MONGODB_URI/);
  });

  it('rejects invalid values', () => {
    expect(() => loadEnv({ ...TEST_ENV, PORT: '99999' })).toThrow(/PORT/);
    expect(() => loadEnv({ ...TEST_ENV, REDIS_URL: 'http://x' })).toThrow(/REDIS_URL/);
  });

  it('rejects connection strings with unfilled placeholders', () => {
    expect(() =>
      loadEnv({ ...TEST_ENV, MONGODB_URI: 'mongodb+srv://user:<db_password>@cluster.example/db' }),
    ).toThrow(/MONGODB_URI: contains an unfilled <placeholder>/);
  });

  it('never includes variable values in the error message', () => {
    const secret = 'mongodb-super-secret-value';
    try {
      loadEnv({ ...TEST_ENV, MONGODB_URI: secret });
      expect.unreachable();
    } catch (err) {
      expect(err.message).toMatch(/MONGODB_URI/);
      expect(err.message).not.toContain(secret);
    }
  });

  it('requires datastore credentials in production', () => {
    expect(() => loadEnv({ ...TEST_ENV, NODE_ENV: 'production' })).toThrow(
      /MONGODB_URI: must include credentials/,
    );
  });

  it('refuses the console SMS provider in production', () => {
    const production = {
      ...TEST_ENV,
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb+srv://api:pw@cluster.example/securechat',
      REDIS_URL: 'rediss://:pw@redis.example:6380',
    };
    expect(() => loadEnv(production)).toThrow(/SMS_PROVIDER: console provider is for development/);
    expect(() => loadEnv(production)).not.toThrow(/MONGODB_URI|REDIS_URL/);
  });

  it('requires the Resend key and sender when EMAIL_PROVIDER=resend (the default)', () => {
    const resend = { ...TEST_ENV, EMAIL_PROVIDER: undefined };
    expect(() => loadEnv(resend)).toThrow(/RESEND_API_KEY: required when EMAIL_PROVIDER=resend/);
    expect(() => loadEnv(resend)).toThrow(/RESEND_FROM_EMAIL: required/);

    const config = loadEnv({
      ...resend,
      RESEND_API_KEY: 're_abc123_DEF',
      RESEND_FROM_EMAIL: 'Secure Chat <no-reply@example.com>',
    });
    expect(config.email).toMatchObject({
      provider: 'resend',
      from: 'Secure Chat <no-reply@example.com>',
      otpTtlSeconds: 300,
    });
  });

  it('validates Resend settings without echoing the key', () => {
    const key = 'sk_live_not_a_resend_key';
    try {
      loadEnv({ ...TEST_ENV, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: key });
      expect.unreachable();
    } catch (err) {
      expect(err.message).toMatch(/RESEND_API_KEY: must be a Resend API key/);
      expect(err.message).not.toContain(key);
    }
    expect(() =>
      loadEnv({
        ...TEST_ENV,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_abc',
        RESEND_FROM_EMAIL: 'not an address',
      }),
    ).toThrow(/RESEND_FROM_EMAIL/);
  });

  it('allows production without SMS (phone sign-in off) but not with console email', () => {
    const production = {
      ...TEST_ENV,
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb+srv://api:pw@cluster.example/securechat',
      REDIS_URL: 'rediss://:pw@redis.example:6380',
      SMS_PROVIDER: 'none',
    };
    expect(() => loadEnv(production)).toThrow(
      /EMAIL_PROVIDER: console provider is for development/,
    );

    const config = loadEnv({
      ...production,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_abc123',
      RESEND_FROM_EMAIL: 'no-reply@example.com',
    });
    expect(config.sms.provider).toBe('none');
  });

  it('requires at least one OTP channel', () => {
    expect(() => loadEnv({ ...TEST_ENV, EMAIL_PROVIDER: 'none', SMS_PROVIDER: 'none' })).toThrow(
      /at least one of EMAIL_PROVIDER or SMS_PROVIDER/,
    );
  });

  it('requires strong, distinct auth secrets', () => {
    expect(() => loadEnv({ ...TEST_ENV, JWT_ACCESS_SECRET: undefined })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
    expect(() => loadEnv({ ...TEST_ENV, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /JWT_ACCESS_SECRET: must be at least 32 characters/,
    );
    expect(() =>
      loadEnv({ ...TEST_ENV, OTP_HMAC_SECRET: 'change-me-change-me-change-me-change-me' }),
    ).toThrow(/OTP_HMAC_SECRET: must be replaced/);
    expect(() => loadEnv({ ...TEST_ENV, OTP_HMAC_SECRET: TEST_ENV.JWT_ACCESS_SECRET })).toThrow(
      /OTP_HMAC_SECRET: must differ/,
    );
  });

  it('exposes auth and OTP settings with safe defaults', () => {
    const config = loadEnv(TEST_ENV);
    expect(config.auth.accessTokenTtlSeconds).toBe(900);
    expect(config.auth.refreshTokenTtlDays).toBe(30);
    expect(config.otp).toMatchObject({
      ttlSeconds: 300,
      maxAttempts: 5,
      resendCooldownSeconds: 60,
    });
  });
});
