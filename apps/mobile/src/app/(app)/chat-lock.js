import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { ListRow, SectionHeader } from '../../components/design';
import { useLockedChatsSummary } from '../../messaging/hooks';
import { getChatLockCapability } from '../../security/chatLock';
import { colors, spacing, type } from '../../theme';

function methodLabel(capability) {
  if (!capability) return 'Checking…';
  if (!capability.available) return 'Not available: set up a screen lock on this device';
  const biometric = [capability.fingerprint && 'fingerprint', capability.face && 'face'].filter(
    Boolean,
  );
  return capability.biometric && biometric.length
    ? `${biometric.join(' or ')}, with your screen lock as backup`
    : 'Your screen lock (PIN, pattern or password)';
}

/** Chat Lock status. Lock and unlock individual chats from the chat itself or a long press. */
export default function ChatLockScreen() {
  const [capability, setCapability] = useState(null);
  const { data: summary } = useLockedChatsSummary();

  useEffect(() => {
    getChatLockCapability().then(setCapability);
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionHeader>Authentication</SectionHeader>
      <ListRow icon="finger-print-outline" title="Unlock with" subtitle={methodLabel(capability)} />

      <SectionHeader>Locked chats</SectionHeader>
      <ListRow
        icon="lock-closed-outline"
        title="Locked chats"
        value={summary ? String(summary.total) : '…'}
        onPress={() => router.push('/locked-chats')}
      />

      <Text style={styles.note}>
        Chat Lock hides chats from your chat list and asks for your fingerprint, face or screen lock
        before opening them on this phone. It is local protection only: all your messages are
        already end-to-end encrypted. Notifications never show who wrote or what was written. Locked
        chats stay locked after restarting the app; logging out removes them from this phone along
        with all other messages.
      </Text>
      <Text style={styles.note}>
        To lock a chat, open it and tap the lock icon, or long press it in your chat list.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  note: { ...type.caption, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, lineHeight: 18 },
});
