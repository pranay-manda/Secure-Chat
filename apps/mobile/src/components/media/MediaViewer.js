import Ionicons from '@expo/vector-icons/Ionicons';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing } from '../../theme';
import { useAppActive, useDecryptedMedia } from './useDecryptedMedia';

const CAPTURE_KEY = 'media-viewer';

function VideoPlayback({ uri, width, height }) {
  // Local file only: nothing is streamed or cached by the player.
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return (
    <VideoView
      player={player}
      style={{ width, height }}
      contentFit="contain"
      nativeControls
      allowsPictureInPicture={false}
      testID="media-viewer-video"
    />
  );
}

/**
 * Full-screen, in-app viewer for a photo or video. The media is decrypted into a temporary
 * private file only while the viewer is open, and there is no share, save or "open with":
 * nothing leaves the app. Screenshots and screen recording are blocked while it is open (this
 * also hides it from the app switcher on Android). Leaving the app closes it.
 */
export function MediaViewer({ item, onClose }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const active = useAppActive();
  const open = item != null;
  const { uri, error } = useDecryptedMedia(item?.messageId, open);

  useEffect(() => {
    if (!open) return undefined;
    preventScreenCaptureAsync(CAPTURE_KEY).catch(() => {});
    return () => {
      allowScreenCaptureAsync(CAPTURE_KEY).catch(() => {});
    };
  }, [open]);

  // Backgrounding deletes the plaintext: close rather than show a broken player on return.
  useEffect(() => {
    if (open && !active) onClose();
  }, [open, active, onClose]);

  const area = { width, height: height - insets.top - insets.bottom - 64 };
  return (
    <Modal visible={open} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.bar}>
          <Pressable
            onPress={onClose}
            style={styles.close}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="media-viewer-close"
          >
            <Ionicons name="close" size={28} color="#fff" />
          </Pressable>
        </View>
        <View style={styles.content}>
          {error ? (
            <Text style={styles.error}>This media could not be opened.</Text>
          ) : !uri ? (
            <ActivityIndicator color="#fff" />
          ) : item.kind === 'video' ? (
            <VideoPlayback uri={uri} {...area} />
          ) : (
            <Image
              source={{ uri }}
              style={area}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
              testID="media-viewer-image"
            />
          )}
        </View>
        {item?.caption ? <Text style={styles.caption}>{item.caption}</Text> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  bar: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm },
  close: { padding: spacing.sm },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#fff', fontSize: 15 },
  caption: { color: '#fff', fontSize: 15, padding: spacing.md },
});
