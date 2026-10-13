import Ionicons from '@expo/vector-icons/Ionicons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardInset } from '../useKeyboardInset';
import { colors, spacing } from '../../theme';

/** Same limit as a typed message: the caption travels in the same encrypted content. */
const CAPTION_MAX_LENGTH = 4000;

function VideoPreview({ uri, width, height }) {
  // The app's own copy (picker or camera), on this phone only.
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = false;
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={{ width, height }}
      contentFit="contain"
      nativeControls
      allowsPictureInPicture={false}
      testID="media-preview-video"
    />
  );
}

/**
 * "Send this?" screen for a photo or video the user just picked or captured, like WhatsApp:
 * the media full screen, a caption box and a Send button. Nothing is encrypted or uploaded
 * until Send; Close (or the back button) discards the app's copy.
 *
 * @param {{ media: { uri: string, contentType: string } | null, initialCaption?: string,
 *           onCancel: () => void, onSend: (caption: string) => void }} props
 */
export function MediaPreview({ media, initialCaption = '', onCancel, onSend }) {
  const open = media != null;
  return (
    <Modal visible={open} animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      {open ? (
        // Keyed by file: a new pick starts with a fresh caption and player.
        <PreviewBody
          key={media.uri}
          media={media}
          initialCaption={initialCaption}
          onCancel={onCancel}
          onSend={onSend}
        />
      ) : null}
    </Modal>
  );
}

function PreviewBody({ media, initialCaption, onCancel, onSend }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset();
  const [caption, setCaption] = useState(initialCaption);
  const isVideo = media.contentType.startsWith('video/');
  const area = { width, height: Math.max(200, height - insets.top - keyboard - 64 - 76) };

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: keyboard }]}>
      <View style={styles.bar}>
        <Pressable
          onPress={onCancel}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel="Discard"
          testID="media-preview-close"
        >
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>
      </View>
      <View style={styles.content}>
        {isVideo ? (
          <VideoPreview uri={media.uri} {...area} />
        ) : (
          <Image
            source={{ uri: media.uri }}
            style={area}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
            testID="media-preview-image"
          />
        )}
      </View>
      <View style={styles.composer}>
        <TextInput
          value={caption}
          onChangeText={setCaption}
          placeholder="Add a caption…"
          placeholderTextColor="#9aa3a8"
          multiline
          maxLength={CAPTION_MAX_LENGTH}
          style={styles.caption}
          accessibilityLabel="Caption"
          testID="media-preview-caption"
        />
        <Pressable
          onPress={() => onSend(caption.trim())}
          style={({ pressed }) => [
            styles.send,
            pressed && { backgroundColor: colors.primaryPressed },
          ]}
          accessibilityRole="button"
          accessibilityLabel={isVideo ? 'Send video' : 'Send photo'}
          testID="media-preview-send"
        >
          <Ionicons name="send" size={22} color={colors.onPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  bar: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm },
  iconButton: { padding: spacing.sm },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  caption: {
    flex: 1,
    minHeight: 48,
    maxHeight: 120,
    borderRadius: 24,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: '#1f2c33',
    color: '#fff',
    fontSize: 16,
  },
  send: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
