import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { Avatar, EmptyState, Fab, IconButton } from '../../../components/design';
import { peerLabel, useConversations } from '../../../messaging/hooks';
import { requestSync, useMessagingStore } from '../../../messaging/messagingEngine';
import { colors, formatListTime, radius, spacing, type } from '../../../theme';

const STATUS_ICON = {
  sending: { name: 'time-outline', color: colors.subtle },
  sent: { name: 'checkmark', color: colors.subtle },
  delivered: { name: 'checkmark-done', color: colors.subtle },
  read: { name: 'checkmark-done', color: colors.read },
  failed: { name: 'alert-circle', color: colors.danger },
};

function Preview({ item }) {
  if (item.lastStatus === 'undecryptable') {
    return <Text style={styles.previewMuted}>🔒 Message could not be decrypted</Text>;
  }
  if (item.lastBody == null) return <Text style={styles.previewMuted}>No messages yet</Text>;
  const status = item.lastDirection === 'out' ? STATUS_ICON[item.lastStatus] : null;
  return (
    <View style={styles.previewRow}>
      {status ? <Ionicons name={status.name} size={16} color={status.color} /> : null}
      <Text style={[styles.preview, item.unread > 0 && styles.previewUnread]} numberOfLines={1}>
        {item.lastBody}
      </Text>
    </View>
  );
}

function ChatRow({ item }) {
  const name = peerLabel(item.peerUserId, item.title);
  const unread = item.unread > 0;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => router.push(`/chat/${item.peerUserId}`)}
      accessibilityRole="button"
      accessibilityLabel={`${name}${unread ? `, ${item.unread} unread` : ''}`}
      testID={`conversation-${item.peerUserId}`}
    >
      <Avatar id={item.peerUserId} name={item.title} />
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
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

/** Conversation list. Everything shown comes from the encrypted local database only. */
export default function ChatsScreen() {
  const { data, error } = useConversations();
  const syncing = useMessagingStore((state) => state.syncing);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data || !q) return data;
    return data.filter(
      (c) =>
        peerLabel(c.peerUserId, c.title).toLowerCase().includes(q) ||
        (c.lastBody ?? '').toLowerCase().includes(q),
    );
  }, [data, query]);

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton
              icon={searching ? 'close' : 'search'}
              label={searching ? 'Close search' : 'Search chats'}
              onPress={() => {
                setSearching((s) => !s);
                setQuery('');
              }}
            />
          ),
        }}
      />
      <ConnectionBanner />

      {searching ? (
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={colors.muted}
            autoFocus
            style={styles.searchInput}
            accessibilityLabel="Search chats"
          />
        </View>
      ) : null}

      {data === null ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : error && data.length === 0 ? (
        <EmptyState icon="alert-circle-outline" title="Could not load chats" />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.peerUserId}
          renderItem={({ item }) => <ChatRow item={item} />}
          contentContainerStyle={visible.length === 0 ? styles.emptyContainer : styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={syncing}
              onRefresh={requestSync}
              colors={[colors.primary]}
            />
          }
          ListEmptyComponent={
            query ? (
              <EmptyState icon="search-outline" title="No matching chats" />
            ) : (
              <EmptyState
                icon="chatbubbles-outline"
                title="No chats yet"
                message="Tap the button below and enter the other person’s ID to start an end-to-end encrypted chat."
              />
            )
          }
        />
      )}

      <Fab icon="chatbox-ellipses" label="New chat" onPress={() => router.push('/new-chat')} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loading: { marginTop: spacing.xxl },
  list: { paddingBottom: 96 },
  emptyContainer: { flexGrow: 1 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm, ...type.body },
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
});
