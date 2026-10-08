import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ChatListRow, LockedChatsEntry } from '../../../components/ChatListRow';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { EmptyState, Fab, IconButton } from '../../../components/design';
import { peerLabel, useConversations, useLockedChatsSummary } from '../../../messaging/hooks';
import { requestSync, useMessagingStore } from '../../../messaging/messagingEngine';
import { colors, radius, spacing, type } from '../../../theme';

/**
 * Conversation list. Everything shown comes from the encrypted local database only. Locked
 * chats are not listed or searchable here; they are behind the "Locked chats" entry.
 */
export default function ChatsScreen() {
  const { data, error } = useConversations();
  const { data: locked } = useLockedChatsSummary();
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

  const showLockedEntry = (locked?.total ?? 0) > 0 && !query;

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
          renderItem={({ item }) => <ChatListRow item={item} />}
          ListHeaderComponent={
            showLockedEntry ? (
              <LockedChatsEntry
                hasUnread={locked.hasUnread}
                onPress={() => router.push('/locked-chats')}
              />
            ) : null
          }
          contentContainerStyle={
            visible.length === 0 && !showLockedEntry ? styles.emptyContainer : styles.list
          }
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
            ) : showLockedEntry ? null : (
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
});
