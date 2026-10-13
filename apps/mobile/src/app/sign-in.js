import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../auth/authStore';
import { authErrorMessage } from '../auth/errorMessages';
import { colors, ErrorText, Field, PrimaryButton, TextButton } from '../components/ui';
import { readSignInForm } from '../auth/signInForm';

export default function SignInScreen() {
  const requestOtp = useAuthStore((state) => state.requestOtp);
  const notice = useAuthStore((state) => state.notice);
  const clearNotice = useAuthStore((state) => state.clearNotice);
  const [mode, setMode] = useState('email');
  const [emailInput, setEmailInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    const form = readSignInForm({ mode, emailInput, phoneInput });
    if (form.error) {
      setError(form.error);
      return;
    }
    setError(null);
    clearNotice();
    setLoading(true);
    try {
      const { resendAfterSeconds } = await requestOtp(form.request);
      router.push({ pathname: '/verify', params: { ...form.verify, resendAfterSeconds } });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  const switchMode = () => {
    setMode((m) => (m === 'email' ? 'phone' : 'email'));
    setError(null);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Welcome to CipherChat</Text>
        <Text style={styles.subtitle}>
          {mode === 'email'
            ? 'Enter your email and phone number. We’ll email you a 6-digit code.'
            : 'We’ll send a 6-digit code to your phone.'}
        </Text>

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        {mode === 'email' ? (
          <Field
            value={emailInput}
            onChangeText={(text) => {
              setEmailInput(text);
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
            returnKeyType="next"
            accessibilityLabel="Email address"
            testID="email-input"
          />
        ) : null}

        <Field
          value={phoneInput}
          onChangeText={(text) => {
            setPhoneInput(text);
            setError(null);
          }}
          placeholder="+91 Phone number"
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          autoFocus={mode === 'phone'}
          maxLength={20}
          onSubmitEditing={submit}
          accessibilityLabel="Phone number"
          testID="phone-input"
        />
        {mode === 'email' ? (
          <Text style={styles.hint}>
            Friends who have your number in their contacts can find you on CipherChat.
          </Text>
        ) : null}
        <ErrorText>{error}</ErrorText>

        <PrimaryButton title="Continue" onPress={submit} loading={loading} />
        <View style={styles.switch}>
          <TextButton
            title={mode === 'email' ? 'Sign in with phone number instead' : 'Use email instead'}
            onPress={switchMode}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, gap: 14 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 15, color: colors.muted, marginBottom: 8 },
  hint: { fontSize: 13, color: colors.muted, marginTop: -6 },
  switch: { alignItems: 'center' },
  notice: {
    backgroundColor: '#fff8c5',
    color: colors.text,
    padding: 12,
    borderRadius: 8,
    fontSize: 14,
  },
});
