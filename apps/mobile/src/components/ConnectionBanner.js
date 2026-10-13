import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { CONNECTIVITY, useConnectivity, useOfflineReason } from '../lib/connectivity';
import { useMessagingStore } from '../messaging/messagingEngine';
import { colors } from './ui';

/**
 * A (re)connect that finishes within this time is not announced: a normal reconnect takes
 * well under it, and a banner flashing for a moment only worries people. Offline is shown
 * at once.
 */
export const CONNECTING_NOTICE_DELAY_MS = 2000;

/** True once `active` has stayed true for `delayMs`. */
function useActiveFor(active, delayMs) {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false); // the next episode waits again
    };
  }, [active, delayMs]);
  return active && elapsed;
}

/**
 * Offline / reconnecting notice, from what the app actually knows (see lib/connectivity.js):
 * a network interface alone does not count as online. Messages typed meanwhile are queued.
 */
export function ConnectionBanner() {
  const realtime = useMessagingStore((state) => state.realtime);
  const status = useConnectivity(realtime);
  const reason = useOfflineReason(realtime);
  const slowConnecting = useActiveFor(
    status === CONNECTIVITY.CONNECTING,
    CONNECTING_NOTICE_DELAY_MS,
  );

  // Only the live status decides: a sync that failed during an outage must not keep saying
  // "offline" after the connection is back (the engine re-syncs on recovery).
  let text = null;
  if (status === CONNECTIVITY.OFFLINE) {
    // The phone's own internet may be fine while our server is unreachable: say which.
    text =
      reason === 'server'
        ? 'Can’t reach CipherChat right now. Messages will be sent when it’s back.'
        : 'You’re offline. Messages will be sent when you reconnect.';
  } else if (status === CONNECTIVITY.CONNECTING) {
    if (slowConnecting) text = realtime === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  } else if (realtime !== 'connected' && realtime !== 'idle' && realtime !== 'paused') {
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
