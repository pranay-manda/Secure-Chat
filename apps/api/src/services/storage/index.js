import { ATTACHMENT } from '@secure-chat/shared/constants';

import { createLocalStorage } from './local.js';

/**
 * Attachment (encrypted blob) storage. Interface:
 *
 *   newStorageKey()                  -> random key for a new blob
 *   uploadTarget(storageKey, size)   -> { url, method, headers, expiresAt } (pre-signed)
 *   downloadTarget(storageKey)       -> { url, method, headers, expiresAt } (pre-signed)
 *   stat(storageKey)                 -> { size } | null
 *   remove(storageKey)               -> idempotent delete
 *   router?({ sizeOf })              -> Express router for drivers that serve transfers
 *
 * `local` (API host disk) is the only driver so far. An S3-compatible driver (Cloudflare R2,
 * AWS S3) implements the same interface with pre-signed URLs; see docs/ARCHITECTURE.md.
 *
 * @param {{ driver: 'local', dir: string }} config
 */
export function createAttachmentStorage(config) {
  switch (config.driver) {
    case 'local':
      return createLocalStorage({
        dir: config.dir,
        urlTtlSeconds: ATTACHMENT.TRANSFER_URL_TTL_SECONDS,
      });
    default:
      throw new Error(`Unknown attachment storage: ${config.driver}`);
  }
}
