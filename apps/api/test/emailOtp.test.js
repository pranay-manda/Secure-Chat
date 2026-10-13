import RedisMock from 'ioredis-mock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User } from '../src/models/User.js';
import { createEmailProvider } from '../src/services/email/index.js';
import { smtpTransportOptions } from '../src/services/email/smtp.js';
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
const SMTP = Object.freeze({
  host: 'smtp.example.test',
  port: 587,
  user: 'otp@example.test',
  pass: 'smtp-app-password-0123',
  from: 'CipherChat <otp@example.test>',
});

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

/** A valid Indian mobile number derived from the email, so each test address has its own. */
const phoneFor = (email) => {
  let hash = 0;
  for (const ch of email.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_000_000;
  return `+919${String(hash).padStart(9, '0')}`;
};

/** Email sign-in: the code from the email plus the account's phone number (saved unverified). */
const verifyOtp = (
  otp,
  { email = EMAIL, device = newDevice(), app = ctx.app, phoneNumber = phoneFor(email) } = {},
) =>
  request(app)
    .post('/auth/otp/verify')
    .send({ email, otp, device, ...(phoneNumber ? { phoneNumber } : {}) });

const wrongCode = (otp) => (otp === '000000' ? '111111' : '000000');

const otpKeys = async (redis = ctx.redis) =>
  (await redis.keys('otp:*')).filter((key) => !key.startsWith('otp:cd:'));

/**
 * A fake SMTP transport for Nodemailer: records the transport options and every message, and
 * answers like an SMTP server (by default: recipient accepted). Nothing leaves the process.
 */
function fakeSmtp(behaviour = async (mail) => ({ accepted: [mail.to], rejected: [] })) {
  let respond = behaviour;
  const fake = { options: [], sent: [], behave: (next) => (respond = next) };
  fake.createTransport = vi.fn((options) => {
    fake.options.push(options);
    return {
      sendMail: async (mail) => {
        fake.sent.push(mail);
        return respond(mail);
      },
      close: () => {},
    };
  });
  return fake;
}

/** The real SMTP email provider (smtp.js + the OTP template) on a fake transport. */
const smtpProvider = (fake, smtp = SMTP) =>
  createEmailProvider(
    { provider: 'smtp', smtp, otpTtlSeconds: 300 },
    { createTransport: fake.createTransport },
  );

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

describe('SMTP delivery (Nodemailer, mocked: nothing is sent)', () => {
  it('sends the OTP email over TLS-only SMTP, and the emailed code signs in', async () => {
    const smtp = fakeSmtp();
    ctx = buildTestApp({ emailProvider: smtpProvider(smtp) });

    await requestOtp().expect(202);

    // One transporter, configured for verified TLS (STARTTLS required on 587).
    expect(smtp.createTransport).toHaveBeenCalledTimes(1);
    expect(smtp.options[0]).toMatchObject({
      host: SMTP.host,
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: SMTP.user, pass: SMTP.pass },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      pool: true,
      logger: false,
      debug: false,
    });
    expect(smtp.options[0].connectionTimeout).toBeGreaterThan(0);
    expect(smtp.options[0].socketTimeout).toBeGreaterThan(0);

    expect(smtp.sent).toHaveLength(1);
    const [mail] = smtp.sent;
    expect(mail).toMatchObject({
      from: SMTP.from,
      to: EMAIL,
      subject: 'Your CipherChat verification code',
    });
    const otp = mail.text.match(/Your verification code is: (\d{6})/)[1];
    expect(mail.text).toContain('This code expires in 5 minutes.');
    expect(mail.html).toContain(otp);

    // The emailed code is the one that signs in.
    await verifyOtp(otp).expect(200);
  });

  it('reuses one transporter for every email', async () => {
    const smtp = fakeSmtp();
    ctx = buildTestApp({ emailProvider: smtpProvider(smtp) });
    await requestOtp().expect(202);
    await requestOtp('bob@example.com').expect(202);
    expect(smtp.createTransport).toHaveBeenCalledTimes(1);
    expect(smtp.sent.map((m) => m.to)).toEqual([EMAIL, 'bob@example.com']);
  });

  it('port 465 uses TLS from the start; any other port must upgrade with STARTTLS', () => {
    expect(smtpTransportOptions({ ...SMTP, port: 465 })).toMatchObject({
      secure: true,
      requireTLS: false,
      tls: { rejectUnauthorized: true },
    });
    for (const port of [587, 25, 2525]) {
      expect(smtpTransportOptions({ ...SMTP, port })).toMatchObject({
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: true },
      });
    }
  });

  it('a recipient the server does not accept is a failure: 502, code cleared, nothing secret logged', async () => {
    let otpSent = null;
    const smtp = fakeSmtp(async (mail) => {
      otpSent = mail.text.match(/(\d{6})/)[1];
      return { accepted: [], rejected: [mail.to] };
    });
    ctx = buildTestApp({ emailProvider: smtpProvider(smtp) });

    const res = await requestOtp();

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
    expect(await ctx.redis.keys('otp:*')).toEqual([]); // code and cooldown both gone
    const failure = ctx.lines.find((line) => line.msg === 'OTP delivery failed');
    expect(failure.err).toMatchObject({ name: 'EmailDeliveryError', code: 'EENVELOPE' });
    const logs = JSON.stringify(ctx.lines);
    for (const secret of [SMTP.pass, EMAIL, otpSent]) expect(logs).not.toContain(secret);

    // The user can retry straight away once the server accepts mail again.
    smtp.behave(async (mail) => ({ accepted: [mail.to], rejected: [] }));
    await requestOtp().expect(202);
  });

  it.each([
    ['authentication failure', { code: 'EAUTH', responseCode: 535 }],
    ['connection refused', { code: 'ECONNECTION' }],
    ['timeout', { code: 'ETIMEDOUT' }],
    ['TLS certificate not trusted', { code: 'ESOCKET' }],
  ])('%s: 502, never reported as sent, and no secrets in logs', async (_label, fields) => {
    const smtp = fakeSmtp(async () => {
      // Real Nodemailer errors can quote the account, the recipient and the server reply.
      throw Object.assign(
        new Error(`Failed for ${SMTP.user} / ${EMAIL} pass=${SMTP.pass}`),
        fields,
      );
    });
    ctx = buildTestApp({ emailProvider: smtpProvider(smtp) });

    const res = await requestOtp();

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('OTP_DELIVERY_FAILED');
    expect(await ctx.redis.keys('otp:*')).toEqual([]);
    const failure = ctx.lines.find((line) => line.msg === 'OTP delivery failed');
    expect(failure.err).toMatchObject({ name: 'EmailDeliveryError', code: fields.code });
    if (fields.responseCode) expect(failure.err.responseCode).toBe(fields.responseCode);
    const logs = JSON.stringify(ctx.lines);
    for (const secret of [SMTP.pass, EMAIL, SMTP.user]) expect(logs).not.toContain(secret);
  });

  it('accepts the recipient case-insensitively (servers may echo it normalised)', async () => {
    const smtp = fakeSmtp(async (mail) => ({ accepted: [mail.to.toUpperCase()], rejected: [] }));
    ctx = buildTestApp({ emailProvider: smtpProvider(smtp) });
    await requestOtp().expect(202);
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
  it('signs in with the correct OTP and creates a user with the email and phone number', async () => {
    await requestOtp().expect(202);
    const device = newDevice();

    const res = await verifyOtp(ctx.email.lastOtp(EMAIL), { device });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      email: EMAIL,
      phoneNumber: phoneFor(EMAIL),
      phoneVerifiedAt: null, // typed, not proven by an SMS code
      isNew: true,
    });
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
    const second = await verifyOtp(ctx.email.lastOtp(EMAIL), {
      email: ' Alice@EXAMPLE.com',
      phoneNumber: phoneFor(EMAIL),
    });

    expect(second.status).toBe(200);
    expect(second.body.user).toMatchObject({ id: first.body.user.id, isNew: false });
    expect(await User.countDocuments({ email: EMAIL })).toBe(1);
  });

  it('keeps email and phone sign-in accounts side by side', async () => {
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

  it('creates (activates) an account only after a correct code is verified', async () => {
    await requestOtp().expect(202);
    expect(await User.countDocuments()).toBe(0); // requesting a code creates nothing
    const otp = ctx.email.lastOtp(EMAIL);
    await verifyOtp(wrongCode(otp)).expect(400);
    expect(await User.countDocuments()).toBe(0); // a wrong code creates nothing

    await verifyOtp(otp).expect(200);
    expect(await User.countDocuments()).toBe(1);
  });

  it('an expired or exhausted code never creates an account', async () => {
    await requestOtp().expect(202);
    const otp = ctx.email.lastOtp(EMAIL);
    for (let i = 0; i < 5; i += 1) await verifyOtp(wrongCode(otp));
    await verifyOtp(otp).expect(400);
    expect(await User.countDocuments()).toBe(0);
  });

  it('concurrent submissions of the same correct code sign in exactly once', async () => {
    await requestOtp().expect(202);
    const otp = ctx.email.lastOtp(EMAIL);
    const results = await Promise.all(Array.from({ length: 4 }, () => verifyOtp(otp)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 400)).toBe(true);
    expect(await User.countDocuments()).toBe(1);
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

describe('email + phone number at sign-up (OTP to the email)', () => {
  const fresh = async (email = EMAIL) => {
    await clearCooldowns(ctx.redis);
    await requestOtp(email).expect(202);
    return ctx.email.lastOtp(email);
  };

  it('a new account needs a phone number; nothing is created without one', async () => {
    const res = await verifyOtp(await fresh(), { phoneNumber: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHONE_NUMBER_REQUIRED');
    expect(await User.countDocuments()).toBe(0);
    const bad = await verifyOtp(await fresh(), { phoneNumber: '12345' });
    expect(bad.status).toBe(400); // not a valid number: refused before the code is used
  });

  it('saves the number normalised to E.164, so contact discovery can find the user', async () => {
    const res = await verifyOtp(await fresh(), { phoneNumber: '+91 98123 45678' });
    expect(res.status).toBe(200);
    expect(res.body.user.phoneNumber).toBe('+919812345678');
    const user = await User.findOne({ email: EMAIL }).lean();
    expect(user.phoneNumber).toBe('+919812345678');
  });

  it('a number already used by another account is refused, and no account is created', async () => {
    await verifyOtp(await fresh(), { phoneNumber: '+919812345678' }).expect(200);
    const res = await verifyOtp(await fresh('bob@example.com'), {
      email: 'bob@example.com',
      phoneNumber: '+919812345678',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_NUMBER_TAKEN');
    expect(await User.countDocuments()).toBe(1);
  });

  it('an existing account without a number gets this one; a different number is refused', async () => {
    await User.create({ email: EMAIL }); // an account from before numbers were required
    await verifyOtp(await fresh(), { phoneNumber: '+919812345678' }).expect(200);
    expect((await User.findOne({ email: EMAIL }).lean()).phoneNumber).toBe('+919812345678');

    await verifyOtp(await fresh(), { phoneNumber: '+919812345678' }).expect(200); // same: fine
    const other = await verifyOtp(await fresh(), { phoneNumber: '+919800000000' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('PHONE_NUMBER_MISMATCH');
    expect((await User.findOne({ email: EMAIL }).lean()).phoneNumber).toBe('+919812345678');
  });

  it('the number is never checked before the code is: a wrong code reveals nothing', async () => {
    await verifyOtp(await fresh(), { phoneNumber: '+919812345678' }).expect(200);
    const otp = await fresh('bob@example.com');
    const wrong = otp === '000000' ? '111111' : '000000';
    const res = await verifyOtp(wrong, { email: 'bob@example.com', phoneNumber: '+919812345678' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID'); // not PHONE_NUMBER_TAKEN
  });

  it('phone sign-in marks the number as verified', async () => {
    await request(ctx.app).post('/auth/otp/request').send({ phoneNumber: '+919876543210' });
    const res = await request(ctx.app)
      .post('/auth/otp/verify')
      .send({
        phoneNumber: '+919876543210',
        otp: ctx.sms.lastOtp('+919876543210'),
        device: newDevice(),
      })
      .expect(200);
    expect(res.body.user.phoneVerifiedAt).toEqual(expect.any(String));
  });
});

describe('adding a missing email or phone number to an account', () => {
  async function phoneUser(phoneNumber = '+919876543210') {
    await clearCooldowns(ctx.redis);
    await request(ctx.app).post('/auth/otp/request').send({ phoneNumber });
    const res = await request(ctx.app)
      .post('/auth/otp/verify')
      .send({ phoneNumber, otp: ctx.sms.lastOtp(phoneNumber), device: newDevice() })
      .expect(200);
    return { id: res.body.user.id, token: res.body.tokens.accessToken };
  }
  const as = (user) => ({
    get: (p) => request(ctx.app).get(p).set(bearer(user.token)),
    post: (p, body) => request(ctx.app).post(p).set(bearer(user.token)).send(body),
  });

  it('a phone sign-in account adds its email with a code sent to that email', async () => {
    const user = await phoneUser();
    expect((await as(user).get('/account')).body.user.email).toBeUndefined();
    await as(user).post('/account/email/otp', { email: 'Alice@Example.com' }).expect(202);
    const otp = ctx.email.lastOtp(EMAIL);
    const res = await as(user).post('/account/email', { email: EMAIL, otp });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: EMAIL, phoneNumber: '+919876543210' });
    // Now the same account signs in by email too.
    await clearCooldowns(ctx.redis);
    await requestOtp().expect(202);
    const login = await verifyOtp(ctx.email.lastOtp(EMAIL), { phoneNumber: '+919876543210' });
    expect(login.body.user.id).toBe(user.id);
  });

  it('a code for adding an email cannot sign in, and a sign-in code cannot add an email', async () => {
    const user = await phoneUser();
    await as(user).post('/account/email/otp', { email: EMAIL }).expect(202);
    const linkCode = ctx.email.lastOtp(EMAIL);
    expect((await verifyOtp(linkCode)).status).toBe(400); // not a sign-in code
    expect(await User.countDocuments({ email: EMAIL })).toBe(0);

    await clearCooldowns(ctx.redis);
    await requestOtp().expect(202);
    const signInCode = ctx.email.lastOtp(EMAIL);
    const res = await as(user).post('/account/email', { email: EMAIL, otp: signInCode });
    expect(res.status).toBe(400);
  });

  it('refuses an email used by another account, and never replaces a set email or number', async () => {
    await clearCooldowns(ctx.redis);
    await requestOtp().expect(202);
    const emailUser = await verifyOtp(ctx.email.lastOtp(EMAIL), { phoneNumber: '+919812345678' });
    const user = await phoneUser();
    const taken = await as(user).post('/account/email/otp', { email: EMAIL });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');

    const owner = { token: emailUser.body.tokens.accessToken };
    const again = await as(owner).post('/account/phone', { phoneNumber: '+919800000000' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SET');
    const email = await as(owner).post('/account/email/otp', { email: 'new@example.com' });
    expect(email.status).toBe(409);
  });

  it('an account without a number adds one; a taken number is refused', async () => {
    const legacy = await User.create({ email: EMAIL });
    await clearCooldowns(ctx.redis);
    await requestOtp().expect(202);
    // Sign in by email without a number (an older app version): allowed for an existing account.
    const login = await verifyOtp(ctx.email.lastOtp(EMAIL), { phoneNumber: null }).expect(200);
    const user = { token: login.body.tokens.accessToken };
    await phoneUser('+919811111111');
    const taken = await as(user).post('/account/phone', { phoneNumber: '+919811111111' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('PHONE_NUMBER_TAKEN');
    const ok = await as(user).post('/account/phone', { phoneNumber: '+91 98222 22222' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ id: String(legacy._id), phoneNumber: '+919822222222' });
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
