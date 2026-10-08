import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuthStore } from '../../../auth/authStore';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { colors } from '../../../components/ui';
import { peerLabel, useChat } from '../../../messaging/hooks';
import {
  markConversationRead,
  retryFailedMessage,
  sendMessage,
  useMessagingStore,
} from '../../../messaging/messagingEngine';

/** Max characters per message (keeps the ciphertext well under the API's size limit). */
const MAX_LENGTH = 4000;

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

function statusLabel(message) {
  switch (message.status) {
    case 'sending':
      return 'Sending…';
    case 'sent':
      return '✓ Sent';
    case 'delivered':
      return '✓✓ Delivered';
    case 'read':
      return '✓✓ Read';
    case 'failed':
      return message.error === 'TEMPORARY'
        ? 'Not sent: waiting for connection · Tap to retry'
        : 'Not sent · Tap to retry';
    default:
      return '';
  }
}

function formatTime(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function Bubble({ message, onRetry }) {
  const outgoing = message.direction === 'out';
  const undecryptable = message.status === 'undecryptable';
  const failed = message.status === 'failed';

  return (
    <Pressable
      onPress={failed ? onRetry : undefined}
      disabled={!failed}
      style={[styles.bubble, outgoing ? styles.outgoing : styles.incoming]}
      accessibilityRole={failed ? 'button' : undefined}
      testID={`message-${message.id}`}
    >
      {undecryptable ? (
        <Text style={styles.undecryptable}>🔒 This message could not be decrypted.</Text>
      ) : (
        <Text style={styles.body} selectable>
          {message.body}
        </Text>
      )}
      <Text style={[styles.meta, failed && styles.failed]}>
        {formatTime(message.createdAt)}
        {outgoing ? `  ${statusLabel(message)}` : ''}
      </Text>
    </Pressable>
  );
}

/** One 1:1 conversation. Messages are read from, and written to, the encrypted local DB. */
export default function ChatScreen() {
  const { peerUserId } = useLocalSearchParams();
  const peer = String(peerUserId);
  const me = useAuthStore((state) => state.user);
  const { data, error } = useChat(peer);
  const revision = useMessagingStore((state) => state.revision);
  const [text, setText] = useState('');
  const keyboardHeight = useKeyboardHeight();

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
    <View style={[styles.container, { paddingBottom: keyboardHeight }]}>
      <Stack.Screen options={{ title: peerLabel(peer, data?.conversation?.title) }} />
      <ConnectionBanner />

      {data === null ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : data.messages.length === 0 ? (
        // Outside the inverted list: inverted lists flip their empty component on Android.
        <Text style={styles.empty}>
          {error ? 'Could not load messages.' : 'Messages are end-to-end encrypted. Say hello!'}
        </Text>
      ) : (
        <FlatList
          inverted
          data={data.messages}
          keyExtractor={(m) => String(m.id)}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <Bubble
              message={item}
              onRetry={() => retryFailedMessage(me.id, item.clientMessageId)}
            />
          )}
        />
      )}

      <View style={styles.composer}>
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
        <Pressable
          onPress={send}
          disabled={!text.trim()}
          style={({ pressed }) => [
            styles.send,
            pressed && styles.sendPressed,
            !text.trim() && styles.sendDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Send"
          testID="send-button"
        >
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  loading: { marginTop: 40 },
  list: { padding: 12, gap: 6 },
  empty: { flex: 1, color: colors.muted, textAlign: 'center', padding: 24, paddingTop: 48 },
  bubble: { maxWidth: '80%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  outgoing: { alignSelf: 'flex-end', backgroundColor: '#d8f3e6' },
  incoming: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  body: { fontSize: 16, color: colors.text },
  undecryptable: { fontSize: 14, color: colors.muted, fontStyle: 'italic' },
  meta: { fontSize: 11, color: colors.muted, marginTop: 4, alignSelf: 'flex-end' },
  failed: { color: colors.danger },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 16,
    color: colors.text,
  },
  send: {
    backgroundColor: colors.primary,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendPressed: { backgroundColor: colors.primaryPressed },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
