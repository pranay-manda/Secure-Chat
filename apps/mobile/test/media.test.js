/* global jest */
/**
 * The thin native layer of calls (media.js): here, how an incoming call alerts. A phone in
 * vibrate mode used to give no alert at all, because the ringtone library only plays sound in
 * normal mode and only vibrates when it is given a pattern.
 */
const mockIncall = { startRingtone: jest.fn(), stopRingtone: jest.fn() };
jest.mock('react-native-incall-manager', () => ({ __esModule: true, default: mockIncall }));
const mockGetUserMedia = jest.fn();
jest.mock('react-native-webrtc', () => ({
  mediaDevices: { getUserMedia: (...args) => mockGetUserMedia(...args) },
}));

let media;
let Platform;

beforeEach(() => {
  jest.resetModules();
  mockIncall.startRingtone.mockClear();
  ({ Platform } = require('react-native'));
  media = require('../src/calls/media');
});

afterEach(() => {
  Platform.OS = 'ios';
});

const total = (pattern) => pattern.reduce((sum, ms) => sum + ms, 0);

describe('permissions (Android)', () => {
  it('tells "denied" (may ask again) from "blocked" (only Settings can grant it)', async () => {
    Platform.OS = 'android';
    const { PermissionsAndroid } = require('react-native');
    const request = jest.spyOn(PermissionsAndroid, 'request');
    request.mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED);
    await expect(media.getMedia()).rejects.toMatchObject({
      code: 'MIC_PERMISSION_DENIED',
      blocked: false,
    });
    request.mockResolvedValueOnce(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
    await expect(media.getMedia()).rejects.toMatchObject({
      code: 'MIC_PERMISSION_DENIED',
      blocked: true,
    });
    // Camera refused for good after the microphone was allowed.
    request
      .mockResolvedValueOnce(PermissionsAndroid.RESULTS.GRANTED)
      .mockResolvedValueOnce(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
    await expect(media.getMedia({ video: true })).rejects.toMatchObject({
      code: 'CAMERA_PERMISSION_DENIED',
      blocked: true,
    });
    // One prompt per attempt, never a loop of prompts.
    expect(request).toHaveBeenCalledTimes(4);
    request.mockRestore();
  });
});

describe('capture deadline', () => {
  afterEach(() => jest.useRealTimers());

  it('a camera that never starts fails with MEDIA_TIMEOUT; a stream arriving late is released', async () => {
    // Seen on Android 16: after two captures of one camera evicted each other, WebRTC's capture
    // thread never answered again, and calls sat on "Calling…".
    jest.useFakeTimers();
    let deliver;
    mockGetUserMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const result = media.getMedia({ video: true });
    jest.advanceTimersByTime(media.CAPTURE_TIMEOUT_MS);
    await expect(result).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT' });

    const track = { stop: jest.fn() };
    const late = { getTracks: () => [track], release: jest.fn() };
    deliver(late);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(track.stop).toHaveBeenCalled(); // never a camera left running with nobody using it
    expect(late.release).toHaveBeenCalled();
  });

  it('a capture that starts in time is returned as is', async () => {
    const stream = { getTracks: () => [] };
    mockGetUserMedia.mockResolvedValueOnce(stream);
    await expect(media.getMedia({ video: true })).resolves.toBe(stream);
    expect(mockGetUserMedia).toHaveBeenLastCalledWith({
      audio: true,
      video: { width: 640, height: 480, frameRate: 24, facingMode: 'user' },
    });
  });
});

describe('incoming call alert', () => {
  it('Android: rings with the system ringtone and a ringtone vibration for the whole ring', () => {
    Platform.OS = 'android';
    media.audio.startRingtone(47_000);
    expect(mockIncall.startRingtone).toHaveBeenCalledTimes(1);
    const [ringtone, pattern] = mockIncall.startRingtone.mock.calls[0];
    expect(ringtone).toBe('_DEFAULT_'); // the user's own ringtone; never a forced sound
    expect(pattern[0]).toBe(0); // starts at once
    expect(pattern.slice(1).every((ms) => ms > 0)).toBe(true); // real on/off pulses
    expect(total(pattern)).toBeGreaterThanOrEqual(47_000); // covers the ring window
    expect(total(pattern)).toBeLessThan(47_000 + 2_000); // and stops with it
  });

  it('the vibration lasts as long as this call can ring, with sane bounds', () => {
    expect(total(media.ringVibrationPattern(10_000))).toBe(10_000);
    expect(total(media.ringVibrationPattern(0))).toBe(2_000); // at least one pulse
    expect(total(media.ringVibrationPattern(-5))).toBe(2_000);
  });

  it('iOS: no vibration pattern is passed (the system handles alerts)', () => {
    Platform.OS = 'ios';
    media.audio.startRingtone(47_000);
    expect(mockIncall.startRingtone).toHaveBeenCalledWith('_DEFAULT_', undefined);
  });

  it('a failing ringtone never breaks the call', () => {
    Platform.OS = 'android';
    mockIncall.startRingtone.mockImplementationOnce(() => {
      throw new Error('no audio service');
    });
    expect(() => media.audio.startRingtone(47_000)).not.toThrow();
  });
});
