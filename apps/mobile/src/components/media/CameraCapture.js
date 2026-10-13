import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isActivePhase } from '../../calls/callMachine';
import { useCallStore } from '../../calls/callEngine';
import { withSystemUi } from '../../lib/systemUi';
import { deleteQuietly } from '../../media/mediaFiles';
import { colors, spacing } from '../../theme';
import { formatDuration } from './AttachmentContent';
import { useAppActive } from './useDecryptedMedia';

/** Longest video the camera records (keeps files well under the 100 MB attachment limit). */
export const CAMERA_VIDEO_MAX_SECONDS = 180;
/** Holding the shutter this long starts a video instead of taking a photo. */
const HOLD_FOR_VIDEO_MS = 350;

/**
 * In-app camera, like WhatsApp: tap the shutter for a photo, hold it to record a video (release
 * to stop), flip between cameras, flash for photos. The picture or video is written only to the
 * app's private cache (cache/Camera), never to the gallery, and goes to the preview screen
 * (MediaPreview) before anything is sent; it is deleted once encrypted or discarded.
 *
 * @param {{ visible: boolean, onClose: () => void,
 *           onCaptured: (media: { uri, contentType, width?, height?, durationMs? }) => void }} props
 */
export function CameraCapture({ visible, onClose, onCaptured }) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {visible ? <CameraBody onClose={onClose} onCaptured={onCaptured} /> : null}
    </Modal>
  );
}

function CameraBody({ onClose, onCaptured }) {
  const insets = useSafeAreaInsets();
  const camera = useRef(null);
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState('back');
  const [flash, setFlash] = useState('off');
  const [mode, setMode] = useState('picture');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(null); // { startedAt }
  const [elapsedMs, setElapsedMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const holdTimer = useRef(null);
  const recordingRef = useRef(false);
  const holding = useRef(false); // the shutter is pressed
  const pendingHold = useRef(false); // held in photo mode: switching to video to record
  const heldVideo = useRef(false); // the current video lasts while the shutter is held
  const inCall = useCallStore((s) => isActivePhase(s.phase));
  const active = useAppActive();

  // Ask for the camera once, when the camera opens (the user pressed the camera button).
  useEffect(() => {
    if (cameraPermission && !cameraPermission.granted && cameraPermission.canAskAgain) {
      withSystemUi(requestCamera).catch(() => {});
    }
  }, [cameraPermission, requestCamera]);

  // The call owns the camera; leaving the app closes it (Android would anyway).
  useEffect(() => {
    if (inCall || !active) {
      if (recordingRef.current) camera.current?.stopRecording();
      onClose();
    }
  }, [inCall, active, onClose]);

  // Recording timer.
  useEffect(() => {
    if (!recording) return undefined;
    const timer = setInterval(() => setElapsedMs(Date.now() - recording.startedAt), 250);
    return () => clearInterval(timer);
  }, [recording]);

  useEffect(() => () => clearTimeout(holdTimer.current), []);

  const takePhoto = async () => {
    if (!camera.current || !ready || busy) return;
    setBusy(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.8, exif: false });
      onCaptured({
        uri: photo.uri,
        contentType: 'image/jpeg',
        width: photo.width,
        height: photo.height,
      });
    } catch {
      setNotice('The photo could not be taken. Try again.');
    } finally {
      setBusy(false);
    }
  };

  /** `cameraReady`: called from onCameraReady, before the `ready` state has updated. */
  const startVideo = async ({ cameraReady = ready } = {}) => {
    if (!camera.current || !cameraReady || busy || recordingRef.current) return;
    if (!micPermission?.granted) {
      const result = await withSystemUi(requestMic).catch(() => null);
      if (!result?.granted) {
        setNotice('Microphone permission is needed to record a video with sound.');
        return;
      }
    }
    recordingRef.current = true;
    const startedAt = Date.now();
    setRecording({ startedAt });
    setElapsedMs(0);
    setNotice(null);
    try {
      const video = await camera.current.recordAsync({ maxDuration: CAMERA_VIDEO_MAX_SECONDS });
      const durationMs = Date.now() - startedAt;
      if (video?.uri && durationMs >= 500) {
        onCaptured({ uri: video.uri, contentType: 'video/mp4', durationMs });
      } else if (video?.uri) {
        deleteQuietly(video.uri); // a slip of the finger, not a video
      }
    } catch {
      setNotice('The video could not be recorded. Try again.');
    } finally {
      recordingRef.current = false;
      setRecording(null);
      if (heldVideo.current) {
        heldVideo.current = false;
        switchMode('picture'); // a held video returns to photos, like WhatsApp
      }
    }
  };

  const stopVideo = () => {
    if (recordingRef.current) camera.current?.stopRecording();
  };

  // Video needs the camera in video mode; Android rebinds the camera, which takes a moment.
  const switchMode = (next) => {
    setMode(next);
    setReady(false);
  };

  const onCameraReady = () => {
    setReady(true);
    // Held in photo mode: the camera switched to video for this hold; record if still held.
    if (pendingHold.current) {
      pendingHold.current = false;
      if (holding.current) {
        heldVideo.current = true;
        startVideo({ cameraReady: true });
      } else {
        switchMode('picture');
      }
    }
  };

  // Shutter: tap = photo, hold = video while held. In video mode: tap starts / stops.
  const onPressIn = () => {
    holding.current = true;
    if (mode === 'video') return;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      pendingHold.current = true;
      switchMode('video');
    }, HOLD_FOR_VIDEO_MS);
  };
  const onPressOut = () => {
    holding.current = false;
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      takePhoto();
    } else if (heldVideo.current) {
      stopVideo();
    } else if (pendingHold.current) {
      // Released before the camera was ready to record: nothing recorded (see onCameraReady).
    } else if (mode === 'video') {
      if (recordingRef.current) stopVideo();
      else startVideo();
    }
  };

  if (!cameraPermission) return <View style={styles.root} />;
  if (!cameraPermission.granted) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.permissionText}>
          {cameraPermission.canAskAgain
            ? 'CipherChat needs the camera to take photos and videos.'
            : 'Camera access is off for CipherChat. Turn it on in Settings.'}
        </Text>
        <Pressable
          onPress={() =>
            cameraPermission.canAskAgain
              ? withSystemUi(requestCamera).catch(() => {})
              : Linking.openSettings().catch(() => {})
          }
          style={styles.permissionButton}
          accessibilityRole="button"
          testID="camera-permission"
        >
          <Text style={styles.permissionButtonText}>
            {cameraPermission.canAskAgain ? 'Allow camera' : 'Open Settings'}
          </Text>
        </Pressable>
        <Pressable onPress={onClose} accessibilityRole="button" style={styles.permissionClose}>
          <Text style={styles.permissionText}>Not now</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        ref={camera}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mode={mode}
        flash={flash}
        mirror={facing === 'front'}
        videoQuality="720p"
        onCameraReady={onCameraReady}
        onMountError={() => setNotice('The camera could not be started.')}
        testID="camera-view"
      />
      <View style={[styles.top, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          onPress={onClose}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel="Close camera"
          testID="camera-close"
        >
          <Ionicons name="close" size={30} color="#fff" />
        </Pressable>
        {recording ? (
          <View style={styles.timer}>
            <View style={styles.recDot} />
            <Text style={styles.timerText}>{formatDuration(elapsedMs)}</Text>
          </View>
        ) : null}
        <Pressable
          onPress={() => setFlash((f) => (f === 'off' ? 'on' : 'off'))}
          style={styles.iconButton}
          disabled={mode === 'video'}
          accessibilityRole="button"
          accessibilityLabel={flash === 'off' ? 'Flash off' : 'Flash on'}
          testID="camera-flash"
        >
          <Ionicons
            name={flash === 'off' ? 'flash-off' : 'flash'}
            size={26}
            color={mode === 'video' ? 'rgba(255,255,255,0.4)' : '#fff'}
          />
        </Pressable>
      </View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + spacing.lg }]}>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <View style={styles.controls}>
          <View style={styles.side} />
          <Pressable
            onPressIn={onPressIn}
            onPressOut={onPressOut}
            disabled={!ready || busy}
            style={[styles.shutter, recording && styles.shutterRecording]}
            accessibilityRole="button"
            accessibilityLabel={
              mode === 'video'
                ? recording
                  ? 'Stop recording'
                  : 'Record video'
                : 'Take photo. Hold to record a video'
            }
            testID="camera-shutter"
          >
            <View style={[styles.shutterInner, recording && styles.shutterInnerRecording]} />
          </Pressable>
          <Pressable
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            disabled={Boolean(recording)}
            style={styles.side}
            accessibilityRole="button"
            accessibilityLabel="Flip camera"
            testID="camera-flip"
          >
            <Ionicons name="camera-reverse-outline" size={32} color="#fff" />
          </Pressable>
        </View>
        <View style={styles.modes}>
          {['video', 'picture'].map((m) => (
            <Pressable
              key={m}
              onPress={() => {
                if (recording || m === mode) return;
                switchMode(m);
                setNotice(null);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m }}
              testID={`camera-mode-${m}`}
            >
              <Text style={[styles.mode, mode === m && styles.modeActive]}>
                {m === 'video' ? 'Video' : 'Photo'}
              </Text>
            </Pressable>
          ))}
        </View>
        {mode === 'picture' && !recording ? (
          <Text style={styles.hint}>Tap for photo, hold for video</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.md },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
  },
  iconButton: { padding: spacing.sm },
  timer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#e53935' },
  timerText: { color: '#fff', fontSize: 15, fontVariant: ['tabular-nums'] },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
  notice: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 14,
    marginBottom: spacing.md,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    alignSelf: 'stretch',
  },
  side: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterRecording: { borderColor: '#e53935' },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
  shutterInnerRecording: { width: 30, height: 30, borderRadius: 6, backgroundColor: '#e53935' },
  modes: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md },
  mode: { color: 'rgba(255,255,255,0.7)', fontSize: 15, fontWeight: '600' },
  modeActive: { color: '#fff', textDecorationLine: 'underline' },
  hint: { color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: spacing.sm },
  permissionText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  permissionButton: {
    backgroundColor: colors.primary,
    borderRadius: 24,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  permissionButtonText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
  permissionClose: { padding: spacing.sm },
});
