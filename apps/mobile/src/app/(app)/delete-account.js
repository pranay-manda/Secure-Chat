import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuthStore } from '../../auth/authStore';
import { ErrorText, PrimaryButton } from '../../components/ui';
import { NetworkError } from '../../lib/api';
import { colors, radius, spacing, type } from '../../theme';

/** What the user has to type to enable the button (explicit, not a single accidental tap). */
const CONFIRMATION_WORD = 'DELETE';

const CONSEQUENCES = [
  'Your account, phone number or email and profile are removed from Secure Chat.',
  'All your messages and chats on this phone are erased.',
  'Your encryption keys are destroyed. Messages waiting for you can never be read.',
  'You are signed out on every device.',
  'Contacts will no longer find you. If you sign up again, it will be a new account.',
];

/** Settings > Delete account. Permanent: requires typing the confirmation word, then a final OK. */
export default function DeleteAccountScreen() {
  const deleteAccount = useAuthStore((state) => state.deleteAccount);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const confirmed = typed.trim() === CONFIRMATION_WORD;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(); // on success the app returns to the sign-in screen
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof NetworkError
          ? 'No connection. Your account was not deleted; try again when you are online.'
          : 'Your account could not be deleted. Nothing was changed; please try again.',
      );
    }
  }

  const confirm = () =>
    Alert.alert('Delete account permanently?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete account', style: 'destructive', onPress: run },
    ]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <View style={styles.icon}>
        <Ionicons name="warning-outline" size={36} color={colors.danger} />
      </View>
      <Text style={styles.title}>Delete your account</Text>
      <Text style={styles.body}>This is permanent and cannot be undone:</Text>
      <View style={styles.list}>
        {CONSEQUENCES.map((line) => (
          <View key={line} style={styles.item}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.itemText}>{line}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.label}>Type {CONFIRMATION_WORD} to confirm</Text>
      <TextInput
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!busy}
        style={styles.input}
        accessibilityLabel={`Type ${CONFIRMATION_WORD} to confirm`}
        testID="delete-confirmation-input"
      />
      <ErrorText>{error}</ErrorText>
      <PrimaryButton
        title="Delete my account"
        onPress={confirm}
        loading={busy}
        disabled={!confirmed || busy}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.xl, gap: spacing.md },
  icon: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.notice,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { ...type.heading, textAlign: 'center' },
  body: { ...type.secondary },
  list: { gap: spacing.sm },
  item: { flexDirection: 'row', gap: spacing.sm },
  bullet: { ...type.secondary },
  itemText: { ...type.secondary, flex: 1, lineHeight: 20 },
  label: { ...type.caption, color: colors.text, marginTop: spacing.md },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...type.body,
  },
});
