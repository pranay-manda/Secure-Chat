import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';

import { useAuthStore } from '../../auth/authStore';
import { useSignalSetup } from '../../crypto/useSignalSetup';
import { startMessaging, stopMessaging } from '../../messaging/messagingEngine';
import { useNotifications } from '../../notifications/useNotifications';
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

  // Push registration and notification taps (open the right conversation).
  useNotifications(messagingReady);

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
      <Stack.Screen name="new-chat" options={{ title: 'New chat' }} />
      <Stack.Screen name="devices" options={{ title: 'Devices' }} />
      <Stack.Screen name="security" options={{ title: 'Security' }} />
    </Stack>
  );
}
