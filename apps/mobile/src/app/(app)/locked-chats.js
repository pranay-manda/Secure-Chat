import { useFocusEffect } from 'expo-router';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { ChatListRow } from '../../components/ChatListRow';
import { EmptyState } from '../../components/design';
import { PrimaryButton } from '../../components/ui';
import { useLockedConversations } from '../../messaging/hooks';
import { chatLockErrorMessage, unlockChats, useChatLockStore } from '../../security/chatLock';
import { colors, spacing, type } from '../../theme';

/**
 * Locked chats folder. Nothing about locked conversations is read from the database until the
 * device owner authenticates; the unlock session ends when the app leaves the foreground.
 */
export default function LockedChatsScreen() {
  const unlocked = useChatLockStore((state) => state.unlocked);
  const { data } = useLockedConversations(unlocked);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const prompted = useRef(false);

  async function unlock() {
    setBusy(true);
    setError(null);
    const result = await unlockChats('Show your locked chats');
    setBusy(false);
    if (!result.ok) setError(chatLockErrorMessage(result.error));
  }

  // Only while this screen is visible (a chat opened on top asks for itself).
  useFocusEffect(
    useCallback(() => {
      if (!unlocked && !prompted.current) {
        prompted.current = true;
        unlock();
      }
    }, [unlocked]),
  );

  // Names and previews are on screen: keep them out of screenshots and the app switcher.
  useEffect(() => {
    if (!unlocked) return undefined;
    preventScreenCaptureAsync('locked-chats').catch(() => {});
    return () => {
      allowScreenCaptureAsync('locked-chats').catch(() => {});
    };
  }, [unlocked]);

  if (!unlocked) {
    return (
      <View style={styles.gate} testID="locked-chats-gate">
        <EmptyState
          icon="lock-closed-outline"
          title="Locked chats"
          message="Use your fingerprint, face or screen lock to see your locked chats."
        >
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.button}>
            <PrimaryButton title="Unlock" onPress={unlock} loading={busy} />
          </View>
        </EmptyState>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={data ?? []}
      keyExtractor={(item) => item.peerUserId}
      renderItem={({ item }) => <ChatListRow item={item} locked />}
      contentContainerStyle={(data ?? []).length === 0 ? styles.empty : null}
      ListHeaderComponent={
        <Text style={styles.note}>
          These chats are hidden from your chat list. Long press a chat to unlock it.
        </Text>
      }
      ListEmptyComponent={<EmptyState icon="lock-open-outline" title="No locked chats" />}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  gate: { flex: 1, backgroundColor: colors.background },
  empty: { flexGrow: 1 },
  note: { ...type.caption, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  error: { ...type.secondary, color: colors.danger, textAlign: 'center', marginTop: spacing.md },
  button: { alignSelf: 'stretch', marginTop: spacing.xl },
});
