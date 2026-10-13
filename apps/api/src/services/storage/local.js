import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { ERROR_CODE } from '@secure-chat/shared/constants';
import { Router } from 'express';

/** Storage keys are 32 random bytes in hex: never a path, never derived from user input. */
const STORAGE_KEY = /^[a-f0-9]{64}$/;

class BlobError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Attachment storage on the API host's own disk (development, or a single-instance deployment
 * with a persistent volume). It holds only encrypted blobs.
 *
 * Transfers use the same contract as S3 pre-signed URLs, so the app does not care which storage
 * is behind them: `PUT|GET /blobs/<storageKey>?exp=<unix seconds>&sig=<HMAC>`, no bearer token.
 * The signature binds the operation, the key, the expiry and (for uploads) the exact byte count.
 * The signing key is random per process: URLs are short-lived, and a restart only makes the app
 * ask for a fresh URL. More than one API instance cannot share this storage.
 *
 * @param {{ dir: string, urlTtlSeconds: number }} options
 */
export function createLocalStorage({ dir, urlTtlSeconds }) {
  const root = path.resolve(dir);
  const signingKey = randomBytes(32);
  const fileOf = (storageKey) => {
    if (!STORAGE_KEY.test(storageKey)) throw new BlobError(404, ERROR_CODE.NOT_FOUND, 'Not found');
    return path.join(root, storageKey);
  };
  const sign = (op, storageKey, exp, size = '') =>
    createHmac('sha256', signingKey)
      .update(`${op}\n${storageKey}\n${exp}\n${size}`)
      .digest('base64url');
  const expiry = () => Math.floor(Date.now() / 1000) + urlTtlSeconds;
  const target = (op, storageKey, size) => {
    const exp = expiry();
    return {
      url: `/blobs/${storageKey}?exp=${exp}&sig=${sign(op, storageKey, exp, size)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  };

  function verify(op, storageKey, query, size) {
    const exp = Number(query.exp);
    if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) {
      throw new BlobError(403, ERROR_CODE.FORBIDDEN, 'Link expired');
    }
    const expected = Buffer.from(sign(op, storageKey, exp, size));
    const given = Buffer.from(typeof query.sig === 'string' ? query.sig : '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new BlobError(403, ERROR_CODE.FORBIDDEN, 'Invalid link');
    }
  }

  return {
    kind: 'local',
    newStorageKey: () => randomBytes(32).toString('hex'),

    /** Where and how the app uploads exactly `size` bytes. */
    uploadTarget(storageKey, size) {
      return {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        ...target('put', storageKey, size),
      };
    },

    downloadTarget(storageKey) {
      return { method: 'GET', headers: {}, ...target('get', storageKey) };
    },

    /** `{ size }` of a stored blob, or null if there is none. */
    async stat(storageKey) {
      try {
        const info = await stat(fileOf(storageKey));
        return info.isFile() ? { size: info.size } : null;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    /** Idempotent. */
    async remove(storageKey) {
      await rm(fileOf(storageKey), { force: true });
    },

    /**
     * The upload/download endpoints behind the signed URLs. `sizeOf(storageKey)` returns the
     * byte count the uploader declared (null for an unknown key).
     */
    router({ sizeOf }) {
      const router = Router();

      router.put('/:storageKey', async (req, res) => {
        const { storageKey } = req.params;
        const file = fileOf(storageKey);
        const size = await sizeOf(storageKey);
        if (size === null) throw new BlobError(404, ERROR_CODE.NOT_FOUND, 'Not found');
        verify('put', storageKey, req.query, size);
        if (Number(req.headers['content-length']) !== size) {
          throw new BlobError(400, ERROR_CODE.VALIDATION_ERROR, 'Content-Length must match');
        }

        await mkdir(root, { recursive: true });
        const partial = `${file}.${randomBytes(8).toString('hex')}.part`;
        let received = 0;
        const counter = new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (received > size) {
              callback(new BlobError(413, ERROR_CODE.PAYLOAD_TOO_LARGE, 'Too large'));
            } else callback(null, chunk);
          },
        });
        try {
          await pipeline(req, counter, createWriteStream(partial, { flags: 'wx' }));
          if (received !== size) {
            throw new BlobError(400, ERROR_CODE.VALIDATION_ERROR, 'Upload incomplete');
          }
          // Atomic: a blob is either absent or complete. A retry simply replaces it.
          await rename(partial, file);
        } catch (err) {
          await rm(partial, { force: true });
          throw err instanceof BlobError
            ? err
            : new BlobError(400, ERROR_CODE.VALIDATION_ERROR, 'Upload interrupted');
        }
        res.status(200).end();
      });

      router.get('/:storageKey', async (req, res) => {
        const { storageKey } = req.params;
        const file = fileOf(storageKey);
        verify('get', storageKey, req.query);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) throw new BlobError(404, ERROR_CODE.NOT_FOUND, 'Not found');
        res.status(200).set({
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
        });
        await pipeline(createReadStream(file), res);
      });

      // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
      router.use((err, req, res, next) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (err instanceof BlobError) {
          res.status(err.status).json({ error: { code: err.code, message: err.message } });
          return;
        }
        req.log?.error({ err }, 'Blob transfer failed');
        res
          .status(500)
          .json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
      });
      return router;
    },
  };
}
