import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect } from 'expo-router';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { isConversationLocked } from '../messaging/messageStore';
import { useMessagingStore } from '../messaging/messagingEngine';
import { chatLockErrorMessage, unlockChats, useChatLockStore } from '../security/chatLock';
import { colors, spacing, type } from '../theme';
import { PrimaryButton } from './ui';

/**
 * Guards a conversation. Every way into a chat (list, notification tap, deep link, restored
 * route) renders through this gate. Until the lock state is known nothing is rendered; for a
 * locked chat outside an unlock session a generic screen is shown and `children` (the only
 * component that reads messages from the database) is not mounted, so no plaintext of a
 * locked chat is loaded or displayed before the owner authenticates.
 */
export function ChatLockGate({ peerUserId, children }) {
  const unlocked = useChatLockStore((state) => state.unlocked);
  const revision = useMessagingStore((state) => state.revision);
  const [locked, setLocked] = useState(null); // null = not checked yet
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const prompted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    isConversationLocked(peerUserId).then(
      (value) => !cancelled && setLocked(value),
      () => !cancelled && setLocked(true), // fail closed
    );
    return () => {
      cancelled = true;
    };
  }, [peerUserId, revision, unlocked]);

  const showing = locked === false || (locked === true && unlocked);

  // While a locked chat is visible, block capturing it where the platform allows. Android
  // (FLAG_SECURE): blocks screenshots and recording and blanks the app-switcher thumbnail.
  // iOS: blocks screen recording/mirroring only — iOS has no API to prevent screenshots, and
  // the app-switcher snapshot is not blanked. That is an OS limitation, not a data leak to
  // other apps; the unlock session still ends when the app goes to the background.
  const protect = locked === true && unlocked;
  useEffect(() => {
    if (!protect) return undefined;
    const key = `chat-lock:${peerUserId}`;
    preventScreenCaptureAsync(key).catch(() => {});
    return () => {
      allowScreenCaptureAsync(key).catch(() => {});
    };
  }, [protect, peerUserId]);

  async function unlock() {
    setBusy(true);
    setError(null);
    const result = await unlockChats('Unlock this chat');
    setBusy(false);
    if (!result.ok) setError(chatLockErrorMessage(result.error));
  }

  // Ask once when a locked chat is opened (e.g. from a notification); the button retries.
  // Only the visible screen asks, so a stack of re-locked screens shows one prompt.
  useFocusEffect(
    useCallback(() => {
      if (locked === true && !unlocked && !prompted.current) {
        prompted.current = true;
        unlock();
      }
    }, [locked, unlocked]),
  );

  if (showing) return children;

  return (
    <View style={styles.container} testID="chat-lock-gate">
      {locked === true ? (
        <Stack.Screen options={{ headerTitle: 'Locked chat', headerRight: () => null }} />
      ) : null}
      {locked === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <>
          <View style={styles.icon}>
            <Ionicons name="lock-closed" size={36} color={colors.primary} />
          </View>
          <Text style={styles.title}>This chat is locked</Text>
          <Text style={styles.message}>Use your fingerprint, face or screen lock to open it.</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.button}>
            <PrimaryButton title="Unlock" onPress={unlock} loading={busy} />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
    backgroundColor: colors.background,
  },
  icon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: { ...type.heading, textAlign: 'center' },
  message: { ...type.secondary, textAlign: 'center', marginTop: spacing.sm },
  error: { ...type.secondary, color: colors.danger, textAlign: 'center', marginTop: spacing.md },
  button: { alignSelf: 'stretch', marginTop: spacing.xl },
});
