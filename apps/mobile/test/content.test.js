/* global jest */
import {
  CONTENT_ERROR,
  CONTENT_LIMITS,
  CONTENT_MARKER,
  ContentError,
  decodeContent,
  encodeContent,
  textContent,
} from '../src/messaging/content';
import { loadApp, mockApi, resetDevice, signIn } from './helpers';

/**
 * Versioned message content (R1): what goes inside a Signal message. Encoding and strict
 * validation here, plus how the chat shows content it cannot display. The end-to-end path
 * (through real libsignal, two app instances and the fake API) is in messaging.test.js.
 */
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  Stack: { Screen: () => null },
  usePathname: () => '/',
  useLocalSearchParams: () => globalThis.__routeParams ?? {},
  useFocusEffect: (effect) => require('react').useEffect(() => effect(), [effect]),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const utf8 = (text) => new TextEncoder().encode(text);
/** Typed content as any app version could send it: the marker, then arbitrary bytes or JSON. */
const typed = (json) => {
  const body = typeof json === 'string' ? utf8(json) : utf8(JSON.stringify(json));
  const bytes = new Uint8Array(body.length + 1);
  bytes[0] = CONTENT_MARKER;
  bytes.set(body, 1);
  return bytes;
};

const KEY = Buffer.alloc(32, 7).toString('base64');
const DIGEST = Buffer.alloc(32, 9).toString('base64');
const attachment = (fields = {}) => ({
  type: 'attachment',
  version: 1,
  id: 'AbCdEfGhIjKlMnOp',
  key: KEY,
  digest: DIGEST,
  size: 12_345,
  contentType: 'image/jpeg',
  fileName: 'holiday.jpg',
  width: 800,
  height: 600,
  blurHash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  ...fields,
});

const hexBytes = (n) =>
  Array.from({ length: n }, (_, i) => ((i * 37) % 256).toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
const SHA256 = `sha-256 ${hexBytes(32)}`;
const attestation = (fields = {}) => ({
  type: 'call.dtls',
  version: 1,
  callId: '11111111-1111-4111-8111-111111111111',
  role: 'caller',
  from: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  to: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  kind: 'video',
  fingerprints: [SHA256],
  ...fields,
});

const refusal = (content) => {
  try {
    encodeContent(content);
  } catch (err) {
    return err instanceof ContentError ? err.code : 'NOT_A_CONTENT_ERROR';
  }
  return null;
};

describe('text (versioned)', () => {
  it('is the marker byte followed by JSON with an explicit type and version', () => {
    const text = 'Hello 👋 नमस्ते';
    const bytes = encodeContent(textContent(text));
    expect(bytes[0]).toBe(0xff);
    expect(JSON.parse(Buffer.from(bytes.subarray(1)).toString('utf8'))).toEqual({
      type: 'text',
      version: 1,
      text,
    });
    expect(decodeContent(bytes)).toEqual({
      ok: true,
      legacy: false,
      internal: false,
      content: { type: 'text', version: 1, text },
    });
  });

  it('refuses to encode text that could never be shown: empty, too long, wrong types, extra fields', () => {
    const max = CONTENT_LIMITS.TEXT_MAX_LENGTH;
    expect(refusal(textContent('x'.repeat(max)))).toBeNull();
    expect(refusal(textContent(''))).toBe(CONTENT_ERROR.INVALID);
    expect(refusal(textContent('x'.repeat(max + 1)))).toBe(CONTENT_ERROR.INVALID);
    expect(refusal({ type: 'text', version: 1, text: 42 })).toBe(CONTENT_ERROR.INVALID);
    expect(refusal({ type: 'text', version: 1, text: 'hi', html: '<b>' })).toBe(
      CONTENT_ERROR.INVALID,
    );
    expect(refusal({ type: 'text', version: 2, text: 'hi' })).toBe(CONTENT_ERROR.INVALID);
    expect(refusal({ type: 'poll', version: 1 })).toBe(CONTENT_ERROR.INVALID);
    expect(refusal(null)).toBe(CONTENT_ERROR.INVALID);
  });

  it('refuses to encode content over the byte limit (escaping can grow text well past its length)', () => {
    // 16,000 control characters are within the length limit but become 96 KB of JSON escapes.
    const text = '\u0001'.repeat(CONTENT_LIMITS.TEXT_MAX_LENGTH);
    expect(refusal(textContent(text))).toBe(CONTENT_ERROR.TOO_LARGE);
    // The chat input's 4,000 characters always fit, whatever they are.
    expect(refusal(textContent('\u0001'.repeat(4000)))).toBeNull();
    expect(refusal(textContent('😀'.repeat(2000)))).toBeNull();
  });
});

describe('legacy raw text (app versions before R1)', () => {
  it('any raw UTF-8 text is text, decoded exactly as before', () => {
    const samples = [
      'Hello',
      '',
      'नमस्ते 👋',
      // Old text that happens to look like typed or internal content is still just text.
      JSON.stringify(textContent('hi')),
      JSON.stringify(attestation()),
      '� replacement character',
    ];
    for (const text of samples) {
      expect(decodeContent(utf8(text))).toEqual({
        ok: true,
        legacy: true,
        internal: false,
        content: { type: 'text', version: 1, text },
      });
    }
  });

  it('UTF-8 never contains the marker byte, so no old text can be mistaken for typed content', () => {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 0x3f) {
      const bytes = utf8(`a${String.fromCodePoint(codePoint)}`);
      expect(bytes.includes(CONTENT_MARKER)).toBe(false);
    }
    expect(utf8('\uD800 lone surrogate').includes(CONTENT_MARKER)).toBe(false);
  });
});

describe('unknown types and versions', () => {
  it('a chat type or version this app does not know is unsupported (a placeholder, not raw JSON)', () => {
    expect(decodeContent(typed({ type: 'poll', version: 1, question: '?' }))).toEqual({
      ok: false,
      reason: 'unsupported',
      internal: false,
      type: 'poll',
      version: 1,
    });
    expect(decodeContent(typed({ type: 'text', version: 2, text: 'later' }))).toMatchObject({
      ok: false,
      reason: 'unsupported',
      internal: false,
      version: 2,
    });
    // Names of built-in object properties never resolve to a schema.
    for (const type of ['constructor', 'tostring', 'hasownproperty']) {
      expect(decodeContent(typed({ type, version: 1 }))).toMatchObject({ reason: 'unsupported' });
    }
  });

  it('an unknown internal type or version stays internal (never shown)', () => {
    expect(decodeContent(typed({ type: 'call.hangup', version: 1 }))).toMatchObject({
      ok: false,
      reason: 'unsupported',
      internal: true,
    });
    expect(decodeContent(typed({ ...attestation(), version: 2 }))).toMatchObject({
      ok: false,
      reason: 'unsupported',
      internal: true,
    });
  });
});

describe('malformed content', () => {
  const max = CONTENT_LIMITS.MAX_BYTES;
  const cases = [
    ['not JSON', typed('{"type":"text",'), 'json'],
    ['not valid UTF-8', Uint8Array.of(CONTENT_MARKER, 0xc3, 0x28), 'encoding'],
    ['an array', typed([]), 'shape'],
    ['null', typed('null'), 'shape'],
    ['a number', typed('42'), 'shape'],
    ['a string', typed('"text"'), 'shape'],
    ['no type', typed({ version: 1, text: 'x' }), 'header'],
    ['no version', typed({ type: 'text', text: 'x' }), 'header'],
    ['version as a string', typed({ type: 'text', version: '1', text: 'x' }), 'header'],
    ['fractional version', typed({ type: 'text', version: 1.5, text: 'x' }), 'header'],
    ['version 0', typed({ type: 'text', version: 0, text: 'x' }), 'header'],
    ['type not a name', typed({ type: 'Text', version: 1, text: 'x' }), 'header'],
    ['__proto__ as type', typed('{"type":"__proto__","version":1}'), 'header'],
    ['empty type', typed({ type: '', version: 1 }), 'header'],
    ['text missing', typed({ type: 'text', version: 1 }), 'fields'],
    ['text not a string', typed({ type: 'text', version: 1, text: 42 }), 'fields'],
    ['text empty', typed({ type: 'text', version: 1, text: '' }), 'fields'],
    ['text too long', typed(textContent('x'.repeat(CONTENT_LIMITS.TEXT_MAX_LENGTH + 1))), 'fields'],
    ['an unknown field', typed({ type: 'text', version: 1, text: 'x', html: '<b>' }), 'fields'],
    [
      'a __proto__ field',
      typed('{"type":"text","version":1,"text":"x","__proto__":{"polluted":true}}'),
      'fields',
    ],
    ['over the byte limit', typed(textContent('a'.repeat(max))), 'too_large'],
  ];

  it.each(cases)('%s: invalid, never thrown', (_, bytes, detail) => {
    expect(decodeContent(bytes)).toMatchObject({ ok: false, reason: 'invalid', detail });
    expect({}.polluted).toBeUndefined();
  });

  it('the byte limit is checked before anything is parsed', () => {
    const parse = jest.spyOn(JSON, 'parse');
    try {
      decodeContent(typed(textContent('a'.repeat(max))));
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});

describe('attachment (photo, video or voice note; AES-256-GCM file key)', () => {
  it('a valid attachment decodes (the chat shows it as media)', () => {
    expect(decodeContent(encodeContent(attachment()))).toEqual({
      ok: true,
      legacy: false,
      internal: false,
      content: attachment(),
    });
  });

  it.each([
    ['a 64-byte key (the earlier CBC+HMAC draft)', { key: Buffer.alloc(64).toString('base64') }],
    ['a 16-byte key', { key: Buffer.alloc(16).toString('base64') }],
    ['a short digest', { digest: Buffer.alloc(16).toString('base64') }],
    ['a negative size', { size: -1 }],
    ['an empty file', { size: 0 }],
    ['an oversized file', { size: CONTENT_LIMITS.ATTACHMENT_MAX_BYTES + 1 }],
    ['a content type without subtype', { contentType: 'image' }],
    ['a 256-character file name', { fileName: 'a'.repeat(256) }],
    ['zero width', { width: 0 }],
    ['an unknown field', { url: 'https://example.com/x' }],
    ['no key', { key: undefined }],
  ])('%s is invalid', (_, fields) => {
    expect(decodeContent(typed(attachment(fields)))).toMatchObject({
      ok: false,
      reason: 'invalid',
      internal: false,
      detail: 'fields',
    });
    expect(refusal(attachment(fields))).toBe(CONTENT_ERROR.INVALID);
  });
});

describe('call.dtls (internal: a call’s DTLS fingerprints, SHA-256 only)', () => {
  it('is internal: decodes, but is never a chat message', () => {
    expect(decodeContent(encodeContent(attestation()))).toEqual({
      ok: true,
      legacy: false,
      internal: true,
      content: attestation(),
    });
  });

  it.each([
    ['a SHA-1 fingerprint', { fingerprints: [`sha-1 ${hexBytes(20)}`] }],
    ['a SHA-384 fingerprint (not approved)', { fingerprints: [`sha-384 ${hexBytes(48)}`] }],
    ['a SHA-512 fingerprint (not approved)', { fingerprints: [`sha-512 ${hexBytes(64)}`] }],
    ['the same fingerprint twice', { fingerprints: [SHA256, SHA256] }],
    ['lower-case hex', { fingerprints: [SHA256.toLowerCase()] }],
    ['a fingerprint of the wrong length', { fingerprints: [`sha-256 ${hexBytes(31)}`] }],
    ['no fingerprints', { fingerprints: [] }],
    ['five fingerprints', { fingerprints: Array(5).fill(SHA256) }],
    ['an unknown role', { role: 'admin' }],
    ['a user id that is not an id', { from: 'alice' }],
    ['a call id that is not a UUID', { callId: 'call-1' }],
    ['an unknown kind', { kind: 'screen' }],
  ])('%s is invalid, and still internal (never shown)', (_, fields) => {
    expect(decodeContent(typed(attestation(fields)))).toMatchObject({
      ok: false,
      reason: 'invalid',
      internal: true,
    });
  });
});

describe('how the chat shows content it cannot display', () => {
  const PEER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  let requests;

  beforeEach(async () => {
    jest.resetModules();
    resetDevice();
    await signIn(loadApp());
    requests = mockApi({
      [`GET /presence?userIds=${PEER}`]: () => ({ body: { presence: { [PEER]: false } } }),
      'GET /calls/current': () => ({ body: { call: null } }),
      'POST /messages/read': () => ({ body: { updated: 1 } }),
    });
    require('../src/messaging/messagingEngine').useMessagingStore.setState({ online: true });
    globalThis.__routeParams = { peerUserId: PEER };
  });

  afterEach(() => {
    globalThis.__routeParams = undefined;
  });

  it('placeholders in the chat and the chat list; the screen renders normally around them', async () => {
    const store = require('../src/crypto/signalStore');
    const messages = require('../src/messaging/messageStore');
    await messages.ensureConversation(PEER, { title: 'Bob', at: 3 });
    const incoming = (id, fields, createdAt) =>
      store.saveIncomingMessage({ serverMessageId: id, peerUserId: PEER, createdAt, ...fields });
    await incoming('m1', { body: '', status: 'unsupported', error: 'UNSUPPORTED_CONTENT' }, 1);
    await incoming('m2', { body: '', status: 'unsupported', error: 'INVALID_CONTENT' }, 2);
    await incoming('m3', { body: 'Hello', status: 'received' }, 3);

    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const Screen = require('../src/app/(app)/chat/[peerUserId]').default;
    let tree;
    await act(async () => {
      tree = create(React.createElement(Screen));
    });
    const shown = JSON.stringify(tree.toJSON());
    expect(shown).toContain('This message isn’t supported by this version of CipherChat.');
    expect(shown).toContain('This message could not be displayed.');
    expect(shown).toContain('Hello');
    await act(async () => tree.unmount());

    // Opening the chat read "Hello"; placeholders are never unread and get no read receipt
    // (like undecryptable messages).
    const [row] = await messages.listConversations();
    expect(row).toMatchObject({ lastBody: 'Hello', unread: 0 });
    const list = await messages.listChatMessages(PEER);
    expect(list.map((m) => m.status)).toEqual(['read', 'unsupported', 'unsupported']);
    const receipts = requests.filter((r) => r.key === 'POST /messages/read');
    expect(receipts.map((r) => r.body.messageIds)).toEqual([['m3']]);

    const { ChatListRow } = require('../src/components/ChatListRow');
    let preview;
    await act(async () => {
      preview = create(
        React.createElement(ChatListRow, {
          item: { peerUserId: PEER, title: 'Bob', lastBody: '', lastStatus: 'unsupported' },
        }),
      );
    });
    expect(JSON.stringify(preview.toJSON())).toContain('Message can’t be shown');
    await act(async () => preview.unmount());
  });
});
