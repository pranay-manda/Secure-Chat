import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  BackHandler,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  answerCall,
  declineCall,
  dismissEndedCall,
  hangUp,
  switchCamera,
  toggleCamera,
  toggleMute,
  toggleSpeaker,
  useCallStore,
} from '../../calls/callEngine';
import { formatCallDuration } from '../../calls/callHistory';
import { CALL_PHASE, END_REASON, endReasonText, isActivePhase } from '../../calls/callMachine';
import { routeText } from '../../calls/ice';
import { useCallPeer } from '../../calls/useCallPeer';
import { VideoView } from '../../calls/VideoView';
import { Avatar } from '../../components/design';
import { unlockChats } from '../../security/chatLock';
import { colors, radius, spacing, type } from '../../theme';

const STATUS_TEXT = {
  [CALL_PHASE.OUTGOING]: 'Calling…',
  [CALL_PHASE.INCOMING]: 'Incoming voice call',
  [CALL_PHASE.ANSWERING]: 'Connecting…',
  [CALL_PHASE.CONNECTING]: 'Connecting…',
  [CALL_PHASE.RECONNECTING]: 'Reconnecting…',
};

/** Endings caused by a permission the user refused: explained, with a way to fix it. */
const PERMISSION_REASONS = new Set([END_REASON.PERMISSION_DENIED, END_REASON.CAMERA_DENIED]);
const canOpenSettings = typeof Linking.openSettings === 'function';

/** The contact's security code: reviewing (accepting) a new one allows calls again. */
function reviewSecurityCode(peerUserId) {
  if (!peerUserId) return;
  dismissEndedCall();
  router.push(`/security-code/${peerUserId}`);
}

/** The app's own page in the system settings (where a refused permission is turned on). */
function openAppSettings() {
  Promise.resolve()
    .then(() => Linking.openSettings())
    .catch(() => {});
  dismissEndedCall();
}

function Duration({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <Text style={styles.status}>{formatCallDuration(now - since)}</Text>;
}

function RoundButton({
  icon,
  label,
  onPress,
  color = colors.onPrimary,
  background,
  active,
  disabled,
  small,
}) {
  return (
    <View style={styles.action}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{
          ...(active !== undefined && { selected: active }),
          ...(disabled && { disabled: true }),
        }}
        style={({ pressed }) => [
          styles.round,
          small && styles.roundSmall,
          { backgroundColor: background },
          active && styles.roundActive,
          disabled && styles.roundDisabled,
          pressed && { opacity: 0.8 },
        ]}
        testID={`call-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        <Ionicons name={icon} size={small ? 24 : 30} color={active ? colors.text : color} />
      </Pressable>
      <Text style={styles.actionLabel}>{label}</Text>
    </View>
  );
}

/**
 * Full-screen voice or video call. Reads only the call store; every action goes through the
 * call engine. Shows who is calling (name, avatar, and for video calls their camera) only when
 * Chat Lock allows it (see useCallPeer).
 */
export default function CallScreen() {
  const call = useCallStore();
  const peer = useCallPeer(call.peerUserId);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const active = isActivePhase(call.phase);
  const video = call.kind === 'video';

  // When the call is over (after the end reason was shown), leave the screen.
  useEffect(() => {
    if (call.phase !== CALL_PHASE.IDLE) return;
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [call.phase]);

  // Android back must not silently abandon a live call: hang up explicitly instead.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => active);
    return () => sub.remove();
  }, [active]);

  const inCall =
    call.phase === CALL_PHASE.ANSWERING ||
    call.phase === CALL_PHASE.CONNECTING ||
    call.phase === CALL_PHASE.CONNECTED ||
    call.phase === CALL_PHASE.RECONNECTING;
  const connected = call.phase === CALL_PHASE.CONNECTED && call.connectedAt;
  // The other phone's camera, shown only when Chat Lock allows showing who this is.
  const showRemoteVideo = video && call.remoteVideo && call.remoteStreamUrl && !peer.hidden;
  const showLocalVideo = video && call.localStreamUrl && !call.cameraOff && !call.cameraUnavailable;
  const needsPermission = call.phase === CALL_PHASE.ENDED && PERMISSION_REASONS.has(call.endReason);
  // Their security code changed: an outgoing call was stopped, an incoming one cannot be
  // answered until it is reviewed.
  const needsReview =
    (call.phase === CALL_PHASE.ENDED && call.endReason === END_REASON.IDENTITY_CHANGED) ||
    (call.phase === CALL_PHASE.INCOMING && call.identityChanged);

  const status = connected ? (
    <Duration since={call.connectedAt} />
  ) : (
    <Text style={styles.status} testID="call-status">
      {call.phase === CALL_PHASE.ENDED
        ? endReasonText(call.endReason, call.direction)
        : call.phase === CALL_PHASE.INCOMING && video
          ? 'Incoming video call'
          : (STATUS_TEXT[call.phase] ?? '')}
    </Text>
  );

  return (
    <View style={styles.container} testID="call-screen">
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />

      {showRemoteVideo ? (
        // Sized explicitly: on Android (Fabric) an absolute-fill native video view ended up
        // laid out with height 0 and never got a surface. The preview below has fixed sizes too.
        <View
          style={[styles.remote, { width: window.width, height: window.height }]}
          pointerEvents="none"
        >
          <VideoView
            streamUrl={call.remoteStreamUrl}
            style={styles.remoteVideo}
            testID="remote-video"
          />
        </View>
      ) : null}

      <View
        style={[
          styles.overlay,
          { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        pointerEvents="box-none"
      >
        <View style={styles.top}>
          <View style={styles.encrypted}>
            <Ionicons name="lock-closed" size={12} color={colors.callMuted} />
            <Text style={styles.encryptedText}>
              {video ? 'Encrypted video call' : 'Encrypted voice call'}
            </Text>
          </View>
          {showRemoteVideo ? null : peer.hidden ? (
            <View style={styles.lockedAvatar}>
              <Ionicons name="lock-closed" size={44} color={colors.onPrimary} />
            </View>
          ) : (
            <Avatar id={call.peerUserId} name={peer.title} size={112} />
          )}
          <Text style={styles.name} numberOfLines={1} testID="call-peer-name">
            {peer.name}
          </Text>
          {status}
          {needsPermission ? (
            <Text style={styles.hint} testID="permission-hint">
              {call.permissionBlocked
                ? 'CipherChat is not allowed to use it. You can turn it on in Settings.'
                : 'Allow it when asked the next time you call, or turn it on in Settings.'}
            </Text>
          ) : null}
          {needsReview ? (
            <Text style={styles.hint} testID="identity-hint">
              {call.phase === CALL_PHASE.INCOMING
                ? 'Their security code changed. Review it before answering.'
                : 'Their security code changed. Review it before calling.'}
            </Text>
          ) : null}
          {needsReview && !peer.hidden ? (
            <Pressable
              onPress={() => reviewSecurityCode(call.peerUserId)}
              hitSlop={8}
              accessibilityRole="button"
              testID="call-review-security-code"
            >
              <Text style={styles.unlock}>Review security code</Text>
            </Pressable>
          ) : null}
          {video && connected && !call.remoteVideo ? (
            <Text style={styles.hint} testID="remote-camera-off">
              {peer.hidden ? 'Unlock to see their video' : 'Their camera is off'}
            </Text>
          ) : null}
          {call.cameraUnavailable && inCall ? (
            <Text style={styles.hint} testID="camera-unavailable">
              Camera unavailable: audio only
            </Text>
          ) : null}
          {/* Development builds only: which network path the call took (device testing). */}
          {__DEV__ && call.phase === CALL_PHASE.CONNECTED && call.route ? (
            <Text style={styles.route} testID="call-route">
              {routeText(call.route)}
            </Text>
          ) : null}
          {peer.hidden && peer.ready ? (
            <Pressable onPress={() => unlockChats('Unlock to see who is calling')} hitSlop={8}>
              <Text style={styles.unlock}>Unlock to see caller</Text>
            </Pressable>
          ) : null}
        </View>

        {video && (inCall || call.phase === CALL_PHASE.OUTGOING) ? (
          <View style={[styles.preview, { top: insets.top + spacing.md }]} testID="local-preview">
            {showLocalVideo ? (
              <VideoView
                streamUrl={call.localStreamUrl}
                mirror={call.facing === 'user'}
                style={styles.previewVideo}
                testID="local-video"
              />
            ) : (
              <View style={styles.previewOff}>
                <Ionicons name="videocam-off" size={28} color={colors.callMuted} />
              </View>
            )}
          </View>
        ) : null}

        {call.phase === CALL_PHASE.INCOMING ? (
          <View style={styles.row}>
            <RoundButton
              icon="close"
              label="Decline"
              onPress={declineCall}
              background={colors.danger}
            />
            <RoundButton
              icon={video ? 'videocam' : 'call'}
              label="Accept"
              onPress={answerCall}
              background={colors.callAccept}
            />
          </View>
        ) : (
          <View style={[styles.row, video && styles.rowVideo]}>
            {video && (inCall || call.phase === CALL_PHASE.OUTGOING) ? (
              <RoundButton
                icon={call.cameraOff ? 'videocam-off' : 'videocam'}
                label={call.cameraOff ? 'Camera on' : 'Camera off'}
                onPress={toggleCamera}
                background={colors.callControl}
                active={call.cameraOff}
                disabled={call.cameraUnavailable}
                small
              />
            ) : null}
            {video && (inCall || call.phase === CALL_PHASE.OUTGOING) ? (
              <RoundButton
                icon="camera-reverse"
                label="Flip camera"
                onPress={switchCamera}
                background={colors.callControl}
                disabled={call.cameraOff || call.cameraUnavailable}
                small
              />
            ) : null}
            {inCall ? (
              <RoundButton
                icon={call.muted ? 'mic-off' : 'mic'}
                label={call.muted ? 'Unmute' : 'Mute'}
                onPress={toggleMute}
                background={colors.callControl}
                active={call.muted}
                small={video}
              />
            ) : null}
            {inCall || call.phase === CALL_PHASE.OUTGOING ? (
              <RoundButton
                icon="volume-high"
                label="Speaker"
                onPress={toggleSpeaker}
                background={colors.callControl}
                active={call.speaker}
                small={video}
              />
            ) : null}
            {active ? (
              <RoundButton
                icon="call"
                label="End call"
                onPress={hangUp}
                background={colors.danger}
                small={video}
              />
            ) : null}
            {needsPermission && canOpenSettings ? (
              <RoundButton
                icon="settings-outline"
                label="Open Settings"
                onPress={openAppSettings}
                background={colors.callControl}
              />
            ) : null}
            {needsPermission || (needsReview && call.phase === CALL_PHASE.ENDED) ? (
              <RoundButton
                icon="close"
                label="Close"
                onPress={dismissEndedCall}
                background={colors.callControl}
              />
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.callBackground },
  remote: { position: 'absolute', top: 0, left: 0, backgroundColor: '#000' },
  remoteVideo: { flex: 1 },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  top: { alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xl },
  encrypted: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.xl },
  encryptedText: { ...type.caption, color: colors.callMuted },
  lockedAvatar: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: colors.callControl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { ...type.title, color: colors.onPrimary, maxWidth: 320, textAlign: 'center' },
  status: { ...type.body, color: colors.callMuted },
  hint: { ...type.caption, color: colors.callMuted },
  route: { ...type.caption, color: colors.callMuted },
  unlock: { ...type.body, color: colors.onPrimary, textDecorationLine: 'underline' },
  preview: {
    position: 'absolute',
    right: spacing.lg,
    width: 108,
    height: 150,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.callControl,
  },
  previewVideo: { flex: 1 },
  previewOff: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: spacing.xxl,
    paddingHorizontal: spacing.md,
  },
  rowVideo: { gap: spacing.md },
  action: { alignItems: 'center', gap: spacing.sm },
  round: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundSmall: { width: 56, height: 56, borderRadius: 28 },
  roundActive: { backgroundColor: colors.onPrimary },
  roundDisabled: { opacity: 0.4 },
  actionLabel: { ...type.caption, color: colors.onPrimary },
});
