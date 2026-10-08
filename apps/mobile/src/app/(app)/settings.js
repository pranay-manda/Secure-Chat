import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../../auth/authStore';
import { devInvalidateAccessToken, getCachedSession } from '../../auth/tokenStore';
import { E2EEDevCard } from '../../components/E2EEDevCard';
import { Card, colors, ErrorText, PrimaryButton, Row, TextButton } from '../../components/ui';
import { getCipherVersion } from '../../db/database';
import { apiRequest, getApiStats, NetworkError } from '../../lib/api';
import { getDeviceId } from '../../lib/deviceId';
import { formatPhone } from '../../lib/phone';
import { useMessagingStore } from '../../messaging/messagingEngine';

/**
 * Account, session and device details (the Phase 2 home screen), plus the user's ID that a
 * contact needs to start a chat (no contact discovery yet).
 */
export default function SettingsScreen() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const realtime = useMessagingStore((state) => state.realtime);

  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    getDeviceId().then(setDeviceId);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiRequest('GET', '/devices')
      .then((data) => {
        if (!cancelled) setDevices(data.devices);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof NetworkError
            ? 'Offline: showing cached session'
            : 'Could not load devices',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  const confirmLogout = () =>
    Alert.alert('Log out?', 'This removes your session and local data from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: async () => {
          setLoggingOut(true);
          await logout();
        },
      },
    ]);

  const session = getCachedSession();
  const accessSecondsLeft = session
    ? Math.max(0, Math.round((session.accessTokenExpiresAt - now) / 1000))
    : 0;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.label}>Signed in as</Text>
        <Text style={styles.phone} testID="signed-in-phone">
          {user ? (user.email ?? formatPhone(user.phoneNumber)) : ''}
        </Text>
      </View>

      <Card title="Your ID">
        <Text style={styles.userId} selectable testID="my-user-id">
          {user?.id ?? ''}
        </Text>
        <Text style={styles.muted}>Share this with someone so they can start a chat with you.</Text>
        <TextButton title="Share my ID" onPress={() => Share.share({ message: user?.id ?? '' })} />
      </Card>

      <Card title="Session">
        <Row label="Device ID" value={deviceId ? `${deviceId.slice(0, 8)}…` : '…'} />
        <Row label="Access token expires in" value={`${accessSecondsLeft}s`} />
        <Row label="Token refreshes (this run)" value={String(getApiStats().refreshes)} />
        <Row label="Local database" value={`SQLCipher ${getCipherVersion() ?? '?'}`} />
        <Row label="Realtime" value={realtime} />
      </Card>

      <Card title="Your devices">
        {devices === null && !error ? <Text style={styles.muted}>Loading…</Text> : null}
        <ErrorText>{error}</ErrorText>
        {devices?.map((device) => (
          <Row
            key={device.deviceId}
            label={`${device.name || device.platform}${device.current ? ' (this device)' : ''}`}
            value={device.revokedAt ? 'signed out' : 'active'}
          />
        ))}
        <TextButton title="Reload" onPress={reload} />
      </Card>

      {__DEV__ ? (
        <Card title="Developer">
          <Text style={styles.muted}>
            Replaces the access token with an invalid one; the next request gets a 401 and must
            refresh automatically.
          </Text>
          <TextButton
            title="Invalidate access token & reload"
            onPress={async () => {
              await devInvalidateAccessToken();
              reload();
            }}
          />
        </Card>
      ) : null}

      {__DEV__ ? <E2EEDevCard /> : null}

      <PrimaryButton title="Log out" onPress={confirmLogout} loading={loggingOut} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 16, backgroundColor: '#fff', flexGrow: 1 },
  label: { color: colors.muted, fontSize: 14 },
  phone: { color: colors.text, fontSize: 22, fontWeight: '700' },
  userId: { color: colors.text, fontSize: 16, fontFamily: 'monospace' },
  muted: { color: colors.muted, fontSize: 14 },
});
