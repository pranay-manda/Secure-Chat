import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ChatListRow, LockedChatsEntry } from '../../../components/ChatListRow';
import { ConnectionBanner } from '../../../components/ConnectionBanner';
import { Avatar, EmptyState, Fab, IconButton } from '../../../components/design';
import { useChatSearch } from '../../../contacts/useChatSearch';
import { formatPhone } from '../../../lib/phone';
import { useConversations, useLockedChatsSummary } from '../../../messaging/hooks';
import {
  createConversation,
  requestSync,
  useMessagingStore,
} from '../../../messaging/messagingEngine';
import { colors, spacing, type } from '../../../theme';

/** The header's search field (its own component, so typing never remounts the input). */
function SearchField({ value, onChangeText }) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder="Search name or number"
      placeholderTextColor={colors.muted}
      autoFocus
      autoCorrect={false}
      returnKeyType="search"
      style={styles.searchInput}
      accessibilityLabel="Search chats"
      testID="chat-search-input"
    />
  );
}

/** A person found in the address book or by number. */
function PersonRow({ name, detail, userId, onPress, testID }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.person, pressed && { backgroundColor: colors.surface }]}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${detail}. Opens a chat`}
      testID={testID}
    >
      <Avatar id={userId} name={name} size={48} />
      <View style={styles.personText}>
        <Text style={type.body} numberOfLines={1}>
          {name}
        </Text>
        <Text style={type.caption} numberOfLines={1}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

function SectionTitle({ children }) {
  return <Text style={styles.section}>{children}</Text>;
}

/**
 * Conversation list. Everything shown comes from the encrypted local database only. Locked
 * chats are not listed or searchable here; they are behind the "Locked chats" entry.
 *
 * Search (WhatsApp style): the search icon turns the header into a search field. Results:
 * matching chats, then contacts on CipherChat (address book), then a typed phone number looked
 * up on the server, so a friend can be found by their number.
 */
export default function ChatsScreen() {
  const { data, error } = useConversations();
  const { data: locked } = useLockedChatsSummary();
  const syncing = useMessagingStore((state) => state.syncing);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const search = useChatSearch(data, query, searching);

  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery('');
  }, []);

  // Android Back closes the search first, like WhatsApp.
  useEffect(() => {
    if (!searching) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [searching, closeSearch]);

  const openPerson = async (userId, name) => {
    await createConversation(userId, name);
    closeSearch();
    router.push(`/chat/${userId}`);
  };

  const q = query.trim();
  const rows = useMemo(() => {
    if (!searching || !q)
      return (data ?? []).map((item) => ({ kind: 'chat', key: item.peerUserId, item }));
    const out = [];
    if (search.chats.length > 0) {
      out.push({ kind: 'title', key: 't-chats', title: 'Chats' });
      out.push(...search.chats.map((item) => ({ kind: 'chat', key: item.peerUserId, item })));
    }
    if (search.people.length > 0) {
      out.push({ kind: 'title', key: 't-contacts', title: 'Contacts on CipherChat' });
      out.push(
        ...search.people.map((person) => ({ kind: 'person', key: `p${person.userId}`, person })),
      );
    }
    if (search.contactsStatus === 'no-permission') {
      out.push({ kind: 'allow-contacts', key: 'allow' });
    }
    if (search.numberResult)
      out.push({ kind: 'number', key: 'number', result: search.numberResult });
    return out;
  }, [searching, q, data, search.chats, search.people, search.contactsStatus, search.numberResult]);

  const showLockedEntry = (locked?.total ?? 0) > 0 && !searching;

  const renderNumber = (result) => {
    const label = formatPhone(result.number);
    if (result.status === 'found') {
      return (
        <PersonRow
          name={label}
          detail="On CipherChat"
          userId={result.match.userId}
          onPress={() => openPerson(result.match.userId, label)}
          testID="search-number-result"
        />
      );
    }
    const text = {
      loading: `Looking up ${label}…`,
      none: `${label} isn’t on CipherChat`,
      self: 'That’s your own number',
      error: `Couldn’t check ${label}. Check your connection.`,
    }[result.status];
    return (
      <View style={styles.numberState} testID={`search-number-${result.status}`}>
        {result.status === 'loading' ? (
          <ActivityIndicator size="small" color={colors.muted} />
        ) : (
          <Ionicons name="call-outline" size={18} color={colors.muted} />
        )}
        <Text style={type.secondary}>{text}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={
          searching
            ? {
                headerTitle: () => <SearchField value={query} onChangeText={setQuery} />,
                headerTitleContainerStyle: styles.searchTitle,
                headerLeft: () => (
                  <IconButton icon="arrow-back" label="Close search" onPress={closeSearch} />
                ),
                headerRight: () =>
                  query ? (
                    <IconButton icon="close" label="Clear search" onPress={() => setQuery('')} />
                  ) : null,
              }
            : {
                headerTitle: 'CipherChat',
                headerTitleContainerStyle: undefined,
                headerLeft: undefined,
                headerRight: () => (
                  <IconButton
                    icon="search"
                    label="Search chats"
                    onPress={() => setSearching(true)}
                  />
                ),
              }
        }
      />
      <ConnectionBanner />

      {data === null ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : error && data.length === 0 ? (
        <EmptyState icon="alert-circle-outline" title="Could not load chats" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item: row }) =>
            row.kind === 'title' ? (
              <SectionTitle>{row.title}</SectionTitle>
            ) : row.kind === 'person' ? (
              <PersonRow
                name={row.person.name}
                detail={row.person.maskedPhone}
                userId={row.person.userId}
                onPress={() => openPerson(row.person.userId, row.person.name)}
                testID={`search-contact-${row.person.userId}`}
              />
            ) : row.kind === 'allow-contacts' ? (
              <Pressable
                onPress={search.allowContacts}
                style={styles.numberState}
                accessibilityRole="button"
                testID="search-allow-contacts"
              >
                <Ionicons name="people-outline" size={18} color={colors.primary} />
                <Text style={[type.secondary, { color: colors.primary }]}>
                  Allow access to contacts to find friends on CipherChat
                </Text>
              </Pressable>
            ) : row.kind === 'number' ? (
              renderNumber(row.result)
            ) : (
              <ChatListRow item={row.item} />
            )
          }
          ListHeaderComponent={
            showLockedEntry ? (
              <LockedChatsEntry
                hasUnread={locked.hasUnread}
                onPress={() => router.push('/locked-chats')}
              />
            ) : null
          }
          contentContainerStyle={
            rows.length === 0 && !showLockedEntry ? styles.emptyContainer : styles.list
          }
          keyboardShouldPersistTaps="handled"
          refreshControl={
            searching ? undefined : (
              <RefreshControl
                refreshing={syncing}
                onRefresh={requestSync}
                colors={[colors.primary]}
              />
            )
          }
          ListEmptyComponent={
            searching && q ? (
              <EmptyState
                icon="search-outline"
                title="No results"
                message="Search a name, a message, or type a full phone number."
              />
            ) : searching ? null : showLockedEntry ? null : (
              <EmptyState
                icon="chatbubbles-outline"
                title="No chats yet"
                message="Tap the button below to find friends from your contacts, or search a phone number."
              />
            )
          }
        />
      )}

      {searching ? null : (
        <Fab icon="chatbox-ellipses" label="New chat" onPress={() => router.push('/new-chat')} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loading: { marginTop: spacing.xxl },
  list: { paddingBottom: 96 },
  emptyContainer: { flexGrow: 1 },
  searchTitle: { flex: 1, marginLeft: 0, marginRight: spacing.xxl },
  searchInput: { ...type.body, fontSize: 17, paddingVertical: spacing.sm, minWidth: 220 },
  section: {
    ...type.caption,
    color: colors.primary,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  personText: { flex: 1, gap: 2 },
  numberState: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
