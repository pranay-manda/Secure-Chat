import { ATTACHMENT } from '@secure-chat/shared/constants';
import {
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { isActivePhase } from '../../calls/callMachine';
import { isCallActive, useCallStore } from '../../calls/callEngine';
import { withSystemUi } from '../../lib/systemUi';
import { deleteQuietly } from '../../media/mediaFiles';
import { encodeWaveform, levelFromDb } from '../../media/waveform';

/** Mono AAC in MP4 (.m4a), 64 kbit/s: clear speech, ~0.5 MB per minute. */
export const VOICE_NOTE_PRESET = Object.freeze({
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  // Microphone level, sampled while recording, draws the waveform (see media/waveform.js).
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: 'aac ', audioQuality: 96 },
  web: { mimeType: 'audio/webm', bitsPerSecond: 64000 },
});

/** Recordings shorter than this are discarded (a tap, not a message). */
export const VOICE_NOTE_MIN_MS = 1000;
/** How often the microphone level is sampled while recording. */
const LEVEL_SAMPLE_MS = 100;
/** Bars of the live waveform shown while recording. */
export const LIVE_BARS = 36;

/**
 * Voice-note recording, WhatsApp style. Modes:
 *   idle → holding (finger on the mic: release sends, slide left cancels, slide up locks)
 *        → locked (hands-free: Stop to review, or Send / Delete)
 *        → review (stopped: listen to it, then Send or Delete) → idle
 *
 * The microphone is requested only when the user starts a recording. The recording is written
 * by expo-audio into the app's private cache (cache/Audio); it is encrypted and deleted when
 * sent, deleted when cancelled, and swept at start if the app was killed meanwhile. Recording
 * is not possible during a call, stops if a call starts, and stops into review (a draft that
 * can still be sent or deleted) when the app leaves the screen or the length limit is reached.
 *
 * @param {{ onSend: (media: object) => Promise<void> }} options
 */
export function useVoiceRecorder({ onSend }) {
  const recorder = useAudioRecorder(VOICE_NOTE_PRESET);
  const live = useAudioRecorderState(recorder, 250);
  const [mode, setMode] = useState('idle');
  const [notice, setNotice] = useState(null);
  /** The stopped recording in review: { uri, durationMs, waveform }. */
  const [draft, setDraft] = useState(null);
  /** Recent microphone levels (0…1) for the live waveform. */
  const [levels, setLevels] = useState([]);
  const samples = useRef([]);
  const lastDuration = useRef(0);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    if (live.isRecording) lastDuration.current = live.durationMillis;
  }, [live.isRecording, live.durationMillis]);

  const recording = mode === 'holding' || mode === 'locked';

  const stopRecorder = useCallback(async () => {
    try {
      if (recorder.isRecording || modeRef.current === 'holding' || modeRef.current === 'locked') {
        await recorder.stop();
      }
    } catch {
      // Already stopped.
    }
    return recorder.uri;
  }, [recorder]);

  /** Stops and keeps the recording for review (listen, then send or delete). */
  const stopToReview = useCallback(async () => {
    if (modeRef.current !== 'holding' && modeRef.current !== 'locked') return;
    const durationMs = Math.min(lastDuration.current, ATTACHMENT.VOICE_NOTE_MAX_MS);
    const uri = await stopRecorder();
    if (!uri) {
      setMode('idle');
      return;
    }
    setDraft({ uri, durationMs, waveform: encodeWaveform(samples.current) });
    setMode('review');
  }, [stopRecorder]);

  /**
   * Starts recording (finger down on the mic). Returns false if it could not start (in a call,
   * permission refused or asked just now, microphone busy).
   */
  const start = useCallback(async () => {
    setNotice(null);
    if (modeRef.current !== 'idle') return false;
    if (isCallActive()) {
      setNotice({ text: 'You can’t record a voice message during a call.' });
      return false;
    }
    const permission = await withSystemUi(() => requestRecordingPermissionsAsync()).catch(() => ({
      granted: false,
    }));
    if (!permission.granted) {
      setNotice({
        text:
          permission.canAskAgain === false
            ? 'Microphone access is off for CipherChat. Turn it on in Settings to record.'
            : 'Microphone permission is needed to record a voice message.',
        settings: permission.canAskAgain === false,
      });
      return false;
    }
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      lastDuration.current = 0;
      samples.current = [];
      setLevels([]);
      setDraft(null);
      setMode('holding');
      return true;
    } catch {
      setNotice({ text: 'The microphone could not be started. Try again.' });
      setMode('idle');
      return false;
    }
  }, [recorder]);

  /** Slide up while holding: keep recording without the finger. */
  const lock = useCallback(() => {
    if (modeRef.current === 'holding') setMode('locked');
  }, []);

  /** Discards the recording or draft. `hint`: explain how recording works (a quick tap). */
  const cancel = useCallback(
    async ({ hint = false } = {}) => {
      const uri = modeRef.current === 'review' ? draft?.uri : await stopRecorder();
      if (uri) deleteQuietly(uri);
      setDraft(null);
      setMode('idle');
      if (hint) setNotice({ text: 'Hold to record, release to send.' });
    },
    [draft, stopRecorder],
  );

  const send = useCallback(async () => {
    let note = draft;
    if (modeRef.current === 'holding' || modeRef.current === 'locked') {
      const durationMs = Math.min(lastDuration.current, ATTACHMENT.VOICE_NOTE_MAX_MS);
      const uri = await stopRecorder();
      note = uri ? { uri, durationMs, waveform: encodeWaveform(samples.current) } : null;
    }
    setDraft(null);
    setMode('idle');
    if (!note) return;
    if (note.durationMs < VOICE_NOTE_MIN_MS) {
      deleteQuietly(note.uri);
      setNotice({ text: 'Voice message too short.' });
      return;
    }
    await onSend({
      uri: note.uri,
      contentType: 'audio/mp4',
      durationMs: note.durationMs,
      voiceNote: true,
      waveform: note.waveform ?? undefined,
    });
  }, [draft, onSend, stopRecorder]);

  // Microphone level while recording.
  useEffect(() => {
    if (!recording) return undefined;
    const timer = setInterval(() => {
      let level = 0;
      try {
        level = levelFromDb(recorder.getStatus?.()?.metering);
      } catch {
        // No level this time.
      }
      samples.current.push(level);
      setLevels((previous) => [...previous.slice(1 - LIVE_BARS), level]);
      // Length limit: stop and keep the draft.
      if (lastDuration.current >= ATTACHMENT.VOICE_NOTE_MAX_MS) stopToReview();
    }, LEVEL_SAMPLE_MS);
    return () => clearInterval(timer);
  }, [recording, recorder, stopToReview]);

  // App leaves the screen (Android would silence the microphone anyway): stop, keep the draft.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') stopToReview();
    });
    return () => sub.remove();
  }, [stopToReview]);

  // A call starts: the microphone belongs to the call.
  useEffect(
    () =>
      useCallStore.subscribe((state, previous) => {
        if (isActivePhase(state.phase) && !isActivePhase(previous.phase)) stopToReview();
      }),
    [stopToReview],
  );

  // Leaving the chat discards an unsent recording or draft (never a note being sent: send()
  // clears the draft first and the file is deleted once encrypted).
  const draftRef = useRef(null);
  useEffect(() => {
    draftRef.current = mode === 'review' ? draft : null;
  }, [mode, draft]);
  useEffect(
    () => () => {
      if (modeRef.current === 'holding' || modeRef.current === 'locked') {
        stopRecorder().then((uri) => uri && deleteQuietly(uri));
      } else if (draftRef.current?.uri) {
        deleteQuietly(draftRef.current.uri);
      }
    },
    [stopRecorder],
  );

  return {
    mode,
    durationMs: recording ? live.durationMillis : (draft?.durationMs ?? 0),
    levels,
    draft,
    notice,
    clearNotice: () => setNotice(null),
    start,
    lock,
    stopToReview,
    cancel,
    send,
  };
}
