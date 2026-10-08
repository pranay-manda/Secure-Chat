import { objectIdSchema } from '@secure-chat/shared/validation';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../../auth/authStore';
import { colors, ErrorText, Field, PrimaryButton } from '../../components/ui';
import { createConversation } from '../../messaging/messagingEngine';

/**
 * Starts a 1:1 chat from the other person's user ID (shared with you out of band, see
 * Settings > Your ID). There is no contact discovery in this phase. The optional name is a
 * local nickname stored only in this device's encrypted database.
 */
export default function NewChatScreen() {
  const me = useAuthStore((state) => state.user);
  const [peerId, setPeerId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function start() {
    const id = peerId.trim().toLowerCase();
    if (!objectIdSchema.safeParse(id).success) {
      setError('Enter the 24-character ID from the other person’s Settings screen.');
      return;
    }
    if (id === me?.id) {
      setError('That is your own ID.');
      return;
    }
    setLoading(true);
    try {
      await createConversation(id, name);
      router.replace(`/chat/${id}`);
    } catch {
      setError('Could not create the chat. Please try again.');
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.subtitle}>
          Ask the other person for their ID (Settings → Your ID → Share my ID).
        </Text>
        <Field
          value={peerId}
          onChangeText={(text) => {
            setPeerId(text);
            setError(null);
          }}
          placeholder="User ID"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          maxLength={40}
          accessibilityLabel="User ID"
          testID="peer-id-input"
        />
        <Field
          value={name}
          onChangeText={setName}
          placeholder="Name (optional)"
          maxLength={64}
          onSubmitEditing={start}
          accessibilityLabel="Name"
          testID="peer-name-input"
        />
        <ErrorText>{error}</ErrorText>
        <PrimaryButton title="Start chat" onPress={start} loading={loading} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, gap: 14 },
  subtitle: { fontSize: 15, color: colors.muted },
});
