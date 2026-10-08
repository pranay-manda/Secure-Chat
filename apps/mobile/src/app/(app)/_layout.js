import { Stack } from 'expo-router';
import { useEffect } from 'react';

import { useAuthStore } from '../../auth/authStore';
import { useSignalSetup } from '../../crypto/useSignalSetup';
import { startMessaging, stopMessaging } from '../../messaging/messagingEngine';

export default function SignedInLayout() {
  // Generate/register Signal keys (and top up one-time pre-keys) once per signed-in start.
  const setup = useSignalSetup();
  const userId = useAuthStore((state) => state.user?.id);

  // Messaging (realtime + sync) starts once this device's keys are registered.
  useEffect(() => {
    if (setup.state !== 'ready' || !userId) return undefined;
    startMessaging(userId).catch(() => {});
    return () => stopMessaging();
  }, [setup.state, userId]);

  return (
    <Stack screenOptions={{ headerTitleAlign: 'center', headerShadowVisible: false }}>
      <Stack.Screen name="index" options={{ title: 'Chats' }} />
      <Stack.Screen name="chat/[peerUserId]" options={{ title: '' }} />
      <Stack.Screen name="new-chat" options={{ title: 'New chat' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
    </Stack>
  );
}
