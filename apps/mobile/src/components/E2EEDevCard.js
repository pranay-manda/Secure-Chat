import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { useAuthStore } from '../auth/authStore';
import { sendText, syncInbox } from '../crypto/signalService';
import { listRecentMessages } from '../crypto/signalStore';
import { useSignalSetup } from '../crypto/useSignalSetup';
import { Card, colors, ErrorText, Row, TextButton } from './ui';

/**
 * DEVELOPMENT-ONLY Phase 3A diagnostics: key registration state, manual inbox sync and a
 * one-tap encrypted reply to the last sender. The real chat UI arrives in a later phase.
 */
export function E2EEDevCard() {
  const user = useAuthStore((state) => state.user);
  const setup = useSignalSetup();
  const [messages, setMessages] = useState([]);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setMessages(await listRecentMessages(5));
  }, []);

  useEffect(() => {
    if (setup.state !== 'ready') return undefined;
    let cancelled = false;
    listRecentMessages(5).then((rows) => {
      if (!cancelled) setMessages(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [setup.state]);

  const run = (fn) => async () => {
    setError(null);
    try {
      setInfo(await fn());
      await refresh();
    } catch (err) {
      setError(err?.code ?? err?.message ?? 'Failed');
    }
  };

  const lastIncoming = messages.find((m) => m.direction === 'in');

  return (
    <Card title="E2EE (developer)">
      <Row label="My user ID" value={user?.id ?? ''} />
      <Row label="Signal keys" value={setup.state} />
      {setup.status ? (
        <Row label="One-time pre-keys on server" value={String(setup.status.oneTimePreKeyCount)} />
      ) : null}
      <ErrorText>{setup.error ?? error}</ErrorText>
      {info ? <Text style={styles.muted}>{JSON.stringify(info)}</Text> : null}

      <TextButton title="Sync inbox" onPress={run(() => syncInbox(user.id))} />
      <TextButton
        title="Reply to last sender"
        disabled={!lastIncoming}
        onPress={run(() =>
          sendText(
            user.id,
            lastIncoming.peerUserId,
            `reply from phone at ${new Date().toISOString()}`,
          ),
        )}
      />

      {messages.map((m) => (
        <Text key={m.id} style={styles.message} selectable>
          {m.direction === 'in' ? '⬇' : '⬆'} {m.body} ({m.status})
        </Text>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  muted: { color: colors.muted, fontSize: 12 },
  message: { color: colors.text, fontSize: 14 },
});
