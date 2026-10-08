import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { devInvalidateAccessToken, getCachedSession } from '../../auth/tokenStore';
import { ListRow, SectionHeader } from '../../components/design';
import { Card, TextButton } from '../../components/ui';
import { getCipherVersion } from '../../db/database';
import { getApiStats } from '../../lib/api';
import { getDeviceId } from '../../lib/deviceId';
import { useMessagingStore } from '../../messaging/messagingEngine';
import { colors, spacing, type } from '../../theme';

// Developer tools are only loaded in development builds: in a release build `__DEV__` is false
// at bundle time, so this require (and the card's code) is not part of the app at all.
const E2EEDevCard = __DEV__ ? require('../../components/E2EEDevCard').E2EEDevCard : null;

/** How this device protects messages. Session diagnostics and developer tools: dev builds only. */
export default function SecurityScreen() {
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    getDeviceId().then(setDeviceId);
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionHeader>Encryption</SectionHeader>
      <ListRow
        icon="lock-closed-outline"
        title="End-to-end encrypted"
        subtitle="Messages are encrypted on this phone with the Signal Protocol. The server and push notifications never see their content."
      />
      <ListRow
        icon="server-outline"
        title="Local storage"
        subtitle={`Encrypted database (SQLCipher ${getCipherVersion() ?? '?'}), key in the device keystore`}
      />

      <SectionHeader>This device</SectionHeader>
      <ListRow
        icon="finger-print-outline"
        title="Device ID"
        value={deviceId ? `${deviceId.slice(0, 8)}…` : '…'}
      />

      {__DEV__ ? <DeveloperDiagnostics /> : null}
    </ScrollView>
  );
}

/** Token lifetime, refresh count, realtime state and test actions (development builds only). */
function DeveloperDiagnostics() {
  const realtime = useMessagingStore((state) => state.realtime);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const session = getCachedSession();
  const accessSecondsLeft = session
    ? Math.max(0, Math.round((session.accessTokenExpiresAt - now) / 1000))
    : 0;

  return (
    <View testID="developer-diagnostics">
      <SectionHeader>Developer</SectionHeader>
      <ListRow
        icon="time-outline"
        title="Access token expires in"
        value={`${accessSecondsLeft}s`}
      />
      <ListRow
        icon="refresh-outline"
        title="Token refreshes (this run)"
        value={String(getApiStats().refreshes)}
      />
      <ListRow icon="flash-outline" title="Live updates" value={realtime} />
      <View style={styles.dev}>
        <Card title="Developer">
          <Text style={type.secondary}>
            Replaces the access token with an invalid one; the next request gets a 401 and must
            refresh automatically.
          </Text>
          <TextButton title="Invalidate access token" onPress={devInvalidateAccessToken} />
        </Card>
        {E2EEDevCard ? <E2EEDevCard /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  dev: { padding: spacing.lg, gap: spacing.lg },
});
