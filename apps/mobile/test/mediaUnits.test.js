import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ATTACHMENT, paddedAttachmentSize } from '@secure-chat/shared/constants';

import { AAD, mediaCryptoMock } from './mocks/mediaCryptoMock';

/**
 * Small pieces of the media pipeline: transfer URL rules, app-cache detection, MIME handling,
 * and parity between the Android MediaCrypto module and the Node test double used everywhere
 * else (same functions, associated data and padding), so the tests exercise the real contract.
 */
const KOTLIN = readFileSync(
  path.join(
    __dirname,
    '../modules/media-crypto/android/src/main/java/expo/modules/mediacrypto/MediaCryptoModule.kt',
  ),
  'utf8',
);

describe('transfer URLs', () => {
  const { resolveTransferUrl } = require('../src/media/transfer');

  it('relative URLs belong to the API (local storage driver)', () => {
    expect(resolveTransferUrl('/blobs/abc?exp=1&sig=x')).toBe(
      'http://api.test/blobs/abc?exp=1&sig=x',
    );
  });

  it('release builds refuse plain-http or protocol-relative storage URLs', () => {
    const dev = global.__DEV__;
    global.__DEV__ = false;
    try {
      expect(() => resolveTransferUrl('http://storage.example.com/x')).toThrow();
      expect(() => resolveTransferUrl('https://localhost/x')).toThrow();
      expect(() => resolveTransferUrl('//storage.example.com/x')).toThrow();
      expect(resolveTransferUrl('https://bucket.r2.example.com/x?sig=1')).toBe(
        'https://bucket.r2.example.com/x?sig=1',
      );
    } finally {
      global.__DEV__ = dev;
    }
  });

  it('refuses a missing URL', () => {
    expect(() => resolveTransferUrl('')).toThrow();
    expect(() => resolveTransferUrl(undefined)).toThrow();
  });
});

describe('media files', () => {
  const files = require('../src/media/mediaFiles');
  const { Paths } = require('expo-file-system');

  it('recognises only the app cache as its own copies (no path tricks)', () => {
    const cache = Paths.cache.uri;
    expect(files.isAppCacheFile(`${cache}ImagePicker/a.jpg`)).toBe(true);
    expect(files.isAppCacheFile(`${cache}../files/attachments/x.bin`)).toBe(false);
    expect(files.isAppCacheFile(`${Paths.document.uri}attachments/x.bin`)).toBe(false);
    expect(files.isAppCacheFile('file:///sdcard/DCIM/Camera/IMG_1.jpg')).toBe(false);
    expect(files.isAppCacheFile(null)).toBe(false);
  });

  it('temporary plaintext names never come from user input', () => {
    const file = files.newPlaintextFile('../../evil');
    expect(file.uri).toMatch(/\/cache\/secure-media\/[0-9a-f-]{36}\.bin$/);
    expect(files.newPlaintextFile('jpg').uri).toMatch(/\.jpg$/);
  });
});

describe('media kinds', () => {
  const { mediaKindOf, extensionFor } = require('../src/media/attachmentService');
  it.each([
    ['image/jpeg', 'image'],
    ['VIDEO/MP4', 'video'],
    ['audio/mp4', 'audio'],
    ['application/pdf', null],
    ['image', null],
    [undefined, null],
  ])('%s -> %s', (type, kind) => expect(mediaKindOf(type)).toBe(kind));

  it('maps types to viewer file extensions, with a safe default', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor('audio/mp4')).toBe('m4a');
    expect(extensionFor('application/x-evil')).toBe('bin');
  });
});

describe('MediaCrypto: Android module and test double agree', () => {
  it('exposes the same functions', () => {
    const native = [...KOTLIN.matchAll(/AsyncFunction\("(\w+)"\)/g)].map((m) => m[1]).sort();
    expect(native).toEqual(Object.keys(mediaCryptoMock).sort());
  });

  it('uses the same associated data, key/nonce/tag sizes and padding', () => {
    expect(KOTLIN).toContain(`"${AAD.toString('ascii')}"`);
    expect(KOTLIN).toMatch(new RegExp(`KEY_BYTES = ${ATTACHMENT.KEY_BYTES}\\b`));
    expect(KOTLIN).toMatch(new RegExp(`NONCE_BYTES = ${ATTACHMENT.NONCE_BYTES}\\b`));
    expect(KOTLIN).toMatch(new RegExp(`TAG_BYTES = ${ATTACHMENT.TAG_BYTES}\\b`));
    expect(KOTLIN).toMatch(new RegExp(`MIN_PADDED_BYTES = ${ATTACHMENT.MIN_PADDED_BYTES}L`));
    expect(KOTLIN).toContain('exponent - 4'); // 16 buckets per power of two, like the JS
    expect(KOTLIN).toContain('Aes256GcmEncryption');
    expect(KOTLIN).toContain('verifyTag');
  });

  it('the Kotlin padding formula matches paddedAttachmentSize for sample sizes', () => {
    // Re-implements the Kotlin integer formula literally to guard against drift.
    const kotlin = (size) => {
      if (size <= 1024) return 1024;
      const exponent = 63 - (64 - BigInt(size).toString(2).length);
      const step = 2 ** (exponent - 4);
      return Math.floor((size + step - 1) / step) * step;
    };
    for (const size of [1, 1024, 1025, 4096, 70_000, 3_000_000, ATTACHMENT.MAX_BYTES]) {
      expect(kotlin(size)).toBe(paddedAttachmentSize(size));
    }
  });

  it('refuses paths outside the app’s private storage', async () => {
    await expect(
      mediaCryptoMock.encryptFile('file:///sdcard/DCIM/a.jpg', 'file:///sdcard/out.bin', false),
    ).rejects.toMatchObject({ code: 'ERR_MEDIA_PATH' });
    expect(KOTLIN).toContain('context.filesDir, context.cacheDir');
  });
});

describe('voice-note waveform', () => {
  const {
    decodeWaveform,
    encodeWaveform,
    levelFromDb,
    resampleLevels,
    WAVEFORM_BARS,
  } = require('../src/media/waveform');

  it('maps microphone dBFS to 0…1 (silence 0, loud 1), ignoring bad values', () => {
    expect(levelFromDb(-160)).toBe(0);
    expect(levelFromDb(-50)).toBe(0);
    expect(levelFromDb(-25)).toBeCloseTo(0.5);
    expect(levelFromDb(0)).toBe(1);
    expect(levelFromDb(undefined)).toBe(0);
    expect(levelFromDb(Number.NaN)).toBe(0);
  });

  it('compresses samples into at most 48 bars (peaks kept) and decodes back', () => {
    const samples = Array.from({ length: 300 }, (_, i) => (i % 50 === 0 ? 1 : 0.2));
    const text = encodeWaveform(samples);
    expect(text).toHaveLength(WAVEFORM_BARS);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    const levels = decodeWaveform(text);
    expect(Math.max(...levels)).toBe(1); // short loud peaks survive
    expect(Math.min(...levels)).toBeCloseTo(0.2, 1);
  });

  it('short recordings, no samples and malformed strings', () => {
    expect(encodeWaveform([0.5, 1])).toHaveLength(WAVEFORM_BARS);
    expect(encodeWaveform([])).toBeNull();
    expect(decodeWaveform(null)).toBeNull();
    expect(decodeWaveform('')).toBeNull();
    expect(decodeWaveform('not valid!')).toBeNull();
    expect(decodeWaveform('A'.repeat(65))).toBeNull();
    expect(resampleLevels(null, 4)).toEqual([0, 0, 0, 0]);
    expect(resampleLevels([0, 1], 4)).toEqual([0, 0, 1, 1]);
  });

  it('travels in the encrypted attachment content; a malformed one is rejected', () => {
    const { attachmentContent, decodeContent, encodeContent } = require('../src/messaging/content');
    const base = {
      id: 'att_0123456789abcdef',
      key: Buffer.alloc(32, 1).toString('base64'),
      digest: Buffer.alloc(32, 2).toString('base64'),
      size: 1000,
      contentType: 'audio/mp4',
      voiceNote: true,
    };
    const decoded = decodeContent(
      encodeContent(attachmentContent({ ...base, waveform: 'AAgg__' })),
    );
    expect(decoded).toMatchObject({ ok: true, content: { waveform: 'AAgg__', voiceNote: true } });
    expect(() => encodeContent(attachmentContent({ ...base, waveform: 'bad wave!' }))).toThrow();
  });
});
