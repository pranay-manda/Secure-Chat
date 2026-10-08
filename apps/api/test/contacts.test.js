import { LIMITS } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { User } from '../src/models/User.js';
import {
  bearer,
  buildTestApp,
  connectTestDb,
  disconnectTestDb,
  login,
  resetTestDb,
} from './helpers.js';

const ALICE = '+919876543210'; // the caller
const BOB = '+919812345678';
const CAROL = '+14155550123';
const UNREGISTERED = '+919800000001';

let ctx;
let alice;
let bob;
let carol;

const match = (phoneNumbers, token = alice.tokens.accessToken) =>
  request(ctx.app).post('/contacts/match').set(bearer(token)).send({ phoneNumbers });

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp();
  await ctx.redis.flushall();
  alice = await login(ctx, ALICE);
  bob = await login(ctx, BOB);
  carol = await login(ctx, CAROL);
  await User.updateOne({ _id: carol.user.id }, { $set: { displayName: 'Carol' } });
});

describe('POST /contacts/match', () => {
  it('returns only registered contacts with the fields the app needs', async () => {
    const res = await match([BOB, UNREGISTERED]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matches: [{ userId: bob.user.id, phoneNumber: BOB, displayName: '' }],
    });
  });

  it('matches regardless of formatting (same E.164 rules as sign-in)', async () => {
    const res = await match(['+91 98123 45678', '+1 (415) 555-0123', '+91-98123-45678']);

    const byId = Object.fromEntries(res.body.matches.map((m) => [m.userId, m]));
    expect(Object.keys(byId).sort()).toEqual([bob.user.id, carol.user.id].sort());
    expect(byId[carol.user.id]).toEqual({
      userId: carol.user.id,
      phoneNumber: CAROL,
      displayName: 'Carol',
    });
    expect(res.body.matches).toHaveLength(2); // duplicates collapse
  });

  it('handles mixed, duplicate, invalid and unregistered numbers', async () => {
    const res = await match([BOB, BOB, 'not a number', '12345', UNREGISTERED, CAROL]);

    expect(res.status).toBe(200);
    expect(res.body.matches.map((m) => m.userId).sort()).toEqual(
      [bob.user.id, carol.user.id].sort(),
    );
  });

  it('returns no matches when nothing is registered', async () => {
    const res = await match([UNREGISTERED, '+919800000002']);
    expect(res.body).toEqual({ matches: [] });
  });

  it('never returns the caller, and never email-only accounts', async () => {
    await User.create({ email: 'dave@example.com', displayName: 'Dave' });

    const res = await match([ALICE, BOB, 'dave@example.com']);

    expect(res.body.matches.map((m) => m.userId)).toEqual([bob.user.id]);
    expect(JSON.stringify(res.body)).not.toContain('dave');
  });

  it('never returns private or account data', async () => {
    const res = await match([BOB]);
    const text = JSON.stringify(res.body);

    expect(Object.keys(res.body.matches[0]).sort()).toEqual([
      'displayName',
      'phoneNumber',
      'userId',
    ]);
    for (const secret of [bob.tokens.refreshToken, bob.tokens.accessToken, 'email', 'device']) {
      expect(text).not.toContain(secret);
    }
  });

  it('requires authentication', async () => {
    const res = await request(ctx.app)
      .post('/contacts/match')
      .send({ phoneNumbers: [BOB] });
    expect(res.status).toBe(401);
    expect(res.body.matches).toBeUndefined();

    const revoked = await request(ctx.app)
      .post('/contacts/match')
      .set(bearer('not.a.jwt'))
      .send({ phoneNumbers: [BOB] });
    expect(revoked.status).toBe(401);
  });

  it('validates the request and enforces the batch size', async () => {
    const tooMany = Array.from(
      { length: LIMITS.CONTACT_MATCH_BATCH_MAX + 1 },
      (_, i) => `+9198000${String(i).padStart(5, '0')}`,
    );
    const invalid = [
      { phoneNumbers: [] },
      { phoneNumbers: tooMany },
      { phoneNumbers: [{ $ne: null }] },
      { phoneNumbers: [123] },
      { phoneNumbers: ['x'.repeat(40)] },
      { phoneNumbers: [BOB], names: ['Bob'] }, // contact names are not accepted
      {},
    ];
    for (const body of invalid) {
      const res = await request(ctx.app)
        .post('/contacts/match')
        .set(bearer(alice.tokens.accessToken))
        .send(body);
      expect(res.status).toBe(400);
    }

    const exactlyMax = tooMany.slice(0, LIMITS.CONTACT_MATCH_BATCH_MAX);
    expect((await match(exactlyMax)).status).toBe(200);
  });

  it('rate limits by the number of phone numbers checked, per user', async () => {
    const batch = Array.from(
      { length: LIMITS.CONTACT_MATCH_BATCH_MAX },
      (_, i) => `+9198000${String(i).padStart(5, '0')}`,
    );
    // 5000 numbers per hour = 10 full batches.
    for (let i = 0; i < 10; i += 1) expect((await match(batch)).status).toBe(200);

    const blocked = await match([BOB]);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // Other users have their own budget.
    expect((await match([BOB], carol.tokens.accessToken)).status).toBe(200);
  });

  it('stores nothing about the lookup and logs no phone numbers', async () => {
    const collectionsBefore = (await mongoose.connection.db.listCollections().toArray())
      .map((c) => c.name)
      .sort();
    const usersBefore = await User.countDocuments();

    await match([BOB, UNREGISTERED, CAROL]);

    const collectionsAfter = (await mongoose.connection.db.listCollections().toArray())
      .map((c) => c.name)
      .sort();
    expect(collectionsAfter).toEqual(collectionsBefore);
    expect(await User.countDocuments()).toBe(usersBefore);
    expect(await User.countDocuments({ phoneNumber: UNREGISTERED })).toBe(0);

    const logs = JSON.stringify(ctx.lines);
    for (const n of [UNREGISTERED, '9800000001', BOB, CAROL]) expect(logs).not.toContain(n);
  });
});
