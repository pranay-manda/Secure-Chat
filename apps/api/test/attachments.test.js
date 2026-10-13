import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ATTACHMENT_MAX_ENCRYPTED_BYTES } from '@secure-chat/shared/constants';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Attachment, ATTACHMENT_RETENTION } from '../src/models/Attachment.js';
import {
  bearer,
  buildTestApp,
  connectTestDb,
  disconnectTestDb,
  dumpDatabase,
  login,
  newDevice,
  resetTestDb,
} from './helpers.js';

/**
 * Encrypted attachments: the phone uploads an already-encrypted blob through a pre-signed URL
 * and sends the media key to the recipient over Signal. The API never sees a key, a file type or
 * plaintext; it enforces who may upload and download, exact sizes, idempotent retries and
 * retention. Storage here is the `local` driver on a temporary directory.
 */
const ALICE = '+919876543210';
const BOB = '+919812345678';
const CAROL = '+919811100000';

let ctx;
let dir;
let alice;
let bob;
let carol;

async function makeUser(phone) {
  const session = await login(ctx, phone, newDevice());
  return {
    id: session.user.id,
    deviceId: session.device.deviceId,
    token: session.tokens.accessToken,
  };
}

const api = (user) => ({
  get: (p) => request(ctx.app).get(p).set(bearer(user.token)),
  post: (p, body) => request(ctx.app).post(p).set(bearer(user.token)).send(body),
  delete: (p) => request(ctx.app).delete(p).set(bearer(user.token)),
});

const blob = (size = 2048) => randomBytes(size);

async function create(user, recipient, size, clientAttachmentId = randomUUID()) {
  return api(user).post('/attachments', {
    clientAttachmentId,
    recipientUserId: recipient.id,
    size,
  });
}

const put = (url, bytes) =>
  request(ctx.app).put(url).set('Content-Type', 'application/octet-stream').send(bytes);

/** Creates, uploads and completes one attachment from `from` to `to`. */
async function upload(from, to, bytes = blob()) {
  const created = await create(from, to, bytes.length);
  expect(created.status).toBe(201);
  await put(created.body.upload.url, bytes).expect(200);
  const done = await api(from).post(`/attachments/${created.body.attachmentId}/complete`);
  expect(done.status).toBe(200);
  return { id: created.body.attachmentId, bytes };
}

async function download(user, id) {
  const res = await api(user).get(`/attachments/${id}`);
  if (res.status !== 200) return { status: res.status, body: res.body };
  const file = await request(ctx.app)
    .get(res.body.download.url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { status: file.status, bytes: file.body, target: res.body.download };
}

const storedBlobs = async () => (await readdir(dir).catch(() => [])).sort();

beforeAll(async () => {
  await connectTestDb();
  dir = await mkdtemp(path.join(tmpdir(), 'sc-attachments-'));
});
afterAll(async () => {
  await disconnectTestDb();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetTestDb();
  ctx = buildTestApp({ env: { ATTACHMENT_STORAGE_DIR: dir, SMS_PROVIDER: 'console' } });
  await ctx.redis.flushall(); // OTP cooldowns and rate-limit state from earlier tests
  [alice, bob, carol] = [await makeUser(ALICE), await makeUser(BOB), await makeUser(CAROL)];
});
afterEach(async () => {
  vi.useRealTimers();
  for (const name of await storedBlobs()) await rm(path.join(dir, name), { force: true });
});

describe('upload → complete → download', () => {
  it('the recipient downloads exactly the encrypted bytes the sender uploaded', async () => {
    const { id, bytes } = await upload(alice, bob, blob(5000));
    const got = await download(bob, id);
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.bytes, bytes)).toBe(0);
    // Stored as one opaque file named by a random key, nothing else.
    const files = await storedBlobs();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.compare(await readFile(path.join(dir, files[0])), bytes)).toBe(0);
  });

  it('returns relative, short-lived signed URLs and no bearer token in them', async () => {
    const created = await create(alice, bob, 2048);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', size: 2048 });
    const { upload: target } = created.body;
    expect(target.method).toBe('PUT');
    expect(target.url).toMatch(/^\/blobs\/[a-f0-9]{64}\?exp=\d+&sig=[\w-]+$/);
    const ttl = Date.parse(target.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(target.url).not.toContain(alice.token);
  });

  it('the uploader may download its own attachment (e.g. after reinstalling the app)', async () => {
    const { id, bytes } = await upload(alice, bob);
    const got = await download(alice, id);
    expect(Buffer.compare(got.bytes, bytes)).toBe(0);
  });
});

describe('request validation: the server never receives keys, types or names', () => {
  it.each([
    ['a media key', { key: 'a'.repeat(44) }],
    ['a content type', { contentType: 'image/jpeg' }],
    ['a file name', { fileName: 'holiday.jpg' }],
  ])('rejects an upload request carrying %s', async (_label, extra) => {
    const res = await api(alice).post('/attachments', {
      clientAttachmentId: randomUUID(),
      recipientUserId: bob.id,
      size: 2048,
      ...extra,
    });
    expect(res.status).toBe(400);
    expect(await Attachment.countDocuments()).toBe(0);
  });

  it('enforces the size limit (largest encrypted blob of a 100 MiB file)', async () => {
    expect((await create(alice, bob, ATTACHMENT_MAX_ENCRYPTED_BYTES)).status).toBe(201);
    expect((await create(alice, bob, ATTACHMENT_MAX_ENCRYPTED_BYTES + 1)).status).toBe(400);
    expect((await create(alice, bob, 0)).status).toBe(400);
    expect((await create(alice, bob, 1.5)).status).toBe(400);
  });

  it('refuses sending to yourself and to unknown users', async () => {
    expect((await create(alice, alice, 2048)).status).toBe(400);
    const unknown = { id: 'cccccccccccccccccccccccc' };
    const res = await create(alice, unknown, 2048);
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request(ctx.app)
      .post('/attachments')
      .send({ clientAttachmentId: randomUUID(), recipientUserId: bob.id, size: 2048 });
    expect(res.status).toBe(401);
  });
});

describe('retries never create duplicate attachments', () => {
  it('the same clientAttachmentId returns the same attachment and a fresh upload URL', async () => {
    const clientAttachmentId = randomUUID();
    const first = await create(alice, bob, 2048, clientAttachmentId);
    const again = await create(alice, bob, 2048, clientAttachmentId);
    expect(again.status).toBe(201);
    expect(again.body.attachmentId).toBe(first.body.attachmentId);
    expect(await Attachment.countDocuments()).toBe(1);
  });

  it('concurrent retries resolve to one attachment', async () => {
    const clientAttachmentId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(alice, bob, 2048, clientAttachmentId)),
    );
    expect(new Set(results.map((r) => r.body.attachmentId)).size).toBe(1);
    expect(await Attachment.countDocuments()).toBe(1);
  });

  it('reusing a clientAttachmentId for another recipient or size is refused', async () => {
    const clientAttachmentId = randomUUID();
    await create(alice, bob, 2048, clientAttachmentId);
    expect((await create(alice, carol, 2048, clientAttachmentId)).status).toBe(409);
    expect((await create(alice, bob, 4096, clientAttachmentId)).status).toBe(409);
  });

  it('a retry after completion says it is uploaded (no new upload URL) and keeps one blob', async () => {
    const clientAttachmentId = randomUUID();
    const bytes = blob();
    const created = await create(alice, bob, bytes.length, clientAttachmentId);
    await put(created.body.upload.url, bytes).expect(200);
    await put(created.body.upload.url, bytes).expect(200); // re-upload replaces, idempotent
    await api(alice).post(`/attachments/${created.body.attachmentId}/complete`).expect(200);
    await api(alice).post(`/attachments/${created.body.attachmentId}/complete`).expect(200);
    const again = await create(alice, bob, bytes.length, clientAttachmentId);
    expect(again.body).toMatchObject({
      attachmentId: created.body.attachmentId,
      status: 'uploaded',
    });
    expect(again.body.upload).toBeUndefined();
    expect(await storedBlobs()).toHaveLength(1);
  });
});

describe('signed transfer URLs', () => {
  it('rejects a tampered signature, expiry or key', async () => {
    const created = await create(alice, bob, 2048);
    const url = new URL(created.body.upload.url, 'http://x');
    const tampered = (mutate) => {
      const u = new URL(url);
      mutate(u);
      return `${u.pathname}${u.search}`;
    };
    await put(
      tampered((u) => u.searchParams.set('sig', 'A'.repeat(43))),
      blob(),
    ).expect(403);
    await put(
      tampered((u) => u.searchParams.set('exp', String(Number(u.searchParams.get('exp')) + 60))),
      blob(),
    ).expect(403);
    await put(
      tampered((u) => u.searchParams.delete('sig')),
      blob(),
    ).expect(403);
    const other = await create(alice, bob, 2048);
    const otherKey = new URL(other.body.upload.url, 'http://x').pathname;
    await put(`${otherKey}${url.search}`, blob()).expect(403);
    await put('/blobs/..%2F..%2Fetc?exp=1&sig=x', blob()).expect(404);
    expect(await storedBlobs()).toHaveLength(0);
  });

  it('an upload URL expires', async () => {
    const created = await create(alice, bob, 2048);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await put(created.body.upload.url, blob()).expect(403);
  });

  it('accepts exactly the declared number of bytes', async () => {
    const created = await create(alice, bob, 2048);
    await put(created.body.upload.url, blob(3000)).expect(400);
    await put(created.body.upload.url, blob(1000)).expect(400);
    expect(await storedBlobs()).toHaveLength(0);
    await put(created.body.upload.url, blob(2048)).expect(200);
  });

  it('a download URL cannot be used to upload, nor an upload URL to download', async () => {
    const { id } = await upload(alice, bob);
    const { target } = await download(bob, id);
    await put(target.url, blob()).expect(404); // completed: no pending upload behind the key
    const created = await create(alice, bob, 2048);
    await request(ctx.app).get(created.body.upload.url).expect(403);
  });

  it('an interrupted upload stores nothing, cannot be completed, and can be retried', async () => {
    const created = await create(alice, bob, 4096);
    const server = ctx.app.listen(0);
    try {
      const { port } = server.address();
      await new Promise((resolve) => {
        const req = http.request({
          port,
          method: 'PUT',
          path: created.body.upload.url,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 4096 },
        });
        req.on('error', resolve);
        req.on('response', resolve);
        req.write(blob(1500));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 100);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      server.close();
    }
    // Neither a blob nor a partial file is left behind.
    expect(await storedBlobs()).toHaveLength(0);
    const early = await api(alice).post(`/attachments/${created.body.attachmentId}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ATTACHMENT_INCOMPLETE');

    // The retry uses the same attachment (and here the same, still valid URL).
    await put(created.body.upload.url, blob(4096)).expect(200);
    await api(alice).post(`/attachments/${created.body.attachmentId}/complete`).expect(200);
  });
});

describe('authorization', () => {
  it('only the recipient and the uploader can download; others get the same 404 as a missing id', async () => {
    const { id } = await upload(alice, bob);
    const asCarol = await api(carol).get(`/attachments/${id}`);
    const missing = await api(carol).get('/attachments/cccccccccccccccccccccccc');
    expect(asCarol.status).toBe(404);
    expect(asCarol.body).toEqual(missing.body);
  });

  it('nothing is downloadable before the upload is complete', async () => {
    const created = await create(alice, bob, 2048);
    await put(created.body.upload.url, blob()).expect(200);
    expect((await api(bob).get(`/attachments/${created.body.attachmentId}`)).status).toBe(404);
  });

  it('only the uploading device can complete an upload', async () => {
    const created = await create(alice, bob, 2048);
    await put(created.body.upload.url, blob()).expect(200);
    expect((await api(bob).post(`/attachments/${created.body.attachmentId}/complete`)).status).toBe(
      404,
    );
  });

  it('only the recipient can confirm receipt', async () => {
    const { id } = await upload(alice, bob);
    expect((await api(alice).post(`/attachments/${id}/received`)).status).toBe(404);
    expect((await api(carol).post(`/attachments/${id}/received`)).status).toBe(404);
    expect((await api(bob).post(`/attachments/${id}/received`)).status).toBe(204);
  });

  it('rejects malformed ids', async () => {
    expect((await api(bob).get('/attachments/not-an-id')).status).toBe(400);
  });
});

describe('retention', () => {
  it('confirmed receipt shortens retention to the grace period; repeating it is harmless', async () => {
    const { id } = await upload(alice, bob);
    const before = await Attachment.findById(id).lean();
    expect(before.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      ATTACHMENT_RETENTION.UPLOADED_MS - 60_000,
    );
    await api(bob).post(`/attachments/${id}/received`).expect(204);
    await api(bob).post(`/attachments/${id}/received`).expect(204);
    const after = await Attachment.findById(id).lean();
    expect(after.downloadedAt).toBeInstanceOf(Date);
    expect(after.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      ATTACHMENT_RETENTION.DOWNLOADED_MS,
    );
  });

  it('the sweep deletes expired blobs and their metadata, and nothing else', async () => {
    const kept = await upload(alice, bob);
    const old = await upload(alice, bob);
    const abandoned = await create(alice, bob, 2048);
    await put(abandoned.body.upload.url, blob()).expect(200); // uploaded but never completed
    expect(await storedBlobs()).toHaveLength(3);

    const past = new Date(Date.now() - 1000);
    await Attachment.updateOne({ _id: old.id }, { $set: { expiresAt: past } });
    await Attachment.updateOne({ _id: abandoned.body.attachmentId }, { $set: { expiresAt: past } });
    expect(await ctx.container.attachmentService.sweepExpired()).toBe(2);

    expect(await storedBlobs()).toHaveLength(1);
    expect(await Attachment.countDocuments()).toBe(1);
    expect((await download(bob, kept.id)).status).toBe(200);
    expect((await api(bob).get(`/attachments/${old.id}`)).status).toBe(404);
  });

  it('an expired attachment is not downloadable even before the sweep runs', async () => {
    const { id } = await upload(alice, bob);
    await Attachment.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    const res = await api(bob).get(`/attachments/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('account deletion removes attachments sent to the user, keeps those they sent to others', async () => {
    const toBob = await upload(alice, bob);
    const fromBob = await upload(bob, carol);
    const bobPending = await create(bob, carol, 2048);
    await api(bob).delete('/account').expect(204);

    expect(await Attachment.findById(toBob.id)).toBeNull();
    expect(await Attachment.findById(bobPending.body.attachmentId)).toBeNull();
    expect((await download(carol, fromBob.id)).status).toBe(200);
    expect(await storedBlobs()).toHaveLength(1);
  });
});

describe('abuse and privacy', () => {
  it('limits new uploads per user by encrypted megabytes per hour', async () => {
    const size = ATTACHMENT_MAX_ENCRYPTED_BYTES; // ~100 MiB each, 2,048 MiB per hour
    const statuses = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await create(alice, bob, size)).status);
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
    // Retrying an existing upload costs nothing.
    const clientAttachmentId = randomUUID();
    expect((await create(bob, alice, 2048, clientAttachmentId)).status).toBe(201);
  });

  it('logs never contain transfer signatures, and the database holds no blob bytes', async () => {
    const bytes = Buffer.from('E2EE-CIPHERTEXT-MARKER'.repeat(100));
    const { id } = await upload(alice, bob, bytes);
    await download(bob, id);
    const logs = JSON.stringify(ctx.lines);
    expect(logs).not.toMatch(/sig=/);
    expect(logs).not.toMatch(/exp=/);
    expect(await dumpDatabase()).not.toContain('E2EE-CIPHERTEXT-MARKER');
  });
});
