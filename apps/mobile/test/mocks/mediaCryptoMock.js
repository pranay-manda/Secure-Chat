/**
 * Node implementation of the MediaCrypto native contract (modules/media-crypto, Android uses
 * libsignal's AES-256-GCM). Same blob format, padding, associated data, digest and path rules,
 * built on Node's AES-256-GCM, so interoperability and failure handling can be tested.
 *
 *   blob = nonce (12) || AES-256-GCM(key, nonce, aad, plaintext || zeros) || tag (16)
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { paddedAttachmentSize, ATTACHMENT } = require('@secure-chat/shared/constants');
const { deviceRoot } = require('./fileSystemMock');

const AAD = Buffer.from('SecureChat attachment v1', 'ascii');

function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Mirrors MediaCryptoModule.privateFile: only the device's files/ and cache/ directories. */
function privatePath(uri) {
  const p = path.resolve(uri.startsWith('file://') ? decodeURI(uri.slice(7)) : uri);
  const roots = ['files', 'cache'].map((d) => path.join(deviceRoot(), d) + path.sep);
  if (!roots.some((root) => p.startsWith(root))) {
    throw coded('ERR_MEDIA_PATH', 'Only files inside the app private storage can be used');
  }
  return p;
}

const calls = () => (globalThis.__device.mediaCryptoCalls ??= []);

function open(blobPath, keyB64, digestB64, size) {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== ATTACHMENT.KEY_BYTES || size < 0 || size > ATTACHMENT.MAX_BYTES) {
    throw coded('ERR_MEDIA_INTEGRITY', 'damaged');
  }
  const blob = fs.existsSync(blobPath) ? fs.readFileSync(blobPath) : null;
  if (!blob || blob.length !== paddedAttachmentSize(size) + ATTACHMENT.OVERHEAD_BYTES) {
    throw coded('ERR_MEDIA_INTEGRITY', 'damaged');
  }
  const digestOk = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(blob).digest(),
    Buffer.from(digestB64, 'base64').length === 32
      ? Buffer.from(digestB64, 'base64')
      : Buffer.alloc(32),
  );
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(blob.subarray(12, blob.length - 16)),
      decipher.final(),
    ]);
  } catch {
    throw coded('ERR_MEDIA_INTEGRITY', 'damaged');
  }
  if (!digestOk) throw coded('ERR_MEDIA_INTEGRITY', 'damaged');
  return plaintext.subarray(0, size);
}

const mediaCryptoMock = {
  async encryptFile(sourceUri, destUri, stripLocation) {
    const source = privatePath(sourceUri);
    const dest = privatePath(destUri);
    calls().push({ fn: 'encryptFile', stripLocation });
    if (!fs.existsSync(source)) throw coded('ERR_MEDIA_SIZE', 'The file to send does not exist');
    const plaintext = fs.readFileSync(source);
    if (plaintext.length === 0 || plaintext.length > ATTACHMENT.MAX_BYTES) {
      throw coded('ERR_MEDIA_SIZE', 'Unsupported file size');
    }
    const padded = Buffer.alloc(paddedAttachmentSize(plaintext.length));
    plaintext.copy(padded);
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(AAD);
    const blob = Buffer.concat([nonce, cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, blob);
    return {
      key: key.toString('base64'),
      digest: crypto.createHash('sha256').update(blob).digest('base64'),
      size: plaintext.length,
      encryptedSize: blob.length,
    };
  },

  async verifyFile(uri, key, digest, size) {
    calls().push({ fn: 'verifyFile' });
    open(privatePath(uri), key, digest, size);
    return true;
  },

  async decryptFile(uri, key, digest, size, destUri) {
    const dest = privatePath(destUri);
    calls().push({ fn: 'decryptFile' });
    try {
      const plaintext = open(privatePath(uri), key, digest, size);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, plaintext);
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw err;
    }
    return true;
  },
};

module.exports = { mediaCryptoMock, AAD };
