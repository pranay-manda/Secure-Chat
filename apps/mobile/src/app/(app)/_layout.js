import { Stack, useRootNavigationState } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAuthStore } from '../../auth/authStore';
import { useSignalSetup } from '../../crypto/useSignalSetup';
import { nameConversationsFromContacts } from '../../contacts/contactDiscovery';
import {
  bumpRevision,
  startMessaging,
  stopMessaging,
  useMessagingStore,
} from '../../messaging/messagingEngine';
import { useNotifications } from '../../notifications/useNotifications';
import { relockChats } from '../../security/chatLock';
import { colors } from '../../theme';

export default function SignedInLayout() {
  // Generate/register Signal keys (and top up one-time pre-keys) once per signed-in start.
  const setup = useSignalSetup();
  const userId = useAuthStore((state) => state.user?.id);
  const [messagingReady, setMessagingReady] = useState(false);

  // Messaging (realtime + sync) starts once this device's keys are registered.
  useEffect(() => {
    if (setup.state !== 'ready' || !userId) return undefined;
    let cancelled = false;
    startMessaging(userId)
      .catch(() => {})
      .finally(() => !cancelled && setMessagingReady(true));
    return () => {
      cancelled = true;
      setMessagingReady(false);
      stopMessaging();
    };
  }, [setup.state, userId]);

  // Leaving the signed-in app (logout, session end) always ends a Chat Lock unlock session.
  useEffect(() => relockChats, []);

  // A chat started by someone else has no name: name it from the address book (only if
  // Contacts permission was already granted; never prompts, local only).
  const revision = useMessagingStore((state) => state.revision);
  const myPhoneNumber = useAuthStore((state) => state.user?.phoneNumber ?? null);
  useEffect(() => {
    if (!messagingReady) return;
    nameConversationsFromContacts({ myPhoneNumber }).then((named) => named > 0 && bumpRevision());
  }, [messagingReady, revision, myPhoneNumber]);

  // Push registration and notification taps (open the right conversation). Routing waits for
  // the root navigator to be mounted (its state has a key) so a cold-start tap is not dropped.
  const navigationReady = Boolean(useRootNavigationState()?.key);
  useNotifications(messagingReady, navigationReady);

  return (
    <Stack
      screenOptions={{
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="chat/[peerUserId]" options={{ title: '' }} />
      <Stack.Screen name="security-code/[peerUserId]" options={{ title: 'Security code' }} />
      <Stack.Screen name="new-chat" options={{ title: 'New chat' }} />
      <Stack.Screen name="new-chat-id" options={{ title: 'Secure Chat ID' }} />
      <Stack.Screen name="devices" options={{ title: 'Devices' }} />
      <Stack.Screen name="security" options={{ title: 'Security' }} />
      <Stack.Screen name="locked-chats" options={{ title: 'Locked chats' }} />
      <Stack.Screen name="chat-lock" options={{ title: 'Chat Lock' }} />
    </Stack>
  );
}
