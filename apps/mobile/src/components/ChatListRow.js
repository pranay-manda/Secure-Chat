import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { peerLabel } from '../messaging/hooks';
import { bumpRevision } from '../messaging/messagingEngine';
import { chatLockErrorMessage, lockConversation, unlockConversation } from '../security/chatLock';
import { colors, formatListTime, radius, spacing, type } from '../theme';
import { Avatar } from './design';

const STATUS_ICON = {
  sending: { name: 'time-outline', color: colors.subtle },
  sent: { name: 'checkmark', color: colors.subtle },
  delivered: { name: 'checkmark-done', color: colors.subtle },
  read: { name: 'checkmark-done', color: colors.read },
  failed: { name: 'alert-circle', color: colors.danger },
};

/** Chat-list label of a photo, video or voice note (its caption, if any, follows it). */
const ATTACHMENT_PREVIEW = {
  image: { icon: 'image-outline', label: 'Photo' },
  video: { icon: 'videocam-outline', label: 'Video' },
  audio: { icon: 'musical-note-outline', label: 'Audio' },
  voice: { icon: 'mic-outline', label: 'Voice message' },
};

function Preview({ item }) {
  if (item.lastStatus === 'undecryptable') {
    return <Text style={styles.previewMuted}>🔒 Message could not be decrypted</Text>;
  }
  if (item.lastStatus === 'identity_pending') {
    return <Text style={styles.previewMuted}>🛡 Security code changed</Text>;
  }
  if (item.lastStatus === 'unsupported') {
    return <Text style={styles.previewMuted}>Message can’t be shown</Text>;
  }
  if (item.lastBody == null) return <Text style={styles.previewMuted}>No messages yet</Text>;
  const status = item.lastDirection === 'out' ? STATUS_ICON[item.lastStatus] : null;
  const media = item.lastAttachmentKind
    ? ATTACHMENT_PREVIEW[item.lastVoiceNote === 1 ? 'voice' : item.lastAttachmentKind]
    : null;
  return (
    <View style={styles.previewRow}>
      {status ? <Ionicons name={status.name} size={16} color={status.color} /> : null}
      {media ? <Ionicons name={media.icon} size={16} color={colors.muted} /> : null}
      <Text style={[styles.preview, item.unread > 0 && styles.previewUnread]} numberOfLines={1}>
        {media ? item.lastBody || media.label : item.lastBody}
      </Text>
    </View>
  );
}

/** Chat options (long press): lock or unlock. Both require device authentication. */
export function showChatOptions(item, { locked }) {
  const run = async () => {
    const result = locked
      ? await unlockConversation(item.peerUserId)
      : await lockConversation(item.peerUserId);
    const message = result.ok ? null : chatLockErrorMessage(result.error);
    if (message) Alert.alert('Chat Lock', message);
    else if (result.ok) bumpRevision();
  };
  Alert.alert(peerLabel(item.peerUserId, item.title, item.peerPhone), undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: locked ? 'Unlock chat' : 'Lock chat', onPress: run },
  ]);
}

/** One conversation in a chat list. Only rendered for chats the user may currently see. */
export function ChatListRow({ item, locked = false }) {
  const name = peerLabel(item.peerUserId, item.title, item.peerPhone);
  const unread = item.unread > 0;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => router.push(`/chat/${item.peerUserId}`)}
      onLongPress={() => showChatOptions(item, { locked })}
      accessibilityRole="button"
      accessibilityLabel={`${name}${unread ? `, ${item.unread} unread` : ''}`}
      accessibilityHint="Long press for chat options"
      testID={`conversation-${item.peerUserId}`}
    >
      <Avatar id={item.peerUserId} name={item.title} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {locked ? <Ionicons name="lock-closed" size={14} color={colors.muted} /> : null}
          <Text style={[styles.time, unread && styles.timeUnread]}>
            {formatListTime(item.sortAt)}
          </Text>
        </View>
        <View style={styles.rowBottom}>
          <Preview item={item} />
          {unread ? (
            <Text style={styles.badge}>{item.unread > 99 ? '99+' : item.unread}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Entry to the Locked chats folder. Reveals only that locked chats exist (and whether any has
 * unread messages): no names, previews or counts before authentication.
 */
export function LockedChatsEntry({ hasUnread, onPress }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Locked chats${hasUnread ? ', new messages' : ''}`}
      testID="locked-chats-entry"
    >
      <View style={styles.lockIcon}>
        <Ionicons name="lock-closed" size={22} color={colors.primary} />
      </View>
      <View style={[styles.rowBody, styles.lockedBody]}>
        <Text style={styles.name}>Locked chats</Text>
        {hasUnread ? <View style={styles.dot} /> : null}
        <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: { backgroundColor: colors.surface },
  rowBody: {
    flex: 1,
    gap: 3,
    paddingBottom: spacing.md,
    marginBottom: -spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  lockedBody: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 36 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...type.heading, flex: 1 },
  time: type.caption,
  timeUnread: { color: colors.primary, fontWeight: '600' },
  previewRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  preview: { ...type.secondary, flexShrink: 1 },
  previewUnread: { color: colors.text },
  previewMuted: { ...type.secondary, flex: 1, fontStyle: 'italic' },
  badge: {
    minWidth: 22,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.primary,
    color: colors.onPrimary,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 22,
  },
  lockIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
});
