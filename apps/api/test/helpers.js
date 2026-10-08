import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import RedisMock from 'ioredis-mock';
import mongoose from 'mongoose';
import request from 'supertest';
import { inject } from 'vitest';

import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createContainer } from '../src/container.js';
import { createLogger } from '../src/lib/logger.js';
import { Counter } from '../src/models/Counter.js';
import { Device } from '../src/models/Device.js';
import { Message } from '../src/models/Message.js';
import { MessageEnvelope } from '../src/models/MessageEnvelope.js';
import { OneTimePreKey } from '../src/models/OneTimePreKey.js';
import { Session } from '../src/models/Session.js';
import { User } from '../src/models/User.js';

export const TEST_ENV = {
  NODE_ENV: 'test',
  // Placeholders: unit tests inject datastores and never connect to these.
  MONGODB_URI: 'mongodb://127.0.0.1:27017/securechat-test',
  REDIS_URL: 'redis://:test-password@127.0.0.1:6379/0',
  HEALTH_CHECK_TIMEOUT_MS: '200',
  JWT_ACCESS_SECRET: 'test-jwt-secret-0123456789abcdefghijklmnop',
  OTP_HMAC_SECRET: 'test-otp-secret-0123456789abcdefghijklmnop',
  EMAIL_PROVIDER: 'console',
  // Push tests inject a fake provider; nothing ever calls the real push service.
  PUSH_PROVIDER: 'none',
};

/** A logger whose output is captured as parsed JSON lines. */
export function createCapturingLogger(level = 'info') {
  const lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(
        ...chunk
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      );
      callback();
    },
  });
  return { logger: createLogger({ level, nodeEnv: 'test' }, stream), lines };
}

/** Records OTPs instead of sending SMS. */
export function createFakeSms() {
  const sent = [];
  return {
    sent,
    async sendOtp(phoneNumber, otp) {
      sent.push({ phoneNumber, otp });
    },
    lastOtp(phoneNumber) {
      return sent.findLast((entry) => entry.phoneNumber === phoneNumber)?.otp;
    },
  };
}

/** Records OTPs instead of sending email. */
export function createFakeEmail() {
  const sent = [];
  return {
    sent,
    async sendOtp(email, otp) {
      sent.push({ email, otp });
    },
    lastOtp(email) {
      return sent.findLast((entry) => entry.email === email)?.otp;
    },
  };
}

// One mock client per test file: each instance registers listeners on shared mock state.
let sharedRedisMock;

/** Records realtime (Pusher) publishes instead of sending them. */
export function createCapturingRealtime() {
  const published = [];
  return {
    published,
    async publish(channel, event, payload) {
      published.push({ channel, event, payload: JSON.parse(JSON.stringify(payload)) });
    },
  };
}

export function buildTestApp({ healthChecks, env = {}, redis, emailProvider, pushProvider } = {}) {
  const config = loadEnv({ ...TEST_ENV, ...env });
  const { logger, lines } = createCapturingLogger();
  const sms = createFakeSms();
  const email = createFakeEmail();
  const realtime = createCapturingRealtime();
  sharedRedisMock ??= new RedisMock();
  const redisClient = redis ?? sharedRedisMock;
  const container = createContainer({
    config,
    logger,
    redis: redisClient,
    // `none` in the env switches a channel off, exactly as in production.
    smsProvider: config.sms.provider === 'none' ? null : sms,
    emailProvider: config.email.provider === 'none' ? null : (emailProvider ?? email),
    pushProvider: pushProvider ?? null,
    realtime,
    inMemoryRateLimits: true,
  });
  const app = createApp({
    config,
    logger,
    healthChecks: healthChecks ?? {
      mongodb: async () => {},
      redis: async () => {},
    },
    container,
  });
  return { app, lines, sms, email, realtime, redis: redisClient, container, config };
}

/** Connects mongoose to the in-memory replica set using a database unique to the test file. */
export async function connectTestDb() {
  await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID().slice(0, 8)}` });
  await Promise.all(ALL_MODELS.map((model) => model.init()));
}

export async function resetTestDb() {
  await Promise.all(ALL_MODELS.map((model) => model.deleteMany({})));
}

const ALL_MODELS = [User, Device, Session, OneTimePreKey, Message, MessageEnvelope, Counter];

/** Every document in every collection, as one JSON string (for leak scanning). */
export async function dumpDatabase() {
  const collections = await mongoose.connection.db.collections();
  const docs = await Promise.all(collections.map((c) => c.find({}).toArray()));
  return JSON.stringify(docs);
}

export async function disconnectTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export function newDevice(overrides = {}) {
  return { deviceId: randomUUID(), platform: 'android', name: 'Test Phone', ...overrides };
}

/** Full OTP login; returns the verify response body. */
export async function login(ctx, phoneNumber, device = newDevice()) {
  const requested = await request(ctx.app).post('/auth/otp/request').send({ phoneNumber });
  if (requested.status !== 202) {
    throw new Error(`OTP request failed: ${requested.status} ${JSON.stringify(requested.body)}`);
  }
  const res = await request(ctx.app)
    .post('/auth/otp/verify')
    .send({ phoneNumber, otp: ctx.sms.lastOtp(phoneNumber), device });
  if (res.status !== 200) {
    throw new Error(`OTP verify failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { ...res.body, device };
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Removes OTP resend cooldowns so a test can request another code immediately. */
export async function clearCooldowns(redis) {
  const keys = await redis.keys('otp:cd:*');
  if (keys.length > 0) await redis.del(...keys);
}
