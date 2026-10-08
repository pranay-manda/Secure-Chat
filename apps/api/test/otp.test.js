import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { User } from '../src/models/User.js';
import {
  buildTestApp,
  clearCooldowns,
  connectTestDb,
  disconnectTestDb,
  newDevice,
  resetTestDb,
} from './helpers.js';

const PHONE = '+919876543210';

let ctx;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
});

const requestOtp = (phoneNumber = PHONE) =>
  request(ctx.app).post('/auth/otp/request').send({ phoneNumber });

const verifyOtp = (otp, { phoneNumber = PHONE, device = newDevice() } = {}) =>
  request(ctx.app).post('/auth/otp/verify').send({ phoneNumber, otp, device });

describe('POST /auth/otp/request', () => {
  it('sends a 6-digit OTP without returning it', async () => {
    const res = await requestOtp();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });
    const otp = ctx.sms.lastOtp(PHONE);
    expect(otp).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body)).not.toContain(otp);
  });

  it('normalises numbers to E.164 before sending', async () => {
    await requestOtp('+91 98765-43210').expect(202);
    expect(ctx.sms.sent[0].phoneNumber).toBe(PHONE);
  });

  it('rejects invalid phone numbers', async () => {
    for (const phoneNumber of ['12345', '+1', 'not-a-number', '', '+91123']) {
      const res = await requestOtp(phoneNumber);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const missing = await request(ctx.app).post('/auth/otp/request').send({});
    expect(missing.status).toBe(400);
  });

  it('stores only an HMAC of the OTP in Redis, with a TTL, keyed without the phone number', async () => {
    await requestOtp().expect(202);
    const otp = ctx.sms.lastOtp(PHONE);

    const keys = await ctx.redis.keys('*');
    expect(keys.some((key) => key.includes(PHONE) || key.includes('9876543210'))).toBe(false);

    const otpKey = keys.find((key) => /^otp:[a-f\d]{64}$/.test(key));
    const stored = await ctx.redis.hgetall(otpKey);
    expect(stored.codeHash).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(otp);

    const ttl = await ctx.redis.ttl(otpKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('enforces a resend cooldown with Retry-After', async () => {
    await requestOtp().expect(202);
    const res = await requestOtp();

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_COOLDOWN');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(ctx.sms.sent).toHaveLength(1);
  });

  it('rate limits OTP requests per phone number', async () => {
    for (let i = 0; i < 5; i += 1) {
      await clearCooldowns(ctx.redis);
      await requestOtp().expect(202);
    }
    await clearCooldowns(ctx.redis);
    const res = await requestOtp();

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('rate limits OTP requests per IP across numbers', async () => {
    for (let i = 0; i < 20; i += 1) {
      await requestOtp(`+9198765432${String(i).padStart(2, '0')}`).expect(202);
    }
    const res = await requestOtp('+919812345678');
    expect(res.status).toBe(429);
  });
});

describe('POST /auth/otp/verify', () => {
  it('signs in with the correct OTP and creates the user', async () => {
    await requestOtp().expect(202);
    const device = newDevice();

    const res = await verifyOtp(ctx.sms.lastOtp(PHONE), { device });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ phoneNumber: PHONE, isNew: true });
    expect(res.body.device.deviceId).toBe(device.deviceId);
    expect(res.body.tokens.accessToken.split('.')).toHaveLength(3);
    expect(res.body.tokens.accessTokenExpiresIn).toBe(900);
    expect(res.body.tokens.refreshToken).toMatch(/^[a-f\d]{24}\.[A-Za-z0-9_-]{43}$/);
    expect(await User.countDocuments({ phoneNumber: PHONE })).toBe(1);
  });

  it('marks returning users as not new', async () => {
    await User.create({ phoneNumber: PHONE });
    await requestOtp().expect(202);

    const res = await verifyOtp(ctx.sms.lastOtp(PHONE));
    expect(res.body.user.isNew).toBe(false);
  });

  it('rejects a wrong OTP and reports remaining attempts', async () => {
    await requestOtp().expect(202);
    const wrong = ctx.sms.lastOtp(PHONE) === '000000' ? '111111' : '000000';

    const res = await verifyOtp(wrong);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(res.body.error.details.attemptsRemaining).toBe(4);
  });

  it('locks the OTP after 5 wrong attempts, even if the right code follows', async () => {
    await requestOtp().expect(202);
    const otp = ctx.sms.lastOtp(PHONE);
    const wrong = otp === '000000' ? '111111' : '000000';

    for (let i = 0; i < 4; i += 1) {
      expect((await verifyOtp(wrong)).body.error.code).toBe('OTP_INVALID');
    }
    const fifth = await verifyOtp(wrong);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');

    const correct = await verifyOtp(otp);
    expect(correct.status).toBe(400);
    expect(correct.body.error.code).toBe('OTP_INVALID');
  });

  it('accepts an OTP only once', async () => {
    await requestOtp().expect(202);
    const otp = ctx.sms.lastOtp(PHONE);

    await verifyOtp(otp).expect(200);
    const replay = await verifyOtp(otp);

    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('OTP_INVALID');
  });

  it('rejects an expired OTP', async () => {
    await requestOtp().expect(202);
    const [otpKey] = (await ctx.redis.keys('otp:*')).filter((key) => !key.startsWith('otp:cd:'));
    await ctx.redis.del(otpKey); // equivalent to TTL expiry

    const res = await verifyOtp(ctx.sms.lastOtp(PHONE));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID');
    // The failed attempt must not leave a key without a TTL behind.
    expect(await ctx.redis.exists(otpKey)).toBe(0);
  });

  it('rejects an OTP issued for a different number', async () => {
    await requestOtp().expect(202);
    const res = await verifyOtp(ctx.sms.lastOtp(PHONE), { phoneNumber: '+919812345678' });
    expect(res.status).toBe(400);
  });

  it('validates the OTP and device payload', async () => {
    const cases = [
      { otp: '12345', device: newDevice() },
      { otp: 123456, device: newDevice() },
      { otp: '123456', device: newDevice({ deviceId: 'not-a-uuid' }) },
      { otp: '123456', device: newDevice({ platform: 'windows' }) },
      { otp: '123456', device: newDevice({ name: 'bad\u0000name' }) },
      { otp: '123456' },
    ];
    for (const body of cases) {
      const res = await request(ctx.app)
        .post('/auth/otp/verify')
        .send({ phoneNumber: PHONE, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
