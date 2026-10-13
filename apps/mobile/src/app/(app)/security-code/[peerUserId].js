import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../../../auth/authStore';
import { ChatLockGate } from '../../../components/ChatLockGate';
import { PrimaryButton, TextButton } from '../../../components/ui';
import { getSecurityCode } from '../../../crypto/signalService';
import { peerLabel } from '../../../messaging/hooks';
import { getConversation } from '../../../messaging/messageStore';
import { acceptSecurityCode, useMessagingStore } from '../../../messaging/messagingEngine';
import { colors, radius, spacing, type } from '../../../theme';

/** "123451234512345…" (60 digits) -> four rows of three 5-digit groups (fits any phone). */
function codeRows(code) {
  const groups = code.match(/\d{5}/g) ?? [];
  const rows = [];
  for (let i = 0; i < groups.length; i += 3) rows.push(groups.slice(i, i + 3).join('   '));
  return rows;
}

/**
 * A contact's security code (libsignal safety number). Reached from the chat, so it goes
 * through the same Chat Lock gate: nothing about a locked chat is shown before authentication.
 */
export default function SecurityCodeScreen() {
  const { peerUserId } = useLocalSearchParams();
  const peer = String(peerUserId);
  return (
    <ChatLockGate peerUserId={peer}>
      <SecurityCodeContent peer={peer} />
    </ChatLockGate>
  );
}

function SecurityCodeContent({ peer }) {
  const me = useAuthStore((state) => state.user);
  const revision = useMessagingStore((state) => state.revision);
  const [state, setState] = useState({ loading: true, code: null, name: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [code, conversation] = await Promise.all([
        me ? getSecurityCode(me.id, peer) : null,
        getConversation(peer),
      ]);
      if (!cancelled) {
        setState({
          loading: false,
          code,
          name: peerLabel(peer, conversation?.title, conversation?.peerPhone),
        });
      }
    })().catch(() => !cancelled && setState((s) => ({ ...s, loading: false })));
    return () => {
      cancelled = true;
    };
  }, [me, peer, revision]);

  const { loading, code, name } = state;

  async function accept() {
    setBusy(true);
    try {
      const accepted = await acceptSecurityCode(me.id, peer, code.identityKey);
      if (accepted) router.back();
      else {
        Alert.alert(
          'Security code changed again',
          `${name}'s security code changed again. Review the new code before accepting it.`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const confirmAccept = () =>
    Alert.alert(
      'Accept new security code?',
      `Only accept if you compared this code with ${name}, or you know why it changed (for example, they reinstalled CipherChat or signed in again).`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept', onPress: accept },
      ],
    );

  if (loading) return <ActivityIndicator style={styles.loading} color={colors.primary} />;

  if (!code) {
    return (
      <View style={styles.container}>
        <Text style={styles.body}>
          There is no security code for {name} yet. It appears after you exchange a message.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ headerTitle: 'Security code' }} />
      <View style={styles.icon}>
        <Ionicons
          name={code.pending ? 'shield-outline' : 'shield-checkmark-outline'}
          size={36}
          color={code.pending ? colors.warning : colors.primary}
        />
      </View>
      <Text style={styles.title}>
        {code.pending ? 'Security code changed' : `Security code with ${name}`}
      </Text>
      {code.pending ? (
        <Text style={styles.body}>
          {name}&apos;s security code changed. This usually happens when they reinstall CipherChat
          or sign in again, but it could also mean someone is trying to intercept your messages.
          Their new messages are held, and yours won&apos;t be sent, until you accept the new code.
        </Text>
      ) : null}

      <View style={styles.code} testID="security-code">
        {codeRows(code.code).map((row) => (
          <Text key={row} style={styles.codeRow}>
            {row}
          </Text>
        ))}
      </View>

      <Text style={styles.body}>
        To check, compare this code with the one {name} sees for you on their phone, in person or on
        a call. If the numbers match, messages between you are end-to-end encrypted with each
        other&apos;s phones.
      </Text>

      {code.pending ? (
        <View style={styles.actions}>
          <PrimaryButton title="Accept new security code" onPress={confirmAccept} loading={busy} />
          <TextButton title="Not now" onPress={() => router.back()} disabled={busy} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.xl, gap: spacing.lg, alignItems: 'stretch' },
  loading: { marginTop: spacing.xxl },
  icon: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...type.heading, textAlign: 'center' },
  body: { ...type.secondary, lineHeight: 20 },
  code: {
    alignSelf: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  codeRow: {
    fontFamily: 'monospace',
    fontSize: 18,
    letterSpacing: 1,
    color: colors.text,
    textAlign: 'center',
  },
  actions: { gap: spacing.sm },
});
