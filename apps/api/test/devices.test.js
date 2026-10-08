import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Device } from '../src/models/Device.js';
import {
  bearer,
  buildTestApp,
  clearCooldowns as clearCooldownsFor,
  connectTestDb,
  disconnectTestDb,
  login,
  newDevice,
  resetTestDb,
} from './helpers.js';

const PHONE = '+919876543210';
const OTHER_PHONE = '+919812345678';

let ctx;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
});

const clearCooldowns = () => clearCooldownsFor(ctx.redis);

describe('POST /devices', () => {
  it('updates metadata for the current device', async () => {
    const { tokens, device } = await login(ctx, PHONE);

    const res = await request(ctx.app)
      .post('/devices')
      .set(bearer(tokens.accessToken))
      .send({ platform: 'android', name: 'Pixel 9', appVersion: '0.2.0', osVersion: '16' });

    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({
      deviceId: device.deviceId,
      name: 'Pixel 9',
      appVersion: '0.2.0',
      osVersion: '16',
      current: true,
    });
  });

  it('validates input and requires authentication', async () => {
    const { tokens } = await login(ctx, PHONE);
    await request(ctx.app)
      .post('/devices')
      .set(bearer(tokens.accessToken))
      .send({ platform: 'symbian' })
      .expect(400);
    await request(ctx.app).post('/devices').send({ platform: 'android' }).expect(401);
  });
});

describe('GET /devices', () => {
  it('lists only the caller’s devices and marks the current one', async () => {
    const mine = await login(ctx, PHONE);
    await login(ctx, OTHER_PHONE);

    const res = await request(ctx.app).get('/devices').set(bearer(mine.tokens.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0]).toMatchObject({ deviceId: mine.device.deviceId, current: true });
    expect(res.body.devices[0]).not.toHaveProperty('userId');
    expect(res.body.devices[0]).not.toHaveProperty('_id');
  });
});

describe('single active device', () => {
  it('signing in on a new device signs out the previous one', async () => {
    const first = await login(ctx, PHONE);
    await clearCooldowns();
    const second = await login(ctx, PHONE, newDevice({ platform: 'ios' }));

    await request(ctx.app).get('/devices').set(bearer(first.tokens.accessToken)).expect(401);
    await request(ctx.app)
      .post('/auth/refresh')
      .send({ refreshToken: first.tokens.refreshToken, deviceId: first.device.deviceId })
      .expect(401);

    const res = await request(ctx.app).get('/devices').set(bearer(second.tokens.accessToken));
    const old = res.body.devices.find((d) => d.deviceId === first.device.deviceId);
    expect(old.revokedAt).not.toBeNull();
    expect(res.body.devices.filter((d) => d.revokedAt === null)).toHaveLength(1);
  });

  it('signing in again on the same device replaces its old session', async () => {
    const device = newDevice();
    const first = await login(ctx, PHONE, device);
    await clearCooldowns();
    const second = await login(ctx, PHONE, device);

    await request(ctx.app).get('/devices').set(bearer(first.tokens.accessToken)).expect(401);
    await request(ctx.app).get('/devices').set(bearer(second.tokens.accessToken)).expect(200);
    expect(await Device.countDocuments({ deviceId: device.deviceId })).toBe(1);
  });
});

describe('DELETE /devices/:deviceId', () => {
  it('revokes the device: its tokens stop working and it cannot sign in again', async () => {
    const { tokens, device } = await login(ctx, PHONE);

    await request(ctx.app)
      .delete(`/devices/${device.deviceId}`)
      .set(bearer(tokens.accessToken))
      .expect(204);

    await request(ctx.app).get('/devices').set(bearer(tokens.accessToken)).expect(401);
    await request(ctx.app)
      .post('/auth/refresh')
      .send({ refreshToken: tokens.refreshToken, deviceId: device.deviceId })
      .expect(401);

    await clearCooldowns();
    await request(ctx.app).post('/auth/otp/request').send({ phoneNumber: PHONE }).expect(202);
    const relogin = await request(ctx.app)
      .post('/auth/otp/verify')
      .send({ phoneNumber: PHONE, otp: ctx.sms.lastOtp(PHONE), device });
    expect(relogin.status).toBe(403);
    expect(relogin.body.error.code).toBe('DEVICE_REVOKED');

    // A fresh install (new deviceId) can sign in.
    await clearCooldowns();
    await login(ctx, PHONE, newDevice());
  });

  it('returns 404 for another user’s device and leaves it untouched', async () => {
    const victim = await login(ctx, PHONE);
    const attacker = await login(ctx, OTHER_PHONE);

    await request(ctx.app)
      .delete(`/devices/${victim.device.deviceId}`)
      .set(bearer(attacker.tokens.accessToken))
      .expect(404);

    await request(ctx.app).get('/devices').set(bearer(victim.tokens.accessToken)).expect(200);
  });

  it('validates the deviceId parameter', async () => {
    const { tokens } = await login(ctx, PHONE);
    await request(ctx.app)
      .delete('/devices/not-a-uuid')
      .set(bearer(tokens.accessToken))
      .expect(400);
  });
});
