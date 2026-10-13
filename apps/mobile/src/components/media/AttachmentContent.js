import Ionicons from '@expo/vector-icons/Ionicons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { create } from 'zustand';

import { isActivePhase } from '../../calls/callMachine';
import { useCallStore } from '../../calls/callEngine';
import { MEDIA_ERROR, retryDownload } from '../../media/attachmentService';
import { ATTACHMENT_STATE } from '../../media/attachmentStore';
import { decodeWaveform } from '../../media/waveform';
import { colors, radius, spacing, type } from '../../theme';
import { useAppActive, useDecryptedMedia } from './useDecryptedMedia';
import { Waveform } from './Waveform';

const MAX_PREVIEW_WIDTH = 240;

/** mm:ss (or h:mm:ss) from milliseconds. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const LABEL = { image: 'Photo', video: 'Video', audio: 'Audio' };

/** Whether the encrypted file is on this phone (sent from here, or downloaded and verified). */
const isLocal = (message) =>
  message.direction === 'out' || message.attachment.state === ATTACHMENT_STATE.DOWNLOADED;

function previewSize({ width, height }) {
  const ratio = width > 0 && height > 0 ? Math.min(Math.max(height / width, 0.5), 1.6) : 0.75;
  return { width: MAX_PREVIEW_WIDTH, height: Math.round(MAX_PREVIEW_WIDTH * ratio) };
}

/** Not on the phone yet: downloading, waiting, or failed (tap to retry when it can help). */
function TransferState({ message }) {
  const { attachment } = message;
  const label = attachment.voiceNote ? 'Voice message' : LABEL[attachment.kind];
  if (attachment.state === ATTACHMENT_STATE.FAILED) {
    const expired = attachment.error === MEDIA_ERROR.EXPIRED;
    return (
      <Pressable
        onPress={expired ? undefined : () => retryDownload(message.id)}
        disabled={expired}
        style={styles.transfer}
        accessibilityRole={expired ? undefined : 'button'}
        accessibilityHint={expired ? undefined : 'Downloads it again'}
        testID={`attachment-failed-${message.id}`}
      >
        <Ionicons name={expired ? 'time-outline' : 'refresh'} size={22} color={colors.danger} />
        <Text style={styles.transferText}>
          {expired
            ? `${label} no longer available`
            : attachment.error === MEDIA_ERROR.CORRUPT
              ? `${label} was damaged · tap to retry`
              : `${label} couldn’t be downloaded · tap to retry`}
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.transfer} testID={`attachment-pending-${message.id}`}>
      <ActivityIndicator size="small" color={colors.muted} />
      <Text style={styles.transferText}>
        {attachment.error === MEDIA_ERROR.TEMPORARY
          ? `${label} · waiting for connection`
          : `Downloading ${label.toLowerCase()}…`}
      </Text>
    </View>
  );
}

function ImagePreview({ message, onOpen }) {
  const size = previewSize(message.attachment);
  const { uri, error } = useDecryptedMedia(message.id, true);
  return (
    <Pressable
      onPress={() => onOpen({ messageId: message.id, kind: 'image', caption: message.body })}
      accessibilityRole="imagebutton"
      accessibilityLabel="Photo. Opens full screen"
      testID={`attachment-image-${message.id}`}
    >
      <View style={[styles.media, size]}>
        {uri ? (
          <Image
            source={{ uri }}
            style={size}
            resizeMode="cover"
            accessibilityIgnoresInvertColors
          />
        ) : error ? (
          <Ionicons name="image-outline" size={32} color={colors.muted} />
        ) : (
          <ActivityIndicator color={colors.muted} />
        )}
      </View>
    </Pressable>
  );
}

function VideoTile({ message, onOpen }) {
  const size = previewSize(message.attachment);
  return (
    <Pressable
      onPress={() => onOpen({ messageId: message.id, kind: 'video', caption: message.body })}
      style={[styles.media, styles.video, size]}
      accessibilityRole="button"
      accessibilityLabel={`Video, ${formatDuration(message.attachment.durationMs)}. Plays full screen`}
      testID={`attachment-video-${message.id}`}
    >
      <View style={styles.play}>
        <Ionicons name="play" size={30} color="#fff" />
      </View>
      {message.attachment.durationMs ? (
        <Text style={styles.videoDuration}>{formatDuration(message.attachment.durationMs)}</Text>
      ) : null}
    </Pressable>
  );
}

/** Only one voice note plays at a time; the chosen speed applies to all of them. */
const useNowPlaying = create(() => ({ messageId: null, rate: 1 }));
const RATES = [1, 1.5, 2];

function VoiceNote({ message }) {
  const [wanted, setWanted] = useState(false);
  const pendingSeek = useRef(null); // a seek made before the note was decrypted
  const nowPlaying = useNowPlaying((s) => s.messageId);
  const rate = useNowPlaying((s) => s.rate);
  const inCall = useCallStore((s) => isActivePhase(s.phase));
  const active = useAppActive();
  const { uri, error } = useDecryptedMedia(message.id, wanted);
  const player = useAudioPlayer(null, { updateInterval: 100 });
  const status = useAudioPlayerStatus(player);
  const levels = useMemo(
    () => decodeWaveform(message.attachment.waveform),
    [message.attachment.waveform],
  );

  useEffect(() => {
    if (uri) {
      player.replace({ uri });
      if (useNowPlaying.getState().messageId === message.id) player.play();
    }
  }, [uri, player, message.id]);

  // Playback speed (1×, 1.5×, 2×), kept while the app is open.
  useEffect(() => {
    if (uri) player.setPlaybackRate?.(rate);
  }, [uri, rate, player]);

  // A seek before the note was decrypted: apply it once the audio is loaded.
  useEffect(() => {
    if (pendingSeek.current != null && uri && status.duration > 0) {
      player.seekTo(pendingSeek.current * status.duration).catch(() => {});
      pendingSeek.current = null;
    }
  }, [uri, status.duration, player]);

  // Another voice note started, or a call began: pause this one.
  useEffect(() => {
    if ((nowPlaying !== message.id || inCall) && status.playing) player.pause();
  }, [nowPlaying, inCall, message.id, player, status.playing]);

  // Leaving the app stops playback for good (no surprise resume when coming back).
  useEffect(() => {
    if (!active && useNowPlaying.getState().messageId === message.id) {
      useNowPlaying.setState({ messageId: null });
    }
  }, [active, message.id]);

  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      player.seekTo(0).catch(() => {});
    }
  }, [status.didJustFinish, player]);

  useEffect(
    () => () => {
      if (useNowPlaying.getState().messageId === message.id) {
        useNowPlaying.setState({ messageId: null });
      }
    },
    [message.id],
  );

  const play = () => {
    useNowPlaying.setState({ messageId: message.id });
    if (uri) player.play();
    else setWanted(true); // decrypt, then play (effect above)
  };

  const toggle = () => {
    if (inCall) return;
    if (status.playing) player.pause();
    else play();
  };

  const durationMs = status.duration > 0 ? status.duration * 1000 : message.attachment.durationMs;
  const positionMs = status.currentTime * 1000;
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const loading = wanted && !uri && !error;
  const started = status.playing || positionMs > 0;

  const seek = (fraction) => {
    if (inCall) return;
    if (uri && status.duration > 0) player.seekTo(fraction * status.duration).catch(() => {});
    else {
      pendingSeek.current = fraction;
      play();
    }
  };

  const nextRate = () => {
    const i = RATES.indexOf(rate);
    useNowPlaying.setState({ rate: RATES[(i + 1) % RATES.length] });
  };

  return (
    <View style={styles.voice} testID={`attachment-voice-${message.id}`}>
      <Pressable
        onPress={toggle}
        disabled={inCall || loading}
        style={styles.voiceButton}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause voice message' : 'Play voice message'}
        testID={`voice-toggle-${message.id}`}
      >
        {loading ? (
          <ActivityIndicator color={colors.muted} size="small" />
        ) : (
          <Ionicons name={status.playing ? 'pause' : 'play'} size={30} color={colors.muted} />
        )}
      </Pressable>
      <View style={styles.voiceBody}>
        <Waveform
          levels={levels}
          progress={progress}
          color={colors.subtle}
          playedColor={colors.primary}
          onSeek={error ? undefined : seek}
          testID={`voice-wave-${message.id}`}
        />
        <View style={styles.voiceMeta}>
          <Text style={styles.voiceTime}>
            {error
              ? 'Couldn’t play this voice message'
              : formatDuration(started ? positionMs : durationMs)}
          </Text>
        </View>
      </View>
      {started && !error ? (
        <Pressable
          onPress={nextRate}
          style={styles.rate}
          accessibilityRole="button"
          accessibilityLabel={`Playback speed ${rate} times`}
          testID={`voice-rate-${message.id}`}
        >
          <Text style={styles.rateText}>{rate}×</Text>
        </Pressable>
      ) : (
        <View style={styles.voiceBadge}>
          <Ionicons name="mic" size={20} color={colors.onPrimary} />
        </View>
      )}
    </View>
  );
}

/**
 * The media part of a message bubble. Rendered only inside the chat screen, i.e. behind
 * ChatLockGate. Photos are decrypted for display while visible; videos and voice notes only
 * when the user plays them.
 */
export function AttachmentContent({ message, onOpen }) {
  const { attachment } = message;
  if (!isLocal(message)) return <TransferState message={message} />;
  if (attachment.kind === 'image') return <ImagePreview message={message} onOpen={onOpen} />;
  if (attachment.kind === 'video') return <VideoTile message={message} onOpen={onOpen} />;
  return <VoiceNote message={message} />;
}

const styles = StyleSheet.create({
  media: {
    borderRadius: radius.md - 4,
    overflow: 'hidden',
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  video: { backgroundColor: '#1d2327' },
  play: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoDuration: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.xs,
    color: '#fff',
    fontSize: 12,
  },
  transfer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    minWidth: 200,
  },
  transferText: { ...type.secondary, flexShrink: 1 },
  voice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    width: 250,
    paddingVertical: 2,
  },
  voiceButton: { width: 34, alignItems: 'center', justifyContent: 'center' },
  voiceBody: { flex: 1, paddingTop: 6 },
  voiceMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  voiceTime: { fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'] },
  voiceBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rate: {
    width: 40,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
