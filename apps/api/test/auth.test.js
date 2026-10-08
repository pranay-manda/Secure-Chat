import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Session } from '../src/models/Session.js';
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
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
});

const getDevices = (accessToken) => request(ctx.app).get('/devices').set(bearer(accessToken));
const refresh = (refreshToken, deviceId) =>
  request(ctx.app).post('/auth/refresh').send({ refreshToken, deviceId });

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
