import { StyleSheet, Text } from 'react-native';

import { useMessagingStore } from '../messaging/messagingEngine';
import { colors } from './ui';

/** Offline / reconnecting notice. Messages typed meanwhile are queued and sent later. */
export function ConnectionBanner() {
  const online = useMessagingStore((state) => state.online);
  const realtime = useMessagingStore((state) => state.realtime);
  const lastSyncError = useMessagingStore((state) => state.lastSyncError);

  let text = null;
  if (!online || lastSyncError === 'offline') {
    text = 'You’re offline. Messages will be sent when you reconnect.';
  } else if (realtime === 'connecting') {
    text = 'Connecting…';
  } else if (realtime !== 'connected' && realtime !== 'idle') {
    text = 'Live updates unavailable. Checking for messages periodically.';
  }
  if (!text) return null;

  return (
    <Text style={styles.banner} accessibilityRole="alert" testID="connection-banner">
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#fff8c5',
    color: colors.text,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 13,
  },
});
