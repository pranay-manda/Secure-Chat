import Ionicons from '@expo/vector-icons/Ionicons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { decodeWaveform } from '../../media/waveform';
import { colors, spacing, type } from '../../theme';
import { formatDuration } from './AttachmentContent';
import { Waveform } from './Waveform';

/** Slide this far left (px) while holding to cancel, this far up to lock. */
export const CANCEL_DISTANCE = 110;
export const LOCK_DISTANCE = 80;
/** Released sooner than this after the press: a tap, not a recording ("Hold to record"). */
export const QUICK_TAP_MS = 400;

/**
 * The chat composer row: the text box, and on its right the send button (text typed) or the
 * microphone. Holding the microphone records a voice note like WhatsApp: release to send,
 * slide left to cancel, slide up to lock (then Stop to listen first, Delete or Send).
 *
 * @param {{ voice: ReturnType<import('./useVoiceRecorder').useVoiceRecorder>,
 *           input: React.ReactNode, hasText: boolean, onSendText: () => void,
 *           disabled?: boolean }} props
 */
export function VoiceComposer({ voice, input, hasText, onSendText, disabled = false }) {
  const [drag] = useState(() => new Animated.ValueXY());
  const { mode } = voice;

  let left = input;
  if (mode === 'holding') left = <HoldingBar voice={voice} drag={drag} />;
  else if (mode === 'locked') left = <LockedBar voice={voice} />;
  else if (mode === 'review') left = <ReviewBar voice={voice} />;

  // The microphone stays the same element from idle to holding, so the press is not lost.
  const showMic = mode === 'holding' || (mode === 'idle' && !hasText);
  return (
    <View style={styles.composer}>
      {left}
      {showMic ? (
        <MicButton key="mic" voice={voice} drag={drag} disabled={disabled} />
      ) : (
        <Pressable
          key="send"
          onPress={mode === 'idle' ? onSendText : voice.send}
          style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
          accessibilityRole="button"
          accessibilityLabel={mode === 'idle' ? 'Send' : 'Send voice message'}
          testID={mode === 'idle' ? 'send-button' : 'voice-send'}
        >
          <Ionicons name="send" size={20} color={colors.onPrimary} />
        </Pressable>
      )}
    </View>
  );
}

function MicButton({ voice, drag, disabled }) {
  // One press of the microphone: where it started, and what has happened since.
  const gesture = useRef({ active: false, started: false, done: false, at: 0, x: 0, y: 0 });

  const reset = () => drag.setValue({ x: 0, y: 0 });

  const onGrant = (event) => {
    const { pageX, pageY } = event.nativeEvent;
    const g = { active: true, started: false, done: false, at: Date.now(), x: pageX, y: pageY };
    gesture.current = g;
    reset();
    voice.start().then((started) => {
      g.started = started;
      // Let go before recording began (e.g. while the permission dialog was open).
      if (started && !g.active) {
        g.done = true;
        voice.cancel({ hint: true });
      }
    });
  };

  const onMove = (event) => {
    const g = gesture.current;
    if (!g.active || g.done) return;
    const dx = event.nativeEvent.pageX - g.x;
    const dy = event.nativeEvent.pageY - g.y;
    drag.setValue({ x: Math.min(0, dx), y: Math.min(0, dy) });
    if (!g.started) return;
    if (dx < -CANCEL_DISTANCE) {
      g.done = true;
      reset();
      voice.cancel();
    } else if (dy < -LOCK_DISTANCE) {
      g.done = true;
      reset();
      voice.lock();
    }
  };

  const onEnd = (terminated) => {
    const g = gesture.current;
    g.active = false;
    reset();
    if (g.done || !g.started) return; // cancelled / locked already, or not recording yet
    g.done = true;
    if (terminated)
      voice.stopToReview(); // the system took the touch: keep the recording
    else if (Date.now() - g.at < QUICK_TAP_MS) voice.cancel({ hint: true });
    else voice.send();
  };

  const holding = voice.mode === 'holding';
  const lift = drag.y.interpolate({
    inputRange: [-LOCK_DISTANCE, 0],
    outputRange: [-LOCK_DISTANCE / 2, 0],
    extrapolate: 'clamp',
  });
  return (
    <View>
      {holding ? (
        <Animated.View
          style={[styles.lockHint, { transform: [{ translateY: lift }] }]}
          pointerEvents="none"
          testID="voice-lock-hint"
        >
          <Ionicons name="lock-closed-outline" size={18} color={colors.muted} />
          <Ionicons name="chevron-up" size={16} color={colors.muted} />
        </Animated.View>
      ) : null}
      <View
        onStartShouldSetResponder={() => !disabled}
        onResponderTerminationRequest={() => false}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={() => onEnd(false)}
        onResponderTerminate={() => onEnd(true)}
        style={[styles.round, holding && styles.micHolding, disabled && styles.disabled]}
        accessible
        accessibilityRole="button"
        accessibilityLabel="Record a voice message. Hold to record, release to send"
        testID="voice-record"
      >
        <Ionicons name="mic" size={holding ? 28 : 22} color={colors.onPrimary} />
      </View>
    </View>
  );
}

function RecordingDot() {
  return <View style={styles.dot} />;
}

function HoldingBar({ voice, drag }) {
  const slide = drag.x.interpolate({
    inputRange: [-CANCEL_DISTANCE, 0],
    outputRange: [-CANCEL_DISTANCE / 2, 0],
    extrapolate: 'clamp',
  });
  const fade = drag.x.interpolate({
    inputRange: [-CANCEL_DISTANCE, 0],
    outputRange: [0.2, 1],
    extrapolate: 'clamp',
  });
  return (
    <View style={styles.bar} testID="voice-recording-bar">
      <RecordingDot />
      <Text style={styles.timer}>{formatDuration(voice.durationMs)}</Text>
      <Animated.View
        style={[styles.slide, { opacity: fade, transform: [{ translateX: slide }] }]}
        pointerEvents="none"
      >
        <Ionicons name="chevron-back" size={16} color={colors.muted} />
        <Text style={styles.slideText}>Slide to cancel</Text>
      </Animated.View>
    </View>
  );
}

function LockedBar({ voice }) {
  return (
    <View style={styles.bar} testID="voice-recording-bar">
      <Pressable
        onPress={() => voice.cancel()}
        style={styles.barButton}
        accessibilityRole="button"
        accessibilityLabel="Delete voice message"
        testID="voice-cancel"
      >
        <Ionicons name="trash-outline" size={22} color={colors.danger} />
      </Pressable>
      <RecordingDot />
      <Text style={styles.timer}>{formatDuration(voice.durationMs)}</Text>
      <Waveform levels={voice.levels} color={colors.subtle} playedColor={colors.subtle} />
      <Pressable
        onPress={voice.stopToReview}
        style={styles.barButton}
        accessibilityRole="button"
        accessibilityLabel="Stop recording and listen"
        testID="voice-stop"
      >
        <Ionicons name="stop-circle-outline" size={26} color={colors.danger} />
      </Pressable>
    </View>
  );
}

function ReviewBar({ voice }) {
  return (
    <View style={styles.bar} testID="voice-review-bar">
      <Pressable
        onPress={() => voice.cancel()}
        style={styles.barButton}
        accessibilityRole="button"
        accessibilityLabel="Delete voice message"
        testID="voice-cancel"
      >
        <Ionicons name="trash-outline" size={22} color={colors.danger} />
      </Pressable>
      {voice.draft ? <ReviewPlayer key={voice.draft.uri} draft={voice.draft} /> : null}
    </View>
  );
}

/** Plays the recording back before it is sent (the app's own file in cache/Audio). */
function ReviewPlayer({ draft }) {
  const player = useAudioPlayer({ uri: draft.uri }, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      player.seekTo(0).catch(() => {});
    }
  }, [status.didJustFinish, player]);

  const durationMs = status.duration > 0 ? status.duration * 1000 : draft.durationMs;
  const positionMs = (status.currentTime ?? 0) * 1000;
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const levels = decodeWaveform(draft.waveform);
  return (
    <>
      <Pressable
        onPress={() => (status.playing ? player.pause() : player.play())}
        style={styles.barButton}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause' : 'Listen before sending'}
        testID="voice-review-play"
      >
        <Ionicons name={status.playing ? 'pause' : 'play'} size={24} color={colors.primary} />
      </Pressable>
      <Waveform
        levels={levels}
        progress={progress}
        color={colors.subtle}
        playedColor={colors.primary}
        onSeek={(fraction) => player.seekTo((fraction * durationMs) / 1000).catch(() => {})}
      />
      <Text style={styles.timer}>
        {formatDuration(status.playing || positionMs > 0 ? positionMs : durationMs)}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  round: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundPressed: { backgroundColor: colors.primaryPressed },
  micHolding: { transform: [{ scale: 1.25 }] },
  disabled: { opacity: 0.5 },
  lockHint: {
    position: 'absolute',
    bottom: 64,
    alignSelf: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 8,
    elevation: 3,
  },
  bar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.background,
    borderRadius: 24,
    paddingHorizontal: spacing.sm,
    minHeight: 48,
  },
  barButton: { padding: spacing.xs },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger, marginLeft: 4 },
  timer: { ...type.body, color: colors.text, fontVariant: ['tabular-nums'], minWidth: 40 },
  slide: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  slideText: { ...type.secondary },
});
