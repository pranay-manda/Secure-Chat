import { emailSchema } from '@secure-chat/shared/validation';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuthStore } from '../auth/authStore';
import { authErrorMessage } from '../auth/errorMessages';
import { toE164 } from '../lib/phone';
import { colors, ErrorText, Field, PrimaryButton, TextButton } from './ui';

/**
 * Every CipherChat account has an email AND a phone number. Accounts from before that rule (or
 * created by phone sign-in) add the missing one here, once, before using the app.
 *
 *  - Phone number: saved as typed (like at sign-up; friends find you by it).
 *  - Email: proven with a code sent to it (that code can only add the email, never sign in).
 */
export function CompleteProfile() {
  const user = useAuthStore((state) => state.user);
  const addPhone = useAuthStore((state) => state.addPhone);
  const requestEmailCode = useAuthStore((state) => state.requestEmailCode);
  const addEmail = useAuthStore((state) => state.addEmail);
  const logout = useAuthStore((state) => state.logout);
  const insets = useSafeAreaInsets();

  const [phoneInput, setPhoneInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [codeFor, setCodeFor] = useState(null); // the email a code was sent to
  const [otp, setOtp] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const missingPhone = !user?.phoneNumber;

  const run = async (fn) => {
    setError(null);
    setLoading(true);
    try {
      await fn();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const savePhone = () => {
    const phoneNumber = toE164(phoneInput);
    if (!phoneNumber) {
      setError('Enter a valid mobile number, e.g. +91 98765 43210');
      return;
    }
    run(() => addPhone(phoneNumber));
  };

  const sendCode = () => {
    const email = emailSchema.safeParse(emailInput);
    if (!email.success) {
      setError('Enter a valid email address, e.g. you@example.com');
      return;
    }
    run(async () => {
      await requestEmailCode(email.data);
      setCodeFor(email.data);
    });
  };

  const confirmEmail = () => {
    if (otp.length !== 6) return;
    run(() => addEmail(codeFor, otp));
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top + 24 }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="complete-profile"
    >
      <View style={styles.content}>
        {missingPhone ? (
          <>
            <Text style={styles.title}>Add your phone number</Text>
            <Text style={styles.subtitle}>
              CipherChat accounts need a phone number, so friends who have it in their contacts can
              find you.
            </Text>
            <Field
              value={phoneInput}
              onChangeText={(text) => {
                setPhoneInput(text);
                setError(null);
              }}
              placeholder="+91 Phone number"
              keyboardType="phone-pad"
              autoComplete="tel"
              autoFocus
              maxLength={20}
              onSubmitEditing={savePhone}
              accessibilityLabel="Phone number"
              testID="profile-phone-input"
            />
            <ErrorText>{error}</ErrorText>
            <PrimaryButton title="Save" onPress={savePhone} loading={loading} />
          </>
        ) : codeFor ? (
          <>
            <Text style={styles.title}>Enter the code</Text>
            <Text style={styles.subtitle}>
              Sent to {codeFor}. Check your spam folder if it hasn’t arrived.
            </Text>
            <Field
              value={otp}
              onChangeText={(text) => {
                setOtp(text.replace(/\D/g, '').slice(0, 6));
                setError(null);
              }}
              placeholder="123456"
              keyboardType="number-pad"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              accessibilityLabel="Verification code"
              testID="profile-otp-input"
            />
            <ErrorText>{error}</ErrorText>
            <PrimaryButton
              title="Confirm"
              onPress={confirmEmail}
              loading={loading}
              disabled={otp.length !== 6}
            />
            <TextButton title="Use another email" onPress={() => setCodeFor(null)} />
          </>
        ) : (
          <>
            <Text style={styles.title}>Add your email</Text>
            <Text style={styles.subtitle}>
              CipherChat accounts need an email address. We’ll send a code to confirm it.
            </Text>
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
              autoFocus
              maxLength={254}
              onSubmitEditing={sendCode}
              accessibilityLabel="Email address"
              testID="profile-email-input"
            />
            <ErrorText>{error}</ErrorText>
            <PrimaryButton title="Send code" onPress={sendCode} loading={loading} />
          </>
        )}
        <View style={styles.signOut}>
          <TextButton title="Sign out" color={colors.muted} onPress={() => logout()} />
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
  signOut: { alignItems: 'center', marginTop: 12 },
});
