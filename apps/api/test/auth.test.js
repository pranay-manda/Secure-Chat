import { randomBytes } from 'node:crypto';

import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Device } from '../src/models/Device.js';
import { Session } from '../src/models/Session.js';
import { User } from '../src/models/User.js';
import {
  bearer,
  buildTestApp,
  connectTestDb,
  disconnectTestDb,
  login,
  newDevice,
  resetTestDb,
  TEST_ENV,
} from './helpers.js';

const PHONE = '+919876543210';

let ctx;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
async function freshApp() {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
}
beforeEach(freshApp);

const getDevices = (accessToken) => request(ctx.app).get('/devices').set(bearer(accessToken));
const refresh = (refreshToken, deviceId, nextRefreshSecret) =>
  request(ctx.app).post('/auth/refresh').send({ refreshToken, deviceId, nextRefreshSecret });
/** A next-refresh-token secret as the app proposes it: 32 random bytes, base64url. */
const newSecret = () => randomBytes(32).toString('base64url');
const secretOf = (refreshToken) => refreshToken.split('.')[1];
const onlySession = async () => (await Session.find().lean())[0];

describe('sensitive data in error logs', () => {
  it('an unexpected database error during login logs no phone number', async () => {
    // A real duplicate-key error from MongoDB, raised where the login creates the user.
    await User.create({ phoneNumber: PHONE });
    let realError;
    try {
      await User.create({ phoneNumber: PHONE });
    } catch (err) {
      realError = err;
    }
    expect(String(realError.message)).toContain(PHONE.slice(-6));
    await User.deleteMany({});
    const spy = vi.spyOn(User, 'findOneAndUpdate').mockRejectedValue(realError);

    const requested = await request(ctx.app).post('/auth/otp/request').send({ phoneNumber: PHONE });
    expect(requested.status).toBe(202);
    const otp = ctx.sms.sent.at(-1).otp;
    const res = await request(ctx.app)
      .post('/auth/otp/verify')
      .send({ phoneNumber: PHONE, otp, device: newDevice() });
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    const logged = JSON.stringify(ctx.lines);
    expect(logged).toContain('Unhandled error');
    expect(logged).not.toContain(PHONE.slice(-10));
    expect(logged).not.toContain(PHONE.slice(-6));
  });
});

describe('authentication middleware', () => {
  it('accepts a valid access token', async () => {
    const { tokens } = await login(ctx, PHONE);
    await getDevices(tokens.accessToken).expect(200);
  });

  it('rejects missing, malformed and tampered tokens', async () => {
    const { tokens } = await login(ctx, PHONE);
    const [header, payload, signature] = tokens.accessToken.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        sub: '507f1f77bcf86cd799439011',
      }),
    ).toString('base64url');

    const attempts = [
      request(ctx.app).get('/devices'),
      request(ctx.app).get('/devices').set('Authorization', tokens.accessToken),
      request(ctx.app).get('/devices').set('Authorization', 'Bearer abc'),
      getDevices(`${header}.${tamperedPayload}.${signature}`),
      getDevices(`${header}.${payload}.${signature.slice(0, -2)}xx`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('rejects unsigned (alg: none) and foreign-key tokens', async () => {
    const { tokens } = await login(ctx, PHONE);
    const payload = tokens.accessToken.split('.')[1];
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    await getDevices(none).expect(401);

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('attacker-secret-attacker-secret-attacker'));
    await getDevices(forged).expect(401);
  });

  it('rejects expired access tokens', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url'));
    const { accessToken } = await ctx.container.tokenService.signAccessToken(
      { userId: claims.sub, sessionId: claims.sid, deviceId: device.deviceId },
      { expiresInSeconds: -60 },
    );
    await getDevices(accessToken).expect(401);
  });

  it('rejects tokens for the wrong issuer or audience', async () => {
    const { tokens } = await login(ctx, PHONE);
    const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1], 'base64url'));
    const wrongAudience = await new SignJWT({ ...claims, aud: 'another-app' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(TEST_ENV.JWT_ACCESS_SECRET));
    await getDevices(wrongAudience).expect(401);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates tokens and stores only hashes', async () => {
    const { tokens, device } = await login(ctx, PHONE);

    const res = await refresh(tokens.refreshToken, device.deviceId);

    expect(res.status).toBe(200);
    expect(res.body.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(res.body.tokens.accessToken).not.toBe(tokens.accessToken);
    await getDevices(res.body.tokens.accessToken).expect(200);

    const [session] = await Session.find().lean();
    const stored = JSON.stringify(session);
    for (const token of [tokens.refreshToken, res.body.tokens.refreshToken]) {
      expect(stored).not.toContain(token.split('.')[1]);
    }
    expect(session.refreshTokenHash).toMatch(/^[a-f\d]{64}$/);
  });

  it('detects reuse of a rotated refresh token and revokes the session', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const rotated = (await refresh(tokens.refreshToken, device.deviceId).expect(200)).body.tokens;

    const replay = await refresh(tokens.refreshToken, device.deviceId);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The legitimate (latest) tokens die with the session as well.
    expect((await refresh(rotated.refreshToken, device.deviceId)).status).toBe(401);
    await getDevices(rotated.accessToken).expect(401);
    const [session] = await Session.find().lean();
    expect(session.revokedReason).toBe('refresh_token_reuse');
  });

  it('allows only one of two concurrent refreshes with the same token', async () => {
    const { tokens, device } = await login(ctx, PHONE);

    const results = await Promise.all([
      refresh(tokens.refreshToken, device.deviceId),
      refresh(tokens.refreshToken, device.deviceId),
    ]);

    expect(results.filter((res) => res.status === 200).length).toBeLessThanOrEqual(1);
  });

  it('binds the refresh token to its device', async () => {
    const { tokens } = await login(ctx, PHONE);

    const res = await refresh(tokens.refreshToken, newDevice().deviceId);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    const [session] = await Session.find().lean();
    expect(session.revokedReason).toBe('device_mismatch');
  });

  it('rejects malformed, unknown and guessed refresh tokens without revoking', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const [sessionId] = tokens.refreshToken.split('.');

    for (const token of [
      'garbage',
      `${sessionId}.${'A'.repeat(43)}`,
      `507f1f77bcf86cd799439011.${'A'.repeat(43)}`,
    ]) {
      const res = await refresh(token, device.deviceId);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    }
    // Guessing does not let an attacker kill the victim's session.
    await refresh(tokens.refreshToken, device.deviceId).expect(200);
  });

  it('rejects expired sessions', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    await Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    await refresh(tokens.refreshToken, device.deviceId).expect(401);
    await getDevices(tokens.accessToken).expect(401);
  });
});

describe('POST /auth/refresh: interrupted and repeated rotations', () => {
  it('uses the secret the app proposed for the next refresh token', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();

    const res = await refresh(tokens.refreshToken, device.deviceId, next).expect(200);

    expect(res.body.tokens.refreshToken).toBe(`${tokens.refreshToken.split('.')[0]}.${next}`);
    expect(JSON.stringify(await onlySession())).not.toContain(next);
    await refresh(res.body.tokens.refreshToken, device.deviceId, newSecret()).expect(200);
  });

  it('answers a retry after a lost response without revoking or rotating again', async () => {
    // The race: the server rotated, the answer never reached the app (timeout, dropped
    // connection, app reloaded or killed), and the app still holds only the spent token.
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();
    const lost = (await refresh(tokens.refreshToken, device.deviceId, next).expect(200)).body;
    const rotated = await onlySession();

    const retry = await refresh(tokens.refreshToken, device.deviceId, next);

    expect(retry.status).toBe(200);
    expect(retry.body.tokens.refreshToken).toBe(lost.tokens.refreshToken);
    expect(retry.body.tokens.refreshTokenExpiresAt).toBe(lost.tokens.refreshTokenExpiresAt);
    expect(retry.body.tokens.accessToken).not.toBe(lost.tokens.accessToken);
    await getDevices(retry.body.tokens.accessToken).expect(200);
    const after = await onlySession();
    expect(after.revokedAt).toBeNull();
    expect(after.refreshTokenHash).toBe(rotated.refreshTokenHash);
    expect(after.usedRefreshTokenHashes).toEqual(rotated.usedRefreshTokenHashes);

    // Further copies are answered the same way; the recovered token then rotates normally.
    await refresh(tokens.refreshToken, device.deviceId, next).expect(200);
    await refresh(retry.body.tokens.refreshToken, device.deviceId, newSecret()).expect(200);
    expect((await onlySession()).revokedAt).toBeNull();
  });

  it('recovers when the rotation was saved but the answer failed (5xx)', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();
    const spy = vi
      .spyOn(ctx.container.tokenService, 'signAccessToken')
      .mockRejectedValueOnce(new Error('signing unavailable'));

    await refresh(tokens.refreshToken, device.deviceId, next).expect(500);
    spy.mockRestore();
    expect((await onlySession()).usedRefreshTokenHashes).toHaveLength(1); // it did rotate

    const retry = await refresh(tokens.refreshToken, device.deviceId, next).expect(200);
    expect(retry.body.tokens.refreshToken).toBe(`${tokens.refreshToken.split('.')[0]}.${next}`);
    await getDevices(retry.body.tokens.accessToken).expect(200);
  });

  it('lets two identical concurrent requests both succeed with the same token', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();

    const results = await Promise.all(
      [1, 2, 3].map(() => refresh(tokens.refreshToken, device.deviceId, next)),
    );

    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    const issued = new Set(results.map((res) => res.body.tokens.refreshToken));
    expect([...issued]).toEqual([`${tokens.refreshToken.split('.')[0]}.${next}`]);
    const session = await onlySession();
    expect(session.revokedAt).toBeNull();
    expect(session.usedRefreshTokenHashes).toHaveLength(1);
  });

  it('answers the copy that loses the compare-and-swap as a retry, not as reuse', async () => {
    // Deterministic interleaving: the copy reads the session before the other copy rotated it.
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();
    const before = await onlySession();
    await refresh(tokens.refreshToken, device.deviceId, next).expect(200);
    const spy = vi.spyOn(Session, 'findById').mockReturnValueOnce({ lean: async () => before });

    const copy = await refresh(tokens.refreshToken, device.deviceId, next);
    spy.mockRestore();

    expect(copy.status).toBe(200);
    expect(copy.body.tokens.refreshToken).toBe(`${tokens.refreshToken.split('.')[0]}.${next}`);
    expect((await onlySession()).revokedAt).toBeNull();
  });

  it('treats a concurrent request with another proposed secret as reuse', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const before = await onlySession();
    const first = (await refresh(tokens.refreshToken, device.deviceId, newSecret()).expect(200))
      .body.tokens;
    const spy = vi.spyOn(Session, 'findById').mockReturnValueOnce({ lean: async () => before });

    const other = await refresh(tokens.refreshToken, device.deviceId, newSecret());
    spy.mockRestore();

    expect(other.status).toBe(401);
    expect(other.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await onlySession()).revokedReason).toBe('refresh_token_reuse');
    await getDevices(first.accessToken).expect(401);
  });

  it('still revokes a rotated token presented without the right proposed secret', async () => {
    // Without a proposal (an old app, or a thief holding only the old token) or with a
    // guessed one, the repeat cannot prove it made the rotation.
    for (const proposal of [() => undefined, newSecret]) {
      await freshApp();
      const { tokens, device } = await login(ctx, PHONE);
      const rotated = (await refresh(tokens.refreshToken, device.deviceId, newSecret()).expect(200))
        .body.tokens;

      const replay = await refresh(tokens.refreshToken, device.deviceId, proposal());

      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      expect((await onlySession()).revokedReason).toBe('refresh_token_reuse');
      await refresh(rotated.refreshToken, device.deviceId, newSecret()).expect(401);
      await getDevices(rotated.accessToken).expect(401);
    }
  });

  it('treats an older token as reuse even with the current secret', async () => {
    // Only the immediate predecessor of the current token can be retried.
    for (const retried of ['first', 'second']) {
      await freshApp();
      const { tokens, device } = await login(ctx, PHONE);
      const secrets = { first: newSecret(), second: newSecret() };
      const t1 = (await refresh(tokens.refreshToken, device.deviceId, secrets.first).expect(200))
        .body.tokens;
      await refresh(t1.refreshToken, device.deviceId, secrets.second).expect(200);

      const res = await refresh(tokens.refreshToken, device.deviceId, secrets[retried]);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      expect((await onlySession()).revokedReason).toBe('refresh_token_reuse');
    }
  });

  it('does not answer a retry from another device, and revokes', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();
    await refresh(tokens.refreshToken, device.deviceId, next).expect(200);

    const res = await refresh(tokens.refreshToken, newDevice().deviceId, next);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    expect(res.body.tokens).toBeUndefined();
    expect((await onlySession()).revokedReason).toBe('device_mismatch');
  });

  it('does not answer a retry for a revoked device', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();
    await refresh(tokens.refreshToken, device.deviceId, next).expect(200);
    await Device.updateOne({ deviceId: device.deviceId }, { $set: { revokedAt: new Date() } });

    const res = await refresh(tokens.refreshToken, device.deviceId, next);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('DEVICE_REVOKED');
    expect((await onlySession()).revokedReason).toBe('device_revoked');
  });

  it('does not answer a retry once the session ended (logout, revocation, expiry)', async () => {
    const endings = [
      async (tokens) =>
        request(ctx.app).post('/auth/logout').set(bearer(tokens.accessToken)).expect(204),
      async () => Session.updateMany({}, { $set: { revokedAt: new Date(), revokedReason: 'x' } }),
      async () => Session.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } }),
    ];
    for (const end of endings) {
      await freshApp();
      const { tokens, device } = await login(ctx, PHONE);
      const next = newSecret();
      const rotated = (await refresh(tokens.refreshToken, device.deviceId, next).expect(200)).body
        .tokens;
      await end(rotated);

      const res = await refresh(tokens.refreshToken, device.deviceId, next);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
      await refresh(rotated.refreshToken, device.deviceId, newSecret()).expect(401);
    }
  });

  it('rejects a malformed or recycled proposal without rotating or revoking', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const t1 = (await refresh(tokens.refreshToken, device.deviceId, newSecret()).expect(200)).body
      .tokens;
    const before = await onlySession();

    for (const proposal of [
      'short',
      `${newSecret().slice(0, 42)}+`,
      `${newSecret()}A`,
      secretOf(t1.refreshToken), // the current secret
      secretOf(tokens.refreshToken), // a used one
    ]) {
      const res = await refresh(t1.refreshToken, device.deviceId, proposal);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    const after = await onlySession();
    expect(after.revokedAt).toBeNull();
    expect(after.refreshTokenHash).toBe(before.refreshTokenHash);
    await refresh(t1.refreshToken, device.deviceId, newSecret()).expect(200);
  });

  it('logs no refresh token or proposed secret on retries and reuse', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const next = newSecret();
    const other = newSecret();
    await refresh(tokens.refreshToken, device.deviceId, next).expect(200);
    await refresh(tokens.refreshToken, device.deviceId, next).expect(200); // retry -> info log
    await refresh(tokens.refreshToken, device.deviceId, other).expect(401); // reuse -> warning

    const logs = JSON.stringify(ctx.lines);
    expect(logs).toContain('Refresh retried after an interrupted response');
    expect(logs).toContain('Refresh token reuse detected');
    for (const secret of [secretOf(tokens.refreshToken), next, other]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('POST /auth/logout', () => {
  it('ends the session immediately', async () => {
    const { tokens, device } = await login(ctx, PHONE);

    await request(ctx.app).post('/auth/logout').set(bearer(tokens.accessToken)).expect(204);

    await getDevices(tokens.accessToken).expect(401);
    await refresh(tokens.refreshToken, device.deviceId).expect(401);
  });

  it('requires authentication', async () => {
    await request(ctx.app).post('/auth/logout').expect(401);
  });
});

describe('log hygiene', () => {
  it('never logs OTPs, tokens or phone numbers during a full auth flow', async () => {
    const { tokens, device } = await login(ctx, PHONE);
    const otp = ctx.sms.lastOtp(PHONE);
    const rotated = (await refresh(tokens.refreshToken, device.deviceId)).body.tokens;
    await refresh(tokens.refreshToken, device.deviceId); // reuse -> warning log
    await request(ctx.app).post('/auth/logout').set(bearer(rotated.accessToken));

    const logs = JSON.stringify(ctx.lines);
    expect(ctx.lines.length).toBeGreaterThan(0);
    for (const secret of [
      otp,
      PHONE,
      '9876543210',
      tokens.accessToken,
      tokens.refreshToken.split('.')[1],
      rotated.refreshToken.split('.')[1],
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});
