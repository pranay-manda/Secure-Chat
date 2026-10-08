import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuthStore } from '../../../auth/authStore';
import { ChatLockGate } from '../../../components/ChatLockGate';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { Avatar, IconButton } from '../../../components/design';
import { peerLabel, useChat } from '../../../messaging/hooks';
import { UNTRUSTED_IDENTITY } from '../../../messaging/messageStore';
import {
  bumpRevision,
  markConversationRead,
  retryFailedMessage,
  sendMessage,
  useMessagingStore,
} from '../../../messaging/messagingEngine';
import {
  chatLockErrorMessage,
  lockConversation,
  unlockConversation,
} from '../../../security/chatLock';
import { colors, formatClock, formatDay, radius, spacing, type } from '../../../theme';

/** Max characters per message (keeps the ciphertext well under the API's size limit). */
const MAX_LENGTH = 4000;

const TICKS = {
  sending: { name: 'time-outline', color: colors.subtle, label: 'Sending' },
  sent: { name: 'checkmark', color: colors.subtle, label: 'Sent' },
  delivered: { name: 'checkmark-done', color: colors.subtle, label: 'Delivered' },
  read: { name: 'checkmark-done', color: colors.read, label: 'Read' },
  failed: { name: 'alert-circle', color: colors.danger, label: 'Not sent' },
};

/**
 * Height of the on-screen keyboard. The app is edge-to-edge (the screen reaches the bottom of
 * the display and the window does not resize), so padding the screen by this keeps the
 * composer directly above the keyboard on both platforms.
 */
function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [
      Keyboard.addListener(show, (e) => setHeight(e.endCoordinates.height)),
      Keyboard.addListener(hide, () => setHeight(0)),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);
  return height;
}

/**
 * Security-code notices for the timeline: when a change was detected and, once accepted, when
 * the user accepted it.
 */
function identityNotices(events) {
  const notices = [];
  for (const event of events ?? []) {
    notices.push({ kind: 'notice', key: `ic${event.id}`, at: event.detectedAt, type: 'changed' });
    if (event.status === 'accepted' && event.resolvedAt) {
      notices.push({
        kind: 'notice',
        key: `ia${event.id}`,
        at: event.resolvedAt,
        type: 'accepted',
      });
    }
  }
  return notices;
}

/** Newest-first messages and notices, with a day separator after the last item of each day. */
function withDaySeparators(messages, notices = []) {
  const items = [
    ...messages.map((message) => ({
      kind: 'message',
      key: `m${message.id}`,
      at: message.createdAt,
      message,
    })),
    ...notices,
  ]
    // Newest first; at the same time a notice comes before (i.e. below, in this order) the
    // message it is about.
    .sort((a, b) => b.at - a.at || (a.kind === 'notice') - (b.kind === 'notice'));
  const rows = [];
  items.forEach((item, i) => {
    rows.push(item);
    const older = items[i + 1];
    if (!older || formatDay(older.at) !== formatDay(item.at)) {
      rows.push({ kind: 'day', key: `d${item.key}`, label: formatDay(item.at) });
    }
  });
  return rows;
}

function SecurityNotice({ notice, name }) {
  return (
    <View style={styles.securityNotice} testID={`security-notice-${notice.type}`}>
      <Ionicons name="shield-checkmark-outline" size={14} color={colors.muted} />
      <Text style={styles.securityNoticeText}>
        {notice.type === 'accepted'
          ? `You accepted ${name}'s new security code.`
          : `${name}'s security code changed.`}
      </Text>
    </View>
  );
}

/**
 * Shown while a contact's new security code is undecided. Only rendered inside ChatContent,
 * i.e. after Chat Lock authentication for a locked chat.
 */
function SecurityCodeBanner({ peer, name }) {
  return (
    <View style={styles.banner} testID="security-code-banner">
      <Ionicons name="shield-outline" size={22} color={colors.warning} />
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>Security code changed</Text>
        <Text style={styles.bannerBody}>
          {name}&apos;s security code changed. This usually happens when they reinstall Secure Chat
          or sign in again. Their new messages are held, and yours won&apos;t be sent, until you
          review and accept the new code.
        </Text>
      </View>
      <Pressable
        onPress={() => router.push(`/security-code/${peer}`)}
        style={styles.bannerButton}
        accessibilityRole="button"
        testID="review-security-code"
      >
        <Text style={styles.bannerButtonText}>Review</Text>
      </Pressable>
    </View>
  );
}

function Bubble({ message, onRetry }) {
  const outgoing = message.direction === 'out';
  const failed = message.status === 'failed';
  const tick = outgoing ? TICKS[message.status] : null;

  return (
    <Pressable
      onPress={failed ? onRetry : undefined}
      disabled={!failed}
      style={[styles.bubble, outgoing ? styles.outgoing : styles.incoming]}
      accessibilityRole={failed ? 'button' : undefined}
      accessibilityHint={failed ? 'Tap to send again' : undefined}
      testID={`message-${message.id}`}
    >
      {message.status === 'undecryptable' ? (
        <Text style={styles.undecryptable}>🔒 This message could not be decrypted.</Text>
      ) : message.status === 'identity_pending' ? (
        <Text style={styles.undecryptable}>
          🔒 Waiting for you to accept this contact&apos;s new security code.
        </Text>
      ) : (
        <Text style={styles.body} selectable>
          {message.body}
        </Text>
      )}
      <View style={styles.meta}>
        <Text style={styles.time}>{formatClock(message.createdAt)}</Text>
        {tick ? (
          <Ionicons name={tick.name} size={15} color={tick.color} accessibilityLabel={tick.label} />
        ) : null}
      </View>
      {failed ? (
        <Text style={styles.failed}>
          {message.error === 'TEMPORARY'
            ? 'Waiting for connection · tap to retry'
            : message.error === UNTRUSTED_IDENTITY
              ? 'Not sent · security code changed'
              : 'Not sent · tap to retry'}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Chat header; tapping it opens the contact's security code. */
function Header({ peer, title, identityChanged }) {
  return (
    <Pressable
      style={styles.header}
      onPress={() => router.push(`/security-code/${peer}`)}
      accessibilityRole="button"
      accessibilityHint="Shows the security code"
      testID="chat-header"
    >
      <Avatar id={peer} name={title} size={36} />
      <View style={styles.headerText}>
        <Text style={type.heading} numberOfLines={1}>
          {peerLabel(peer, title)}
        </Text>
        <View style={styles.encrypted}>
          <Ionicons
            name={identityChanged ? 'shield-outline' : 'lock-closed'}
            size={11}
            color={identityChanged ? colors.warning : colors.muted}
          />
          <Text style={[type.caption, identityChanged && { color: colors.warning }]}>
            {identityChanged ? 'Security code changed' : 'End-to-end encrypted'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** One 1:1 conversation. Messages are read from, and written to, the encrypted local DB. */
/** Lock/Unlock action in the chat header (authentication is required either way). */
function LockAction({ peer, locked }) {
  const run = async () => {
    const result = locked ? await unlockConversation(peer) : await lockConversation(peer);
    const message = result.ok ? null : chatLockErrorMessage(result.error);
    if (message) Alert.alert('Chat Lock', message);
    else if (result.ok) bumpRevision();
  };
  const confirm = () =>
    Alert.alert(
      locked ? 'Unlock chat?' : 'Lock chat?',
      locked
        ? 'This chat will appear in your chat list again.'
        : 'This chat will move to Locked chats. Opening it will require your fingerprint, face or screen lock.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: locked ? 'Unlock chat' : 'Lock chat', onPress: run },
      ],
    );
  return (
    <IconButton
      icon={locked ? 'lock-open-outline' : 'lock-closed-outline'}
      label={locked ? 'Unlock chat' : 'Lock chat'}
      onPress={confirm}
    />
  );
}

/**
 * Chat route. The lock gate decides first; message content is only loaded by ChatContent,
 * which is mounted only for unlocked chats or after Chat Lock authentication.
 */
export default function ChatScreen() {
  const { peerUserId } = useLocalSearchParams();
  const peer = String(peerUserId);
  return (
    <ChatLockGate peerUserId={peer}>
      <ChatContent peer={peer} />
    </ChatLockGate>
  );
}

function ChatContent({ peer }) {
  const me = useAuthStore((state) => state.user);
  const { data, error } = useChat(peer);
  const revision = useMessagingStore((state) => state.revision);
  const [text, setText] = useState('');
  const keyboardHeight = useKeyboardHeight();
  const insets = useSafeAreaInsets();

  const rows = useMemo(
    () => withDaySeparators(data?.messages ?? [], identityNotices(data?.identityEvents)),
    [data],
  );
  const name = peerLabel(peer, data?.conversation?.title);
  const identityChanged = Boolean(data?.identityChange);

  // Opening (or new messages arriving while open) marks incoming messages as read.
  useFocusEffect(
    useCallback(() => {
      markConversationRead(peer).catch(() => {});
    }, [peer, revision]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  const send = () => {
    const value = text.trim();
    if (!value || !me) return;
    setText('');
    sendMessage(me.id, peer, value);
  };

  return (
    <View
      style={[
        styles.container,
        { paddingBottom: keyboardHeight > 0 ? keyboardHeight : insets.bottom },
      ]}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Header
              peer={peer}
              title={data?.conversation?.title}
              identityChanged={identityChanged}
            />
          ),
          headerRight: () => <LockAction peer={peer} locked={data?.conversation?.locked === 1} />,
        }}
      />
      <ConnectionBanner />

      {data === null ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : rows.length === 0 ? (
        // Outside the inverted list: inverted lists flip their empty component on Android.
        <View style={styles.emptyWrap}>
          <View style={styles.notice}>
            <Ionicons name="lock-closed" size={14} color={colors.muted} />
            <Text style={styles.noticeText}>
              {error
                ? 'Could not load messages.'
                : 'Messages are end-to-end encrypted. No one outside this chat, not even Secure Chat, can read them.'}
            </Text>
          </View>
        </View>
      ) : (
        <FlatList
          inverted
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) =>
            item.kind === 'day' ? (
              <Text style={styles.day}>{item.label}</Text>
            ) : item.kind === 'notice' ? (
              <SecurityNotice notice={item} name={name} />
            ) : (
              <Bubble
                message={item.message}
                onRetry={() => retryFailedMessage(me.id, item.message.clientMessageId)}
              />
            )
          }
        />
      )}

      {identityChanged ? <SecurityCodeBanner peer={peer} name={name} /> : null}

      <View style={styles.composer}>
        <View style={styles.inputBox}>
          <IconButton
            icon="happy-outline"
            label="Emoji (coming soon)"
            color={colors.muted}
            disabled
          />
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor={colors.muted}
            multiline
            maxLength={MAX_LENGTH}
            style={styles.input}
            accessibilityLabel="Message"
            testID="message-input"
          />
          <IconButton icon="attach" label="Attach (coming soon)" color={colors.muted} disabled />
        </View>
        <Pressable
          onPress={send}
          disabled={!text.trim()}
          style={({ pressed }) => [
            styles.send,
            pressed && { backgroundColor: colors.primaryPressed },
            !text.trim() && styles.sendDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !text.trim() }}
          testID="send-button"
        >
          <Ionicons name="send" size={20} color={colors.onPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.chatBackground },
  loading: { marginTop: spacing.xxl },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: 260 },
  headerText: { flexShrink: 1 },
  encrypted: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  list: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.xs },
  emptyWrap: { flex: 1, padding: spacing.xl },
  notice: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignSelf: 'center',
    backgroundColor: colors.notice,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  noticeText: { ...type.caption, color: colors.text, flexShrink: 1, lineHeight: 17 },
  day: {
    alignSelf: 'center',
    ...type.caption,
    color: colors.muted,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginVertical: spacing.sm,
  },
  bubble: {
    maxWidth: '82%',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingTop: 6,
    paddingBottom: 4,
  },
  outgoing: {
    alignSelf: 'flex-end',
    backgroundColor: colors.bubbleOut,
    borderBottomRightRadius: 4,
  },
  incoming: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bubbleIn,
    borderBottomLeftRadius: 4,
  },
  body: { ...type.body, lineHeight: 21 },
  undecryptable: { ...type.secondary, fontStyle: 'italic' },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 3,
    marginTop: 2,
  },
  time: { fontSize: 11, color: colors.muted },
  failed: { fontSize: 11, color: colors.danger, marginTop: 2, alignSelf: 'flex-end' },
  securityNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'center',
    maxWidth: '90%',
    backgroundColor: colors.notice,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginVertical: spacing.xs,
  },
  securityNoticeText: { ...type.caption, color: colors.text, flexShrink: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.notice,
  },
  bannerText: { flex: 1, gap: 2 },
  bannerTitle: { ...type.heading, fontSize: 15 },
  bannerBody: { ...type.caption, color: colors.text, lineHeight: 17 },
  bannerButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  bannerButtonText: { color: colors.onPrimary, fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  inputBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.background,
    borderRadius: 24,
    paddingHorizontal: spacing.xs,
    minHeight: 48,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    paddingVertical: spacing.md,
    ...type.body,
  },
  send: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.5 },
});
