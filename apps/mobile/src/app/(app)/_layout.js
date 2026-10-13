import { router, Stack, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAuthStore } from '../../auth/authStore';
import { useCallStore } from '../../calls/callEngine';
import { CALL_PHASE } from '../../calls/callMachine';
import { CompleteProfile } from '../../components/CompleteProfile';
import { useSignalSetup } from '../../crypto/useSignalSetup';
import {
  nameConversationsFromContacts,
  namePeersFromServer,
} from '../../contacts/contactDiscovery';
import {
  bumpRevision,
  startMessaging,
  stopMessaging,
  useMessagingStore,
} from '../../messaging/messagingEngine';
import { useNotifications } from '../../notifications/useNotifications';
import { relockChats } from '../../security/chatLock';
import { colors } from '../../theme';

/**
 * A chat (or any other screen) opened straight from a link or a notification tap sits on top of
 * the tabs, so it has a back arrow and Back leads to the chat list instead of leaving the app.
 */
export const unstable_settings = { anchor: '(tabs)' };

export default function SignedInLayout() {
  // Generate/register Signal keys (and top up one-time pre-keys) once per signed-in start.
  const setup = useSignalSetup();
  const userId = useAuthStore((state) => state.user?.id);
  const user = useAuthStore((state) => state.user);
  const refreshUser = useAuthStore((state) => state.refreshUser);
  const [messagingReady, setMessagingReady] = useState(false);

  // The cached account may predate a change (e.g. email + phone now both required): re-read it
  // once per signed-in start. Offline: the cached details are used.
  useEffect(() => {
    refreshUser().catch(() => {});
  }, [refreshUser]);
  const needsProfile = Boolean(user) && (!user.email || !user.phoneNumber);

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
    // Phone numbers of people who messaged us, named from the address book where saved.
    namePeersFromServer().then((named) => named > 0 && bumpRevision());
    nameConversationsFromContacts({ myPhoneNumber }).then((named) => named > 0 && bumpRevision());
  }, [messagingReady, revision, myPhoneNumber]);

  // Push registration and notification taps (open the right conversation). Routing waits for
  // the root navigator to be mounted (its state has a key) so a cold-start tap is not dropped.
  const navigationReady = Boolean(useRootNavigationState()?.key);
  useNotifications(messagingReady, navigationReady);

  // A call that starts ringing (incoming over Pusher/recovery, or one we place) opens the call
  // screen, wherever the user is.
  const callPhase = useCallStore((state) => state.phase);
  const pathname = usePathname();
  useEffect(() => {
    const ringing = callPhase === CALL_PHASE.INCOMING || callPhase === CALL_PHASE.OUTGOING;
    if (needsProfile) return;
    if (navigationReady && ringing && pathname !== '/call') router.push('/call');
  }, [callPhase, navigationReady, pathname, needsProfile]);

  // Email and phone number are both required: an account missing one adds it first.
  if (needsProfile) return <CompleteProfile />;

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
      <Stack.Screen
        name="call"
        options={{
          headerShown: false,
          presentation: 'fullScreenModal',
          gestureEnabled: false,
          animation: 'fade',
        }}
      />
      <Stack.Screen name="security-code/[peerUserId]" options={{ title: 'Security code' }} />
      <Stack.Screen name="new-chat" options={{ title: 'New chat' }} />
      <Stack.Screen name="new-chat-id" options={{ title: 'CipherChat ID' }} />
      <Stack.Screen name="devices" options={{ title: 'Devices' }} />
      <Stack.Screen name="security" options={{ title: 'Security' }} />
      <Stack.Screen name="locked-chats" options={{ title: 'Locked chats' }} />
      <Stack.Screen name="chat-lock" options={{ title: 'Chat Lock' }} />
      <Stack.Screen name="delete-account" options={{ title: 'Delete account' }} />
    </Stack>
  );
}
