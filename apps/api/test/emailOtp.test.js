import RedisMock from 'ioredis-mock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User } from '../src/models/User.js';
import { createEmailProvider } from '../src/services/email/index.js';
import {
  bearer,
  buildTestApp,
  clearCooldowns,
  connectTestDb,
  disconnectTestDb,
  newDevice,
  resetTestDb,
} from './helpers.js';

const EMAIL = 'alice@example.com';
const RESEND_KEY = 're_testkey_0123456789';

let ctx;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
});

const requestOtp = (email = EMAIL, app = ctx.app) =>
  request(app).post('/auth/otp/request').send({ email });

const verifyOtp = (otp, { email = EMAIL, device = newDevice(), app = ctx.app } = {}) =>
  request(app).post('/auth/otp/verify').send({ email, otp, device });

const wrongCode = (otp) => (otp === '000000' ? '111111' : '000000');

const otpKeys = async (redis = ctx.redis) =>
  (await redis.keys('otp:*')).filter((key) => !key.startsWith('otp:cd:'));

/** A real Resend provider whose HTTP calls go to a stub instead of the network. */
function resendProvider(fetchImpl) {
  return createEmailProvider(
    {
      provider: 'resend',
      resendApiKey: RESEND_KEY,
      from: 'Secure Chat <otp@example.test>',
      otpTtlSeconds: 300,
    },
    { fetchImpl },
  );
}

const okResponse = () => ({ ok: true, status: 200, json: async () => ({ id: 'email-id' }) });

describe('POST /auth/otp/request (email)', () => {
  it('sends a 6-digit OTP by email without returning it', async () => {
    const res = await requestOtp();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });
    const otp = ctx.email.lastOtp(EMAIL);
    expect(otp).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body)).not.toContain(otp);
    expect(ctx.sms.sent).toHaveLength(0);
  });

  it('normalises the address (trim, lower-case) before sending', async () => {
    await requestOtp('  Alice@Example.COM ').expect(202);
    expect(ctx.email.sent[0].email).toBe(EMAIL);
  });

  it('rejects malformed emails and ambiguous or empty identifiers', async () => {
    for (const email of ['alice', 'alice@', '@example.com', 'a b@example.com', '', 42]) {
      const res = await requestOtp(email);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const both = await request(ctx.app)
      .post('/auth/otp/request')
      .send({ email: EMAIL, phoneNumber: '+919876543210' });
    expect(both.status).toBe(400);
    const neither = await request(ctx.app).post('/auth/otp/request').send({});
    expect(neither.status).toBe(400);
    const injection = await request(ctx.app)
      .post('/auth/otp/request')
      .send({ email: { $ne: null } });
    expect(injection.status).toBe(400);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('stores only an HMAC of the OTP in Redis, keyed without the email address', async () => {
    await requestOtp().expect(202);
    const otp = ctx.email.lastOtp(EMAIL);

    const keys = await ctx.redis.keys('*');
    expect(keys.some((key) => key.includes('alice') || key.includes('example'))).toBe(false);

    const [otpKey] = await otpKeys();
    expect(otpKey).toMatch(/^otp:[a-f\d]{64}$/);
    const stored = await ctx.redis.hgetall(otpKey);
    expect(Object.keys(stored).sort()).toEqual(['attempts', 'codeHash']);
    expect(stored.codeHash).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(otp);
  });

  it('expires the OTP and the resend cooldown through Redis TTLs', async () => {
    await requestOtp().expect(202);

    const [otpKey] = await otpKeys();
    const otpTtl = await ctx.redis.ttl(otpKey);
    expect(otpTtl).toBeGreaterThan(290);
    expect(otpTtl).toBeLessThanOrEqual(300);

    const [cooldownKey] = await ctx.redis.keys('otp:cd:*');
    const cooldownTtl = await ctx.redis.ttl(cooldownKey);
    expect(cooldownTtl).toBeGreaterThan(50);
    expect(cooldownTtl).toBeLessThanOrEqual(60);
  });

  it('enforces a resend cooldown with Retry-After', async () => {
    await requestOtp().expect(202);
    const res = await requestOtp('ALICE@example.com');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_COOLDOWN');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(ctx.email.sent).toHaveLength(1);
  });

  it('rate limits OTP requests per email address (case-insensitively)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await clearCooldowns(ctx.redis);
      await requestOtp(i % 2 ? EMAIL.toUpperCase() : EMAIL).expect(202);
    }
    await clearCooldowns(ctx.redis);
    const res = await requestOtp();

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(ctx.email.sent).toHaveLength(5);
  });

  it('rate limits OTP requests per IP across addresses', async () => {
    for (let i = 0; i < 20; i += 1) {
      await requestOtp(`user${i}@example.com`).expect(202);
    }
    const res = await requestOtp('another@example.com');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('answers identically for registered and unknown addresses (no enumeration)', async () => {
    await User.create({ email: 'known@example.com' });
    const usersBefore = await User.countDocuments();

    const known = await requestOtp('known@example.com');
    const unknown = await requestOtp('unknown@example.com');

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    expect(Object.keys(known.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
    // Requesting a code never creates or reveals an account.
    expect(await User.countDocuments()).toBe(usersBefore);
    expect(ctx.email.sent.map((entry) => entry.email)).toEqual([
      'known@example.com',
      'unknown@example.com',
    ]);
  });
});

describe('Resend delivery', () => {
  it('calls the Resend API with the OTP email', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    ctx = buildTestApp({ emailProvider: resendProvider(fetchImpl) });

    await requestOtp().expect(202);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      from: 'Secure Chat <otp@example.test>',
      to: [EMAIL],
      subject: 'Your Secure Chat verification code',
    });
    const otp = body.text.match(/Your verification code is: (\d{6})/)[1];
    expect(body.text).toContain('This code expires in 5 minutes.');
    expect(body.text).toContain('If you did not request this code, you can ignore this email.');
    expect(body.html).toContain(otp);

    // The emailed code is the one that signs in.
    await verifyOtp(otp).expect(200);
  });

  it('returns 502, clears the OTP and cooldown, and logs no secrets when Resend rejects', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ name: 'validation_error', message: `Invalid \`to\` field: ${EMAIL}` }),
    }));
    ctx = buildTestApp({ emailProvider: resendProvider(fetchImpl) });

    const res = await requestOtp();

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
    expect(await ctx.redis.keys('otp:*')).toEqual([]);

    const failure = ctx.lines.find((line) => line.msg === 'OTP delivery failed');
    expect(failure.err).toMatchObject({ status: 422, resendError: 'validation_error' });
    expect(failure.channel).toBe('email');
    const logs = JSON.stringify(ctx.lines);
    expect(logs).not.toContain(RESEND_KEY);
    expect(logs).not.toContain(EMAIL);

    // The user can retry straight away once Resend recovers.
    fetchImpl.mockImplementation(async () => okResponse());
    await requestOtp().expect(202);
  });

  it('returns 502 when Resend is unreachable or times out', async () => {
    for (const failure of [
      Object.assign(new Error(`connect ECONNREFUSED for ${EMAIL}`), { name: 'TypeError' }),
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    ]) {
      ctx = buildTestApp({
        emailProvider: resendProvider(async () => {
          throw failure;
        }),
      });
      await ctx.redis.flushall();

      const res = await requestOtp();

      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
      expect(JSON.stringify(ctx.lines)).not.toContain(EMAIL);
    }
  });
});

describe('Redis failure', () => {
  function brokenRedis() {
    const fail = () => Promise.reject(new Error('Redis connection lost'));
    const failingMulti = new Proxy(
      {},
      { get: (_target, prop) => (prop === 'exec' ? fail : () => failingMulti) },
    );
    return new Proxy(new RedisMock(), {
      get: (target, prop) => {
        if (prop === 'multi') return () => failingMulti;
        if (['set', 'get', 'del', 'ttl', 'hset', 'hgetall'].includes(prop)) return fail;
        return Reflect.get(target, prop);
      },
    });
  }

  it('fails the request without sending an email or leaking details', async () => {
    ctx = buildTestApp({ redis: brokenRedis() });

    const res = await requestOtp();

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toMatch(/Redis|at .*\.js/);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('never signs anyone in when the OTP store is unavailable', async () => {
    ctx = buildTestApp({ redis: brokenRedis() });

    const res = await verifyOtp('123456');

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.tokens).toBeUndefined();
    expect(await User.countDocuments()).toBe(0);
  });
});

describe('POST /auth/otp/verify (email)', () => {
  it('signs in with the correct OTP and creates an email-only user', async () => {
    await requestOtp().expect(202);
    const device = newDevice();

    const res = await verifyOtp(ctx.email.lastOtp(EMAIL), { device });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: EMAIL, isNew: true });
    expect(res.body.user.phoneNumber).toBeUndefined();
    expect(res.body.device.deviceId).toBe(device.deviceId);
    expect(res.body.tokens.accessToken.split('.')).toHaveLength(3);
    expect(res.body.tokens.refreshToken).toMatch(/^[a-f\d]{24}\.[A-Za-z0-9_-]{43}$/);
    // Same session behaviour as phone sign-in: the token works and the device is registered.
    const devices = await request(ctx.app)
      .get('/devices')
      .set(bearer(res.body.tokens.accessToken))
      .expect(200);
    expect(devices.body.devices.map((d) => d.deviceId)).toContain(device.deviceId);
  });

  it('finds the same user again regardless of email case (no duplicates)', async () => {
    await requestOtp().expect(202);
    const first = await verifyOtp(ctx.email.lastOtp(EMAIL)).expect(200);

    await clearCooldowns(ctx.redis);
    await requestOtp('ALICE@Example.com').expect(202);
    const second = await verifyOtp(ctx.email.lastOtp(EMAIL), { email: ' Alice@EXAMPLE.com' });

    expect(second.status).toBe(200);
    expect(second.body.user).toMatchObject({ id: first.body.user.id, isNew: false });
    expect(await User.countDocuments({ email: EMAIL })).toBe(1);
  });

  it('keeps separate email-only and phone-only users side by side', async () => {
    await requestOtp().expect(202);
    await verifyOtp(ctx.email.lastOtp(EMAIL)).expect(200);
    await requestOtp('bob@example.com').expect(202);
    await verifyOtp(ctx.email.lastOtp('bob@example.com'), { email: 'bob@example.com' }).expect(200);
    await request(ctx.app).post('/auth/otp/request').send({ phoneNumber: '+919876543210' });
    await request(ctx.app)
      .post('/auth/otp/verify')
      .send({
        phoneNumber: '+919876543210',
        otp: ctx.sms.lastOtp('+919876543210'),
        device: newDevice(),
      })
      .expect(200);

    expect(await User.countDocuments()).toBe(3);
  });

  it('rejects a wrong OTP and reports remaining attempts', async () => {
    await requestOtp().expect(202);

    const res = await verifyOtp(wrongCode(ctx.email.lastOtp(EMAIL)));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(res.body.error.details.attemptsRemaining).toBe(4);
  });

  it('rejects an expired OTP', async () => {
    await requestOtp().expect(202);
    const [otpKey] = await otpKeys();
    await ctx.redis.del(otpKey); // equivalent to TTL expiry

    const res = await verifyOtp(ctx.email.lastOtp(EMAIL));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(await ctx.redis.exists(otpKey)).toBe(0);
  });

  it('accepts an OTP only once', async () => {
    await requestOtp().expect(202);
    const otp = ctx.email.lastOtp(EMAIL);

    await verifyOtp(otp).expect(200);
    expect(await otpKeys()).toEqual([]);
    const replay = await verifyOtp(otp);

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('OTP_INVALID');
  });

  it('locks the OTP after 5 wrong attempts, even if the right code follows', async () => {
    await requestOtp().expect(202);
    const otp = ctx.email.lastOtp(EMAIL);

    for (let i = 0; i < 4; i += 1) {
      expect((await verifyOtp(wrongCode(otp))).body.error.code).toBe('OTP_INVALID');
    }
    const fifth = await verifyOtp(wrongCode(otp));
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');

    const correct = await verifyOtp(otp);
    expect(correct.status).toBe(400);
    expect(correct.body.error.code).toBe('OTP_INVALID');
  });

  it('rate limits verification attempts per email address', async () => {
    for (let i = 0; i < 15; i += 1) {
      const res = await verifyOtp('123456');
      expect(res.status).toBe(400);
    }
    const res = await verifyOtp('123456');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not accept a code issued for another address or for the phone channel', async () => {
    await requestOtp().expect(202);
    const otp = ctx.email.lastOtp(EMAIL);

    await verifyOtp(otp, { email: 'mallory@example.com' }).expect(400);
    const asPhone = await request(ctx.app)
      .post('/auth/otp/verify')
      .send({ phoneNumber: '+919876543210', otp, device: newDevice() });
    expect(asPhone.status).toBe(400);

    // The original code is still valid for its own address.
    await verifyOtp(otp).expect(200);
  });

  it('never logs OTPs or email addresses during a full email sign-in', async () => {
    await requestOtp().expect(202);
    const otp = ctx.email.lastOtp(EMAIL);
    await verifyOtp(wrongCode(otp));
    await verifyOtp(otp).expect(200);

    const logs = JSON.stringify(ctx.lines);
    expect(ctx.lines.length).toBeGreaterThan(0);
    expect(logs).not.toContain(otp);
    expect(logs).not.toContain(EMAIL);
    expect(logs).not.toContain('alice');
  });
});

describe('phone channel switched off (SMS_PROVIDER=none)', () => {
  it('rejects phone requests clearly while email keeps working', async () => {
    ctx = buildTestApp({ env: { SMS_PROVIDER: 'none' } });

    const phone = await request(ctx.app)
      .post('/auth/otp/request')
      .send({ phoneNumber: '+919876543210' });
    expect(phone.status).toBe(503);
    expect(phone.body.error.code).toBe('OTP_CHANNEL_UNAVAILABLE');
    expect(await ctx.redis.keys('otp:*')).toEqual([]);

    await requestOtp().expect(202);
    await verifyOtp(ctx.email.lastOtp(EMAIL)).expect(200);
  });
});
