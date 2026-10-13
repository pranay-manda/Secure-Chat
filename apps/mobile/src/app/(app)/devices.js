import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';

import { EmptyState, ListRow, SectionHeader } from '../../components/design';
import { ENDPOINTS } from '../../config/endpoints';
import { apiRequest, NetworkError } from '../../lib/api';
import { colors, spacing, type } from '../../theme';

/** Devices signed in to this account (v1 allows one active device). */
export default function DevicesScreen() {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiRequest('GET', ENDPOINTS.DEVICES.ROOT)
      .then((data) => !cancelled && (setDevices(data.devices), setError(null)))
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof NetworkError ? 'You’re offline.' : 'Could not load devices.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  if (devices === null && !error) {
    return <ActivityIndicator style={styles.loading} color={colors.primary} />;
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} />}
    >
      {error ? <Text style={styles.error}>{error} Pull down to retry.</Text> : null}
      {devices?.length === 0 ? (
        <EmptyState icon="phone-portrait-outline" title="No devices" />
      ) : null}
      <SectionHeader>Signed-in devices</SectionHeader>
      {devices?.map((device) => (
        <ListRow
          key={device.deviceId}
          icon={device.platform === 'ios' ? 'logo-apple' : 'logo-android'}
          title={`${device.name || device.platform}${device.current ? ' (this device)' : ''}`}
          subtitle={
            device.revokedAt
              ? 'Signed out'
              : `Active · last seen ${new Date(device.lastActiveAt).toLocaleString()}`
          }
        />
      ))}
      <Text style={styles.note}>
        Signing in on a new phone signs this one out. Your messages are end-to-end encrypted and
        stay on the device that received them.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loading: { marginTop: spacing.xxl },
  error: { ...type.secondary, color: colors.danger, padding: spacing.lg },
  note: { ...type.caption, padding: spacing.lg, lineHeight: 18 },
});
