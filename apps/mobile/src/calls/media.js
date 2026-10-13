import { PermissionsAndroid, Platform } from 'react-native';

import { startCallService, stopCallService } from '../../modules/call-service';
import { classifyRoute, iceTransportPolicyOf, sanitizeIceServers } from './ice';

/**
 * The only file that touches the native call libraries:
 *  - react-native-webrtc: microphone and camera capture and the RTCPeerConnection (media flows
 *    directly between the two phones, encrypted by WebRTC with DTLS-SRTP; never through our
 *    server).
 *  - react-native-incall-manager: the phone's in-call audio mode, earpiece/speaker routing,
 *    proximity sensor and ringtone.
 *  - modules/call-service: Android's "microphone" foreground service, so a call keeps its
 *    microphone while the app is in the background or the screen is locked.
 * The call engine depends on this small surface only, so its logic is testable without a
 * phone. Libraries are loaded lazily: nothing native runs until a call actually starts.
 */

let webrtc = null;
let incall;

const lib = () => {
  webrtc ??= require('react-native-webrtc');
  return webrtc;
};

/** In-call audio routing is a nicety: if it is unavailable the call still works. */
function audioManager() {
  if (incall === undefined) {
    try {
      incall = require('react-native-incall-manager').default;
    } catch {
      incall = null;
    }
  }
  return incall;
}

const attempt = (fn) => {
  try {
    fn();
  } catch {
    // Best effort: audio routing must never break a call.
  }
};

/**
 * @param {'microphone'|'camera'} device
 * @param {{ blocked?: boolean }} [options] `blocked`: the system will not ask again (the user
 *   chose "Don't allow" for good), so only the app's Settings page can grant it.
 */
function permissionDenied(device = 'microphone', { blocked = false } = {}) {
  const err = new Error(`${device === 'camera' ? 'Camera' : 'Microphone'} permission denied`);
  err.code = device === 'camera' ? 'CAMERA_PERMISSION_DENIED' : 'MIC_PERMISSION_DENIED';
  err.blocked = blocked;
  return err;
}

const isDenial = (err) =>
  err?.name === 'NotAllowedError' || /permission/i.test(String(err?.message));

/** @returns {Promise<'granted'|'denied'|'blocked'>} (a dismissed dialog counts as denied) */
async function requestAndroidPermission(permission, title, message) {
  const result = await PermissionsAndroid.request(permission, {
    title,
    message,
    buttonPositive: 'Continue',
  });
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
}

/** Camera capture: modest resolution keeps a 1:1 call usable on mobile data. */
const VIDEO_CONSTRAINTS = {
  width: 640,
  height: 480,
  frameRate: 24,
};

/**
 * How long the camera and microphone may take to start once permission is granted. Opening them
 * takes well under a second; a phone whose camera stack stopped answering never finishes, and
 * the call must end with a reason instead of staying on "Calling…" forever.
 */
export const CAPTURE_TIMEOUT_MS = 15_000;

function captureTimedOut() {
  const err = new Error('Camera or microphone did not start');
  err.code = 'MEDIA_TIMEOUT';
  return err;
}

const releaseStream = (stream) => {
  stream?.getTracks?.().forEach((track) => track.stop());
  stream?.release?.();
};

/** getUserMedia with a deadline. A stream that arrives after it is released at once. */
function capture(constraints) {
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(captureTimedOut());
    }, CAPTURE_TIMEOUT_MS);
    lib()
      .mediaDevices.getUserMedia(constraints)
      .then(
        (stream) => {
          if (late) releaseStream(stream);
          else resolve(stream);
        },
        (err) => {
          if (!late) reject(err);
        },
      )
      .finally(() => clearTimeout(timer));
  });
}

/**
 * Asks for the microphone (and the camera for a video call), only ever as a result of the user
 * starting or answering a call, and returns the local MediaStream. Throws code
 * MIC_PERMISSION_DENIED or CAMERA_PERMISSION_DENIED if refused, MEDIA_TIMEOUT if the camera or
 * microphone does not start within CAPTURE_TIMEOUT_MS. The microphone is asked first,
 * so a call whose camera is refused can still go on as audio only (the caller decides).
 *
 * @param {{ audio?: boolean, video?: boolean, facing?: 'user'|'environment' }} [options]
 *   `audio: false` captures the camera alone (reopening it after the app was in the background).
 */
export async function getMedia({ audio = true, video = false, facing = 'user' } = {}) {
  if (Platform.OS === 'android') {
    if (audio) {
      const mic = await requestAndroidPermission(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        'Microphone',
        'CipherChat needs the microphone for calls.',
      );
      if (mic !== 'granted') throw permissionDenied('microphone', { blocked: mic === 'blocked' });
    }
    if (video) {
      const camera = await requestAndroidPermission(
        PermissionsAndroid.PERMISSIONS.CAMERA,
        'Camera',
        'CipherChat needs the camera for video calls.',
      );
      if (camera !== 'granted') throw permissionDenied('camera', { blocked: camera === 'blocked' });
    }
  }
  const constraints = {
    audio,
    video: video ? { ...VIDEO_CONSTRAINTS, facingMode: facing } : false,
  };
  try {
    // iOS shows its own prompts here (NSMicrophoneUsageDescription / NSCameraUsageDescription).
    return await capture(constraints);
  } catch (err) {
    if (!isDenial(err)) throw err;
    // Which one was refused? iOS reports a generic NotAllowedError; audio-only tells.
    if (!video) throw permissionDenied('microphone');
    if (!audio) throw permissionDenied('camera');
    try {
      releaseStream(await capture({ audio: true, video: false }));
    } catch {
      throw permissionDenied('microphone');
    }
    throw permissionDenied('camera');
  }
}

/** Audio-only capture (voice calls). */
export const getMicrophone = () => getMedia({ video: false });

/**
 * Switches a local camera track between front and back without renegotiation. Returns the
 * new facing, or null if the switch is unavailable (single camera, remote track...).
 */
export function switchCamera(track, current) {
  try {
    track._switchCamera();
    return current === 'user' ? 'environment' : 'user';
  } catch {
    return null;
  }
}

/**
 * @param {unknown} iceServers this call's ICE servers from the API (TURN credentials included)
 * @param {{ iceTransportPolicy?: string }} [options] `relay` = media only through TURN
 */
export function createPeerConnection(iceServers, { iceTransportPolicy } = {}) {
  const { RTCPeerConnection } = lib();
  return new RTCPeerConnection({
    iceServers: sanitizeIceServers(iceServers),
    iceTransportPolicy: iceTransportPolicyOf(iceTransportPolicy),
    bundlePolicy: 'max-bundle',
  });
}

/** Which path the connected call uses (see ice.js: types only, no addresses). Never throws. */
export async function getConnectionRoute(pc) {
  try {
    return classifyRoute(await pc.getStats());
  } catch {
    return null;
  }
}

export function toIceCandidate(init) {
  const { RTCIceCandidate } = lib();
  return new RTCIceCandidate(init);
}

export function toSessionDescription(init) {
  const { RTCSessionDescription } = lib();
  return new RTCSessionDescription(init);
}

/**
 * Vibration while an incoming call rings: 1 s on, 1 s off, for `durationMs` (the library plays
 * it once, without repeating). Without a pattern, a phone in vibrate mode gave no alert at all:
 * the ringtone library only plays sound in normal mode and only vibrates when given a pattern.
 * It still never vibrates in silent mode, and the system's Do Not Disturb rules for ringtones
 * still apply (the vibration is a ringtone vibration).
 */
export function ringVibrationPattern(durationMs) {
  const pulses = Math.max(1, Math.ceil(Math.max(0, durationMs) / 2000));
  const pattern = [0];
  for (let i = 0; i < pulses; i += 1) pattern.push(1000, 1000);
  return pattern;
}

/** How long an incoming call rings if the server's ring window is unknown. */
const DEFAULT_RING_MS = 47_000;

export const audio = {
  /**
   * In-call audio mode. Voice: earpiece by default, proximity sensor on. Video: speaker by
   * default and the screen kept on (the user is looking at it).
   */
  start: (kind = 'voice') =>
    attempt(() => audioManager()?.start({ media: kind === 'video' ? 'video' : 'audio' })),
  stop: () => attempt(() => audioManager()?.stop()),
  setSpeaker: (on) => attempt(() => audioManager()?.setForceSpeakerphoneOn(Boolean(on))),
  /** The system ringtone (normal mode) and a ringtone vibration (Android) for `durationMs`. */
  startRingtone: (durationMs = DEFAULT_RING_MS) =>
    attempt(() =>
      audioManager()?.startRingtone(
        '_DEFAULT_',
        Platform.OS === 'android' ? ringVibrationPattern(durationMs) : undefined,
      ),
    ),
  stopRingtone: () => attempt(() => audioManager()?.stopRingtone()),
};

/**
 * Keeps the microphone working in the background while a call holds it (Android; no-op on iOS,
 * which uses the "audio" background mode). Start only while the app is in the foreground.
 */
export const keepAlive = {
  start: () => startCallService(),
  stop: () => stopCallService(),
};
