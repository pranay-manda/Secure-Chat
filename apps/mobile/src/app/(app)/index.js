import { router, Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { ConnectionBanner } from '../../components/ConnectionBanner';
import { colors, ErrorText, PrimaryButton, TextButton } from '../../components/ui';
import { peerLabel, useConversations } from '../../messaging/hooks';
import { requestSync, useMessagingStore } from '../../messaging/messagingEngine';

const STATUS_MARK = { sending: '…', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '!' };

function preview(item) {
  if (item.lastStatus === 'undecryptable') return 'Message could not be decrypted';
  if (item.lastBody == null) return 'No messages yet';
  const mark = item.lastDirection === 'out' ? `${STATUS_MARK[item.lastStatus] ?? ''} ` : '';
  return `${mark}${item.lastBody}`;
}

/** Conversation list (1:1). Data comes only from the local encrypted database. */
export default function ChatsScreen() {
  const { data, error } = useConversations();
  const syncing = useMessagingStore((state) => state.syncing);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Chats',
          headerRight: () => (
            <TextButton title="Settings" onPress={() => router.push('/settings')} />
          ),
        }}
      />
      <ConnectionBanner />
      <ErrorText>{error ? 'Could not load chats' : null}</ErrorText>

      {data === null ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.peerUserId}
          refreshing={syncing}
          onRefresh={requestSync}
          contentContainerStyle={data.length === 0 && styles.emptyContainer}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No chats yet. Start one with the ID of the person you want to message.
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => router.push(`/chat/${item.peerUserId}`)}
              accessibilityRole="button"
              testID={`conversation-${item.peerUserId}`}
            >
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {peerLabel(item.peerUserId, item.title)}
                </Text>
                <Text style={styles.preview} numberOfLines={1}>
                  {preview(item)}
                </Text>
              </View>
              {item.unread > 0 ? <Text style={styles.badge}>{item.unread}</Text> : null}
            </Pressable>
          )}
        />
      )}

      <View style={styles.footer}>
        <PrimaryButton title="New chat" onPress={() => router.push('/new-chat')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  loading: { marginTop: 40 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  empty: { color: colors.muted, fontSize: 15, textAlign: 'center', padding: 32 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: 12,
  },
  rowPressed: { backgroundColor: colors.surface },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: '600', color: colors.text },
  preview: { fontSize: 14, color: colors.muted },
  badge: {
    minWidth: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: colors.primary,
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 22,
  },
  footer: { padding: 16 },
});
