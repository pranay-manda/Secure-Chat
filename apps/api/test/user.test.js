import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrateUserIndexes, User } from '../src/models/User.js';
import { connectTestDb, disconnectTestDb, resetTestDb } from './helpers.js';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(resetTestDb);

describe('User identifiers', () => {
  it('requires an email address or a phone number', async () => {
    await expect(User.create({ displayName: 'nobody' })).rejects.toThrow(
      /email address or a phone/,
    );
    await expect(User.create({ email: 'a@example.com' })).resolves.toBeTruthy();
    await expect(User.create({ phoneNumber: '+919876543210' })).resolves.toBeTruthy();
  });

  it('keeps each identifier unique while allowing many users without one', async () => {
    await User.create([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
      { phoneNumber: '+919876543210' },
      { phoneNumber: '+919812345678' },
    ]);

    await expect(User.create({ email: 'a@example.com' })).rejects.toMatchObject({ code: 11000 });
    await expect(User.create({ phoneNumber: '+919876543210' })).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe('migrateUserIndexes', () => {
  it('replaces the Phase 1 non-partial phoneNumber index and is idempotent', async () => {
    await User.collection.dropIndexes();
    await User.collection.createIndex({ phoneNumber: 1 }, { unique: true });
    await User.collection.insertOne({ phoneNumber: '+919876543210', displayName: '' });

    expect(await migrateUserIndexes()).toBe(true);
    expect(await migrateUserIndexes()).toBe(false);

    const indexes = await User.collection.indexes();
    const phone = indexes.find((index) => index.name === 'phoneNumber_1');
    expect(phone).toMatchObject({ unique: true, partialFilterExpression: expect.any(Object) });
    expect(indexes.some((index) => index.name === 'email_1' && index.unique)).toBe(true);

    // Existing data survives and email-only users no longer collide on a missing phone.
    expect(await User.countDocuments({ phoneNumber: '+919876543210' })).toBe(1);
    await User.create([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
    await expect(User.create({ phoneNumber: '+919876543210' })).rejects.toMatchObject({
      code: 11000,
    });
  });
});
