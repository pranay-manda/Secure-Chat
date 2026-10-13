/* global jest */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadApp, mockApi, resetDevice, signIn } from './helpers';

/**
 * The chat composer's media controls: photo/video picking and voice-note recording (start,
 * send, cancel, too short, permission refused, blocked during a call), and media bubbles. The
 * real send path runs up to the network: the API is unreachable here, so messages stay queued
 * (failed, TEMPORARY) with their encrypted attachment, which is what these tests inspect.
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

const PEER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const cacheDir = (dir) => path.join(require('./mocks/fileSystemMock').Paths.cache.path, dir);
const listDir = (dir) => (existsSync(cacheDir(dir)) ? readdirSync(cacheDir(dir)) : []);

beforeEach(async () => {
  jest.resetModules();
  resetDevice();
  globalThis.__device.audio = undefined;
  globalThis.__device.pickResult = undefined;
  const app = loadApp();
  await signIn(app);
  // No API route for sending: delivery fails as "offline" and the message stays queued.
  mockApi({ 'GET /calls/current': () => ({ body: { call: null } }) });
  await require('../src/messaging/messageStore').ensureConversation(PEER, { title: 'Bob' });
  globalThis.__routeParams = { peerUserId: PEER };
});

afterEach(() => {
  globalThis.__routeParams = undefined;
});

async function renderChat() {
  const React = require('react');
  const { act, create } = require('react-test-renderer');
  const Screen = require('../src/app/(app)/chat/[peerUserId]').default;
  const element = React.createElement(Screen);
  let tree;
  await act(async () => {
    tree = create(element);
  });
  await act(async () => flush());
  const find = (testID) => tree.root.findAll((n) => n.props.testID === testID)[0];
  const press = async (testID) => {
    await act(async () => find(testID).props.onPress());
    await act(async () => flush());
  };
  const rerender = async () => {
    // A new element: re-rendering the same element object is skipped by React.
    await act(async () => tree.update(React.createElement(Screen)));
    await act(async () => flush());
  };
  return { tree, act, find, press, rerender };
}

/** All text rendered under a node. */
const textOf = (node) =>
  node
    .findAll((n) => typeof n.props.children === 'string')
    .map((n) => n.props.children)
    .join(' ');

const stored = async () => require('../src/messaging/messageStore').listChatMessages(PEER);
const recorder = () => require('expo-audio').useAudioRecorder();

/** Holds the microphone like a finger would (see VoiceComposer). */
function micGestures(ui) {
  let clock = Date.now();
  const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  const mic = () => ui.find('voice-record');
  const at = (x, y) => ({ nativeEvent: { pageX: 300 + x, pageY: 700 + y } });
  return {
    async down() {
      await ui.act(async () => mic().props.onResponderGrant(at(0, 0)));
      await ui.act(async () => flush());
    },
    async move(x, y) {
      await ui.act(async () => mic().props.onResponderMove(at(x, y)));
      await ui.act(async () => flush());
    },
    async up() {
      // After a lock the microphone is gone (Send took its place): letting go does nothing.
      await ui.act(async () => mic()?.props.onResponderRelease(at(0, 0)));
      await ui.act(async () => flush());
    },
    wait(ms) {
      clock += ms;
    },
    restore: () => nowSpy.mockRestore(),
  };
}

/** Lets the recorder sample the microphone level a few times (real 100 ms interval). */
const sampleLevels = (ui) =>
  ui.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });

describe('voice notes (hold to record, like WhatsApp)', () => {
  it('hold, release: sends an encrypted voice note with its waveform; the recording is deleted', async () => {
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    expect(require('expo-audio').requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(ui.find('voice-recording-bar')).toBeDefined();
    expect(ui.find('voice-lock-hint')).toBeDefined();
    expect(listDir('Audio')).toHaveLength(1);

    await sampleLevels(ui);
    recorder().durationMillis = 4200;
    await ui.rerender();
    g.wait(4200);
    const alert = jest.spyOn(require('react-native').Alert, 'alert');
    await g.up();
    g.restore();
    expect(alert).not.toHaveBeenCalled();

    const [message] = await stored();
    expect(message).toMatchObject({ direction: 'out', body: '' });
    expect(message.attachment).toMatchObject({
      kind: 'audio',
      voiceNote: true,
      durationMs: 4200,
      contentType: 'audio/mp4',
    });
    expect(message.attachment.waveform).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(listDir('Audio')).toEqual([]); // plaintext recording gone, only the encrypted blob
    expect(ui.find('voice-recording-bar')).toBeUndefined();
    await ui.act(async () => ui.tree.unmount());
  });

  it('a quick tap records nothing and explains "Hold to record"', async () => {
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    g.wait(150);
    await g.up();
    g.restore();
    expect(await stored()).toEqual([]);
    expect(listDir('Audio')).toEqual([]);
    expect(textOf(ui.find('voice-notice'))).toMatch(/Hold to record, release to send/);
    await ui.act(async () => ui.tree.unmount());
  });

  it('a recording under one second is discarded with a hint', async () => {
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    recorder().durationMillis = 300;
    await ui.rerender();
    g.wait(900); // held long enough to count as a recording, but too short a message
    await g.up();
    g.restore();
    expect(await stored()).toEqual([]);
    expect(listDir('Audio')).toEqual([]);
    expect(textOf(ui.find('voice-notice'))).toMatch(/too short/);
    await ui.act(async () => ui.tree.unmount());
  });

  it('sliding left cancels: nothing is sent and the recording is deleted', async () => {
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    await g.move(-60, 0);
    expect(ui.find('voice-recording-bar')).toBeDefined(); // not far enough yet
    await g.move(-130, 0);
    g.wait(3000);
    await g.up();
    g.restore();
    expect(await stored()).toEqual([]);
    expect(listDir('Audio')).toEqual([]);
    expect(ui.find('voice-recording-bar')).toBeUndefined();
    await ui.act(async () => ui.tree.unmount());
  });

  it('sliding up locks; Stop lets the user listen first, then Send', async () => {
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    await g.move(0, -100);
    g.wait(2000);
    await g.up(); // locked: letting go does not send
    g.restore();
    expect(await stored()).toEqual([]);
    expect(ui.find('voice-recording-bar')).toBeDefined();
    expect(ui.find('voice-stop')).toBeDefined();

    recorder().durationMillis = 2500;
    await ui.rerender();
    await ui.press('voice-stop');
    expect(ui.find('voice-review-bar')).toBeDefined();
    expect(await stored()).toEqual([]); // still a draft
    await ui.press('voice-review-play');
    const reviewPlayer = globalThis.__device.audio.players.find(
      (p) => p.source?.uri?.includes('/Audio/') && p.playing,
    );
    expect(reviewPlayer).toBeDefined(); // the draft plays on this phone

    await ui.press('voice-send');
    const [message] = await stored();
    expect(message.attachment).toMatchObject({ kind: 'audio', voiceNote: true, durationMs: 2500 });
    expect(listDir('Audio')).toEqual([]);
    expect(ui.find('voice-review-bar')).toBeUndefined();
    await ui.act(async () => ui.tree.unmount());
  });

  it('locked or in review, Delete discards the recording', async () => {
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    await g.move(0, -100);
    await g.up();
    g.restore();
    await ui.press('voice-stop');
    await ui.press('voice-cancel');
    expect(await stored()).toEqual([]);
    expect(listDir('Audio')).toEqual([]);
    expect(ui.find('voice-review-bar')).toBeUndefined();
    await ui.act(async () => ui.tree.unmount());
  });

  it('leaving the chat while recording or reviewing deletes the recording', async () => {
    let ui = await renderChat();
    let g = micGestures(ui);
    await g.down();
    g.restore();
    await ui.act(async () => ui.tree.unmount());
    await flush();
    expect(listDir('Audio')).toEqual([]);

    ui = await renderChat();
    g = micGestures(ui);
    await g.down();
    await g.move(0, -100);
    await g.up();
    g.restore();
    await ui.press('voice-stop');
    await ui.act(async () => ui.tree.unmount());
    await flush();
    expect(listDir('Audio')).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('a refused microphone shows how to turn it on; nothing is recorded', async () => {
    globalThis.__device.audio = { permission: { granted: false, canAskAgain: false }, players: [] };
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    await g.up();
    g.restore();
    const notice = ui.find('voice-notice');
    expect(textOf(notice)).toMatch(/Turn it on in Settings/);
    expect(ui.find('voice-recording-bar')).toBeUndefined();
    expect(listDir('Audio')).toEqual([]);
    await ui.act(async () => ui.tree.unmount());
  });

  it('cannot record during a call (the microphone belongs to the call)', async () => {
    const ui = await renderChat();
    require('../src/calls/callEngine').useCallStore.setState({ phase: 'connected' });
    const g = micGestures(ui);
    await g.down();
    await g.up();
    g.restore();
    expect(require('expo-audio').requestRecordingPermissionsAsync).not.toHaveBeenCalled();
    expect(ui.find('voice-recording-bar')).toBeUndefined();
    expect(textOf(ui.find('voice-notice'))).toMatch(/during a call/);
    require('../src/calls/callEngine').useCallStore.setState({ phase: 'idle' });
    await ui.act(async () => ui.tree.unmount());
  });

  it('a voice note plays at 1×, 1.5× and 2×', async () => {
    const ui = await renderChat();
    const g = micGestures(ui);
    await g.down();
    recorder().durationMillis = 3000;
    await ui.rerender();
    g.wait(3000);
    await g.up();
    g.restore();
    await ui.rerender();
    const [message] = await stored();

    await ui.press(`voice-toggle-${message.id}`);
    await ui.rerender(); // decrypted
    await ui.rerender(); // playing
    const player = globalThis.__device.audio.players.find((p) => p.playing);
    expect(player).toBeDefined();
    await ui.press(`voice-rate-${message.id}`);
    expect(player.rate).toBe(1.5);
    await ui.press(`voice-rate-${message.id}`);
    expect(player.rate).toBe(2);
    await ui.press(`voice-rate-${message.id}`);
    expect(player.rate).toBe(1);
    await ui.act(async () => ui.tree.unmount());
  });
});

describe('photos and videos', () => {
  function picked(bytes = Buffer.alloc(5000, 9), name = 'IMG_1.jpg') {
    mkdirSync(cacheDir('ImagePicker'), { recursive: true });
    const full = path.join(cacheDir('ImagePicker'), name);
    writeFileSync(full, bytes);
    return `file://${full.split(path.sep).join('/')}`;
  }
  const attachButton = (ui) =>
    ui.tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Send a photo or video' && n.props.onPress,
    )[0];

  it('a picked photo waits on the preview; Send sends it with the caption and removes the copy', async () => {
    const uri = picked();
    globalThis.__device.pickResult = {
      canceled: false,
      assets: [{ uri, mimeType: 'image/jpeg', width: 640, height: 480, type: 'image' }],
    };
    const ui = await renderChat();
    await ui.act(async () => attachButton(ui).props.onPress());
    await ui.act(async () => flush());

    // Nothing is sent before the user taps Send.
    expect(ui.find('media-preview-image')).toBeDefined();
    expect(await stored()).toEqual([]);
    await ui.act(async () => ui.find('media-preview-caption').props.onChangeText('Look at this'));
    await ui.press('media-preview-send');

    const [message] = await stored();
    expect(message).toMatchObject({ body: 'Look at this', status: 'failed', error: 'TEMPORARY' });
    expect(message.attachment).toMatchObject({ kind: 'image', width: 640, height: 480 });
    expect(listDir('ImagePicker')).toEqual([]);
    expect(ui.find('media-preview-image')).toBeUndefined();
    await ui.act(async () => ui.tree.unmount());
  });

  it('closing the preview sends nothing and deletes the picked copy', async () => {
    globalThis.__device.pickResult = {
      canceled: false,
      assets: [{ uri: picked(), mimeType: 'image/jpeg', width: 10, height: 10, type: 'image' }],
    };
    const ui = await renderChat();
    await ui.act(async () => attachButton(ui).props.onPress());
    await ui.act(async () => flush());
    await ui.press('media-preview-close');
    expect(await stored()).toEqual([]);
    expect(listDir('ImagePicker')).toEqual([]);
    expect(ui.find('media-preview-image')).toBeUndefined();
    await ui.act(async () => ui.tree.unmount());
  });

  it('a cancelled picker shows no preview and sends nothing', async () => {
    const ui = await renderChat();
    await ui.act(async () => attachButton(ui).props.onPress());
    await ui.act(async () => flush());
    expect(ui.find('media-preview-image')).toBeUndefined();
    expect(await stored()).toEqual([]);
    await ui.act(async () => ui.tree.unmount());
  });

  it('the in-app camera: tap takes a photo, preview, Send; nothing stays in the camera folder', async () => {
    const ui = await renderChat();
    await ui.press('camera-button');
    expect(ui.find('camera-view')).toBeDefined();
    await ui.act(async () => ui.find('camera-view').props.onCameraReady());
    await ui.act(async () => ui.find('camera-shutter').props.onPressIn());
    await ui.act(async () => ui.find('camera-shutter').props.onPressOut());
    await ui.act(async () => flush());

    expect(ui.find('camera-view')).toBeUndefined();
    expect(ui.find('media-preview-image')).toBeDefined();
    expect(listDir('Camera')).toHaveLength(1); // only in the app's private cache
    await ui.press('media-preview-send');

    const [message] = await stored();
    expect(message.attachment).toMatchObject({ kind: 'image', width: 1080, height: 1920 });
    expect(listDir('Camera')).toEqual([]);
    await ui.act(async () => ui.tree.unmount());
  });

  it('the in-app camera: holding the shutter records a video until released', async () => {
    const ui = await renderChat();
    await ui.press('camera-button');
    await ui.act(async () => ui.find('camera-view').props.onCameraReady());
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      await ui.act(async () => ui.find('camera-shutter').props.onPressIn());
      await ui.act(async () => jest.advanceTimersByTime(400)); // held: switch to video
      expect(ui.find('camera-view').props.mode).toBe('video');
      await ui.act(async () => ui.find('camera-view').props.onCameraReady()); // ready to record
      await ui.act(async () => jest.advanceTimersByTime(2000));
      await ui.act(async () => ui.find('camera-shutter').props.onPressOut()); // let go: stop
    } finally {
      jest.useRealTimers();
    }
    await ui.act(async () => flush());
    expect(ui.find('media-preview-video')).toBeDefined();
    await ui.press('media-preview-close');
    expect(listDir('Camera')).toEqual([]);
    expect(await stored()).toEqual([]);
    await ui.act(async () => ui.tree.unmount());
  });

  it('a photo bubble decrypts for display only while shown', async () => {
    globalThis.__device.pickResult = {
      canceled: false,
      assets: [{ uri: picked(), mimeType: 'image/jpeg', width: 10, height: 10, type: 'image' }],
    };
    const ui = await renderChat();
    await ui.act(async () => attachButton(ui).props.onPress());
    await ui.act(async () => flush());
    await ui.press('media-preview-send');
    await ui.rerender();

    const [message] = await stored();
    expect(ui.find(`attachment-image-${message.id}`)).toBeDefined();
    expect(listDir('secure-media')).toHaveLength(1); // the decrypted preview
    await ui.act(async () => ui.tree.unmount());
    await flush();
    expect(listDir('secure-media')).toEqual([]);
  });
});
