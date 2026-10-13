import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuthStore } from '../../../auth/authStore';
import { ChatLockGate } from '../../../components/ChatLockGate';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { startCall } from '../../../calls/callEngine';
import { describeCall } from '../../../calls/callHistory';
import { Avatar, IconButton } from '../../../components/design';
import { AttachmentContent } from '../../../components/media/AttachmentContent';
import { MediaViewer } from '../../../components/media/MediaViewer';
import { useKeyboardInset } from '../../../components/useKeyboardInset';
import { pickPhotoOrVideo } from '../../../components/media/pickMedia';
import { useVoiceRecorder } from '../../../components/media/useVoiceRecorder';
import { VoiceComposer } from '../../../components/media/VoiceComposer';
import { CameraCapture } from '../../../components/media/CameraCapture';
import { MediaPreview } from '../../../components/media/MediaPreview';
import { deleteQuietly, isAppCacheFile } from '../../../media/mediaFiles';
import { MEDIA_ERROR } from '../../../media/attachmentService';
import { peerLabel, useChat } from '../../../messaging/hooks';
import { INVALID_CONTENT, UNTRUSTED_IDENTITY } from '../../../messaging/messageStore';
import { sendTypingPing, usePeerOnline, usePeerTyping } from '../../../presence/usePresence';
import {
  bumpRevision,
  markConversationRead,
  retryFailedMessage,
  sendAttachment,
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

/** Voice calls with this person (from this phone's call history) as timeline entries. */
function callEntries(calls) {
  return (calls ?? []).map((call) => ({
    kind: 'call',
    key: `c${call.callId}`,
    at: call.startedAt,
    call,
  }));
}

/** Newest-first messages, notices and calls, with a day separator after each day's last item. */
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
    .sort((a, b) => b.at - a.at || (a.kind !== 'message') - (b.kind !== 'message'));
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

/** A voice call in the timeline, on the side of whoever placed it; tapping calls back. */
function CallEntry({ entry, onCallBack }) {
  const call = describeCall(entry);
  const detail = call.detail || (call.missed ? 'Tap to call back' : '');
  return (
    <Pressable
      onPress={onCallBack}
      style={[styles.bubble, styles.callBubble, call.outgoing ? styles.outgoing : styles.incoming]}
      accessibilityRole="button"
      accessibilityLabel={[call.title, detail].filter(Boolean).join(', ')}
      accessibilityHint="Calls back"
      testID={`call-entry-${entry.callId}`}
    >
      <View style={[styles.callIcon, call.missed && styles.callIconMissed]}>
        <Ionicons
          name={call.video ? 'videocam' : call.outgoing ? 'call-outline' : 'call'}
          size={18}
          color={call.missed ? colors.danger : colors.primary}
        />
      </View>
      <View style={styles.callText}>
        <Text style={styles.callTitle}>{call.title}</Text>
        {detail ? <Text style={styles.callDetail}>{detail}</Text> : null}
      </View>
      <Text style={[styles.time, styles.callTime]}>{formatClock(entry.startedAt)}</Text>
    </Pressable>
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
          {name}&apos;s security code changed. This usually happens when they reinstall CipherChat
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

/** Why an outgoing message was not sent, as shown under its bubble. */
function failureText(error) {
  if (error === 'TEMPORARY') return 'Waiting for connection · tap to retry';
  if (error === UNTRUSTED_IDENTITY) return 'Not sent · security code changed';
  if (error === MEDIA_ERROR.UNAVAILABLE) return 'Not sent · the file is no longer available';
  return 'Not sent · tap to retry';
}

function Bubble({ message, onRetry, onOpenMedia }) {
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
      ) : message.status === 'unsupported' ? (
        <Text style={styles.undecryptable}>
          {message.error === INVALID_CONTENT
            ? 'This message could not be displayed.'
            : 'This message isn’t supported by this version of CipherChat.'}
        </Text>
      ) : message.attachment ? (
        <>
          <AttachmentContent message={message} onOpen={onOpenMedia} />
          {message.body ? (
            <Text style={styles.body} selectable>
              {message.body}
            </Text>
          ) : null}
        </>
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
      {failed ? <Text style={styles.failed}>{failureText(message.error)}</Text> : null}
    </Pressable>
  );
}

/** Chat header; tapping it opens the contact's security code. */
function Header({ peer, title, phone, identityChanged }) {
  // Their app is connected right now (not whether they are looking at it).
  const peerOnline = usePeerOnline(peer);
  const isTyping = usePeerTyping(peer);

  let subtitle = 'End-to-end encrypted';
  let subtitleColor = colors.muted;

  if (identityChanged) {
    subtitle = 'Security code changed';
    subtitleColor = colors.warning;
  } else if (isTyping) {
    subtitle = 'typing…';
    subtitleColor = colors.primary;
  } else if (peerOnline === true) {
    subtitle = 'Online';
    subtitleColor = colors.primary;
  } else if (peerOnline === false) {
    subtitle = 'Offline';
    subtitleColor = colors.muted;
  }

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
          {peerLabel(peer, title, phone)}
        </Text>
        <View style={styles.encrypted}>
          {identityChanged ? (
            <Ionicons name="shield-outline" size={11} color={colors.warning} />
          ) : isTyping ? null : (
            <Ionicons
              name={peerOnline === true ? 'ellipse' : 'lock-closed'}
              size={peerOnline === true ? 8 : 11}
              color={peerOnline === true ? colors.primary : colors.muted}
            />
          )}
          <Text
            style={[
              type.caption,
              { color: subtitleColor },
              isTyping && { fontWeight: '600', fontStyle: 'italic' },
              !identityChanged && !isTyping && peerOnline && { fontWeight: '500' },
            ]}
            testID="chat-subtitle"
          >
            {subtitle}
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
  const [viewing, setViewing] = useState(null);
  const [preparing, setPreparing] = useState(false);
  // Keeps the composer just above the keyboard on every phone (see useKeyboardInset).
  const bottomInset = useKeyboardInset();

  const rows = useMemo(
    () =>
      withDaySeparators(data?.messages ?? [], [
        ...identityNotices(data?.identityEvents),
        ...callEntries(data?.calls),
      ]),
    [data],
  );
  const name = peerLabel(peer, data?.conversation?.title, data?.conversation?.peerPhone);
  const identityChanged = Boolean(data?.identityChange);

  // Opening (or new messages arriving while open) marks incoming messages as read.
  useFocusEffect(
    useCallback(() => {
      markConversationRead(peer).catch(() => {});
    }, [peer, revision]), // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Clean up typing status when leaving the chat
  useEffect(() => {
    return () => {
      sendTypingPing(peer, false);
    };
  }, [peer]);

  const handleTextChange = (val) => {
    setText(val);
    if (val.trim()) {
      sendTypingPing(peer, true);
    } else {
      sendTypingPing(peer, false);
    }
  };

  const send = () => {
    const value = text.trim();
    if (!value || !me) return;
    setText('');
    sendTypingPing(peer, false);
    sendMessage(me.id, peer, value);
  };

  /** Encrypts and sends a photo, video or voice note; typed text goes with it as the caption. */
  const sendMedia = useCallback(
    async (media, caption = '') => {
      if (!me) return;
      setPreparing(true);
      try {
        await sendAttachment(me.id, peer, media, caption);
      } catch (err) {
        Alert.alert('Can’t send', err?.message ?? 'This file could not be sent.');
      } finally {
        setPreparing(false);
      }
    },
    [me, peer],
  );

  /** A picked or captured photo/video waits on the preview screen until the user taps Send. */
  const [draftMedia, setDraftMedia] = useState(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const attach = async () => {
    const media = await pickPhotoOrVideo().catch(() => null);
    if (media) setDraftMedia(media);
  };

  const onCaptured = useCallback((media) => {
    setCameraOpen(false);
    setDraftMedia(media);
  }, []);
  const closeCamera = useCallback(() => setCameraOpen(false), []);

  const discardDraftMedia = () => {
    // The app's own copy (picker or camera cache); never the user's files.
    if (draftMedia && isAppCacheFile(draftMedia.uri)) deleteQuietly(draftMedia.uri);
    setDraftMedia(null);
  };

  const sendDraftMedia = (caption) => {
    const media = draftMedia;
    setDraftMedia(null);
    if (!media) return;
    // Text typed in the chat box before picking goes with the photo, unless replaced.
    if (!caption && text.trim()) {
      caption = text.trim();
      setText('');
    }
    sendTypingPing(peer, false);
    sendMedia(media, caption);
  };

  const voice = useVoiceRecorder({ onSend: sendMedia });
  const closeViewer = useCallback(() => setViewing(null), []);

  return (
    <View style={[styles.container, { paddingBottom: bottomInset }]}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Header
              peer={peer}
              title={data?.conversation?.title}
              phone={data?.conversation?.peerPhone}
              identityChanged={identityChanged}
            />
          ),
          headerRight: () => (
            <View style={styles.headerActions}>
              <IconButton
                icon="videocam-outline"
                label="Video call"
                onPress={() => startCall(peer, { video: true })}
              />
              <IconButton icon="call-outline" label="Voice call" onPress={() => startCall(peer)} />
              <LockAction peer={peer} locked={data?.conversation?.locked === 1} />
            </View>
          ),
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
                : 'Messages are end-to-end encrypted. No one outside this chat, not even CipherChat, can read them.'}
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
            ) : item.kind === 'call' ? (
              <CallEntry
                entry={item.call}
                onCallBack={() => startCall(peer, { video: item.call.kind === 'video' })}
              />
            ) : (
              <Bubble
                message={item.message}
                onRetry={() => retryFailedMessage(me.id, item.message.clientMessageId)}
                onOpenMedia={setViewing}
              />
            )
          }
        />
      )}

      {identityChanged ? <SecurityCodeBanner peer={peer} name={name} /> : null}

      {voice.notice ? (
        <View style={styles.voiceNotice} testID="voice-notice">
          <Text style={styles.voiceNoticeText}>{voice.notice.text}</Text>
          {voice.notice.settings ? (
            <Pressable
              onPress={() => Linking.openSettings().catch(() => {})}
              accessibilityRole="button"
            >
              <Text style={styles.voiceNoticeAction}>Settings</Text>
            </Pressable>
          ) : null}
          <IconButton
            icon="close"
            label="Dismiss"
            color={colors.muted}
            onPress={voice.clearNotice}
          />
        </View>
      ) : null}

      <VoiceComposer
        voice={voice}
        hasText={Boolean(text.trim())}
        onSendText={send}
        disabled={preparing}
        input={
          <View style={styles.inputBox}>
            <IconButton
              icon="happy-outline"
              label="Emoji (coming soon)"
              color={colors.muted}
              disabled
            />
            <TextInput
              value={text}
              onChangeText={handleTextChange}
              placeholder="Message"
              placeholderTextColor={colors.muted}
              multiline
              maxLength={MAX_LENGTH}
              style={styles.input}
              accessibilityLabel="Message"
              testID="message-input"
            />
            {preparing ? (
              <ActivityIndicator style={styles.preparing} color={colors.muted} />
            ) : (
              <>
                <IconButton
                  icon="attach"
                  label="Send a photo or video"
                  color={colors.muted}
                  onPress={attach}
                />
                {text.trim() ? null : (
                  <IconButton
                    icon="camera-outline"
                    label="Camera"
                    color={colors.muted}
                    onPress={() => setCameraOpen(true)}
                    testID="camera-button"
                  />
                )}
              </>
            )}
          </View>
        }
      />
      <MediaViewer item={viewing} onClose={closeViewer} />
      <CameraCapture visible={cameraOpen} onClose={closeCamera} onCaptured={onCaptured} />
      <MediaPreview media={draftMedia} onCancel={discardDraftMedia} onSend={sendDraftMedia} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.chatBackground },
  loading: { marginTop: spacing.xxl },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, maxWidth: 260 },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
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
  callBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    minWidth: 200,
  },
  callIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callIconMissed: { backgroundColor: colors.dangerTint },
  callText: { flexShrink: 1, gap: 1 },
  callTitle: { ...type.body, fontWeight: '600' },
  callDetail: { ...type.caption, color: colors.muted },
  callTime: { alignSelf: 'flex-end', marginLeft: 'auto' },
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
  preparing: { marginHorizontal: spacing.md, alignSelf: 'center' },
  recordingBox: { alignItems: 'center', gap: spacing.sm },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  recordingText: { ...type.body, color: colors.text },
  voiceNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.sm,
    paddingLeft: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.notice,
  },
  voiceNoticeText: { ...type.caption, color: colors.text, flex: 1 },
  voiceNoticeAction: { color: colors.primary, fontWeight: '600' },
});
