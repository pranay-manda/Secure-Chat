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

  const SMTP_ENV = {
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '587',
    SMTP_USER: 'otp@example.com',
    SMTP_PASS: 'abcdefghijklmnop',
  };

  it('requires SMTP host, port, user and password when EMAIL_PROVIDER=smtp (the default)', () => {
    const smtp = { ...TEST_ENV, EMAIL_PROVIDER: undefined };
    for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) {
      expect(() => loadEnv(smtp)).toThrow(new RegExp(`${key}: required when EMAIL_PROVIDER=smtp`));
      // Each one is required on its own; an empty value counts as missing.
      expect(() => loadEnv({ ...smtp, ...SMTP_ENV, [key]: '' })).toThrow(new RegExp(key));
    }

    const config = loadEnv({ ...smtp, ...SMTP_ENV });
    expect(config.email).toMatchObject({
      provider: 'smtp',
      smtp: {
        host: 'smtp.gmail.com',
        port: 587,
        user: 'otp@example.com',
        pass: 'abcdefghijklmnop',
        from: 'otp@example.com', // SMTP_FROM defaults to SMTP_USER
      },
      otpTtlSeconds: 300,
    });
  });

  it('uses SMTP_FROM as the sender when set', () => {
    const config = loadEnv({
      ...TEST_ENV,
      EMAIL_PROVIDER: 'smtp',
      ...SMTP_ENV,
      SMTP_FROM: 'CipherChat <no-reply@example.com>',
    });
    expect(config.email.smtp.from).toBe('CipherChat <no-reply@example.com>');
  });

  it('validates SMTP settings without echoing the password', () => {
    const pass = 'super-secret-app-password';
    try {
      loadEnv({
        ...TEST_ENV,
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtps://smtp.gmail.com',
        SMTP_PORT: '70000',
        SMTP_USER: 'otp-user', // not an email address, and no SMTP_FROM
        SMTP_PASS: pass,
      });
      expect.unreachable();
    } catch (err) {
      expect(err.message).toMatch(/SMTP_HOST: must be a host name/);
      expect(err.message).toMatch(/SMTP_PORT/);
      expect(err.message).toMatch(/SMTP_FROM: required when SMTP_USER is not an email address/);
      expect(err.message).not.toContain(pass);
    }
    expect(() =>
      loadEnv({ ...TEST_ENV, EMAIL_PROVIDER: 'smtp', ...SMTP_ENV, SMTP_FROM: 'not an address' }),
    ).toThrow(/SMTP_FROM: must be an email address/);
  });

  it('refuses the old resend provider with a clear message', () => {
    expect(() => loadEnv({ ...TEST_ENV, EMAIL_PROVIDER: 'resend' })).toThrow(
      /EMAIL_PROVIDER: must be smtp, console or none \(resend was replaced by smtp/,
    );
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
      /EMAIL_PROVIDER: console provider is for development only; use smtp/,
    );

    const config = loadEnv({ ...production, EMAIL_PROVIDER: 'smtp', ...SMTP_ENV });
    expect(config.sms.provider).toBe('none');
    expect(config.email.provider).toBe('smtp');
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
