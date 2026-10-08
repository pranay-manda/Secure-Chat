import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AUTH_STATUS, useAuthStore } from '../auth/authStore';

// Keep the splash screen up until the stored session has been checked, so a signed-in user
// never sees the login screen flash on start.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const status = useAuthStore((state) => state.status);
  const initialize = useAuthStore((state) => state.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (status !== AUTH_STATUS.INITIALIZING) SplashScreen.hideAsync().catch(() => {});
  }, [status]);

  if (status === AUTH_STATUS.INITIALIZING) return null;

  const signedIn = status === AUTH_STATUS.SIGNED_IN;

  return (
    <>
      <Stack screenOptions={{ headerTitleAlign: 'center', headerShadowVisible: false }}>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ title: 'Secure Chat' }} />
          <Stack.Screen name="verify" options={{ title: 'Verify' }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
      <StatusBar style="auto" />
    </>
  );
}
