import { emailSchema } from '@secure-chat/shared/validation';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../auth/authStore';
import { authErrorMessage } from '../auth/errorMessages';
import { colors, ErrorText, Field, PrimaryButton } from '../components/ui';
import { toE164 } from '../lib/phone';

/** Turns the form into `{ email }` / `{ phoneNumber }`, or an error message. */
function readIdentifier(emailInput, phoneInput) {
  if (emailInput.trim()) {
    const parsed = emailSchema.safeParse(emailInput);
    return parsed.success
      ? { identifier: { email: parsed.data } }
      : { error: 'Enter a valid email address, e.g. you@example.com' };
  }
  if (phoneInput.trim()) {
    const phoneNumber = toE164(phoneInput);
    return phoneNumber
      ? { identifier: { phoneNumber } }
      : { error: 'Enter a valid mobile number, e.g. +91 98765 43210' };
  }
  return { error: 'Enter your email address or phone number' };
}

export default function SignInScreen() {
  const requestOtp = useAuthStore((state) => state.requestOtp);
  const notice = useAuthStore((state) => state.notice);
  const clearNotice = useAuthStore((state) => state.clearNotice);
  const [emailInput, setEmailInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    const { identifier, error: inputError } = readIdentifier(emailInput, phoneInput);
    if (inputError) {
      setError(inputError);
      return;
    }
    setError(null);
    clearNotice();
    setLoading(true);
    try {
      const { resendAfterSeconds } = await requestOtp(identifier);
      router.push({ pathname: '/verify', params: { ...identifier, resendAfterSeconds } });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Welcome</Text>
        <Text style={styles.subtitle}>We’ll send you a 6-digit code to sign in.</Text>

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        {/* Only one identifier is used: typing in one field clears the other. */}
        <Field
          value={emailInput}
          onChangeText={(text) => {
            setEmailInput(text);
            if (text) setPhoneInput('');
            setError(null);
          }}
          placeholder="Email address"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          autoFocus
          maxLength={254}
          onSubmitEditing={submit}
          accessibilityLabel="Email address"
          testID="email-input"
        />

        <View style={styles.divider}>
          <View style={styles.line} />
          <Text style={styles.or}>OR</Text>
          <View style={styles.line} />
        </View>

        <Field
          value={phoneInput}
          onChangeText={(text) => {
            setPhoneInput(text);
            if (text) setEmailInput('');
            setError(null);
          }}
          placeholder="+91 Phone number"
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          maxLength={20}
          onSubmitEditing={submit}
          accessibilityLabel="Phone number"
          testID="phone-input"
        />
        <ErrorText>{error}</ErrorText>

        <PrimaryButton title="Continue" onPress={submit} loading={loading} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, gap: 14 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 15, color: colors.muted, marginBottom: 8 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  line: { flex: 1, height: 1, backgroundColor: colors.border },
  or: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  notice: {
    backgroundColor: '#fff8c5',
    color: colors.text,
    padding: 12,
    borderRadius: 8,
    fontSize: 14,
  },
});
