import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAuthStore } from '../../auth/authStore';
import {
  discoverContacts,
  getContactsPermission,
  requestContactsPermission,
} from '../../contacts/contactDiscovery';
import { Avatar, EmptyState, IconButton, ListRow, SectionHeader } from '../../components/design';
import { PrimaryButton, TextButton } from '../../components/ui';
import { NetworkError } from '../../lib/api';
import { createConversation } from '../../messaging/messagingEngine';
import { colors, radius, spacing, type } from '../../theme';

/** Current permission; asks only when `ask` is set and the system still allows asking. */
async function resolvePermission({ ask }) {
  const permission = await getContactsPermission();
  if (permission.status !== 'granted' && ask && permission.canAskAgain) {
    return requestContactsPermission();
  }
  return permission;
}

/**
 * New Chat: people from this phone's contacts who use Secure Chat, plus the Secure Chat ID
 * fallback. Contacts permission is asked here (never at app start); only phone numbers are
 * sent for matching, contact names stay on the device.
 *
 * state: checking | denied | loading | ready | error
 */
export default function NewChatScreen() {
  const me = useAuthStore((s) => s.user);
  const [state, setState] = useState('checking');
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const myPhoneNumber = me?.phoneNumber ?? null;

  async function discover() {
    setState('loading');
    setError(null);
    try {
      setPeople(await discoverContacts({ myPhoneNumber }));
      setState('ready');
    } catch (err) {
      setError(
        err instanceof NetworkError
          ? 'You’re offline. Connect to the internet and try again.'
          : err?.code === 'RATE_LIMITED'
            ? 'Too many lookups for now. Try again later or use a Secure Chat ID.'
            : 'Could not check your contacts. Try again.',
      );
      setState('error');
    }
  }

  /** Applies a permission result: discover if granted, else show the denied state. */
  function applyPermission(permission) {
    setCanAskAgain(permission.canAskAgain);
    if (permission.status === 'granted') discover();
    else setState('denied');
  }

  // Entering New Chat is the moment we may ask for Contacts permission.
  useEffect(() => {
    let active = true;
    resolvePermission({ ask: true }).then((permission) => active && applyPermission(permission));
    return () => {
      active = false;
    };
    // Runs once per visit to New Chat.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Returning from system Settings (permission changed there): check again, never re-prompt.
  useEffect(() => {
    if (state !== 'denied') return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') resolvePermission({ ask: false }).then(applyPermission);
    });
    return () => sub.remove();
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = ({ ask }) => resolvePermission({ ask }).then(applyPermission);

  const tryAgain = () => (canAskAgain ? start({ ask: true }) : Linking.openSettings());

  const open = async (person) => {
    // The local contact name becomes this chat's on-device nickname (never uploaded).
    await createConversation(person.userId, person.name);
    router.replace(`/chat/${person.userId}`);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    const digits = q.replace(/\D/g, '');
    return people.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || (digits.length >= 3 && p.phoneNumber.includes(digits)),
    );
  }, [people, query]);

  const idFallback = (
    <View>
      <SectionHeader>Other ways</SectionHeader>
      <ListRow
        icon="key-outline"
        title="Search by Secure Chat ID"
        subtitle="For people who aren’t in your contacts"
        onPress={() => router.push('/new-chat-id')}
      />
    </View>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () =>
            state === 'ready' && people.length > 0 ? (
              <IconButton
                icon={searching ? 'close' : 'search'}
                label={searching ? 'Close search' : 'Search contacts'}
                onPress={() => {
                  setSearching((s) => !s);
                  setQuery('');
                }}
              />
            ) : null,
        }}
      />

      {searching ? (
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search your contacts"
            placeholderTextColor={colors.muted}
            autoFocus
            style={styles.searchInput}
            accessibilityLabel="Search your contacts"
          />
        </View>
      ) : null}

      {state === 'checking' || state === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          {state === 'loading' ? <Text style={styles.loadingText}>Loading contacts…</Text> : null}
        </View>
      ) : state === 'denied' ? (
        <View style={styles.flex}>
          <EmptyState
            icon="people-outline"
            title="Find people you know"
            message="Contacts permission is needed to find people you know on Secure Chat. Only phone numbers are checked; names never leave your phone."
          >
            <View style={styles.actions}>
              <PrimaryButton
                title={canAskAgain ? 'Try again' : 'Open settings'}
                onPress={tryAgain}
              />
              <TextButton
                title="Continue with Secure Chat ID"
                onPress={() => router.push('/new-chat-id')}
              />
            </View>
          </EmptyState>
        </View>
      ) : state === 'error' ? (
        <View style={styles.flex}>
          <EmptyState icon="cloud-offline-outline" title="Something went wrong" message={error}>
            <View style={styles.actions}>
              <PrimaryButton title="Try again" onPress={discover} />
            </View>
          </EmptyState>
          {idFallback}
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(p) => p.userId}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            people.length > 0 ? <SectionHeader>Contacts on Secure Chat</SectionHeader> : null
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => open(item)}
              accessibilityRole="button"
              accessibilityLabel={`Chat with ${item.name}`}
              testID={`contact-${item.userId}`}
            >
              <Avatar id={item.userId} name={item.name} size={44} />
              <View style={styles.rowText}>
                <Text style={type.heading} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={type.secondary}>{item.maskedPhone}</Text>
              </View>
            </Pressable>
          )}
          ListEmptyComponent={
            query ? (
              <EmptyState icon="search-outline" title="No matching contacts" />
            ) : (
              <EmptyState
                icon="people-outline"
                title="None of your contacts use Secure Chat yet"
                message="Invite them, or start a chat with a Secure Chat ID."
              />
            )
          }
          ListFooterComponent={idFallback}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  loadingText: type.secondary,
  actions: { alignSelf: 'stretch', marginTop: spacing.xl, gap: spacing.sm, alignItems: 'center' },
  list: { flexGrow: 1, paddingBottom: spacing.xxl },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
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
    paddingVertical: spacing.sm,
  },
  rowPressed: { backgroundColor: colors.surface },
  rowText: { flex: 1, gap: 2 },
});
