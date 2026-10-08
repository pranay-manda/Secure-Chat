import { OTP_LENGTH } from '@secure-chat/shared/constants';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../auth/authStore';
import { authErrorMessage } from '../auth/errorMessages';
import { colors, ErrorText, Field, PrimaryButton, TextButton } from '../components/ui';
import { formatPhone } from '../lib/phone';

function useCountdown(initialSeconds) {
  const [endsAt, setEndsAt] = useState(() => Date.now() + initialSeconds * 1000);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return [secondsLeft, (seconds) => setEndsAt(Date.now() + seconds * 1000)];
}

export default function VerifyScreen() {
  const params = useLocalSearchParams();
  const email = params.email ? String(params.email) : null;
  const identifier = email ? { email } : { phoneNumber: String(params.phoneNumber ?? '') };
  const verifyOtp = useAuthStore((state) => state.verifyOtp);
  const requestOtp = useAuthStore((state) => state.requestOtp);

  const [otp, setOtp] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resendIn, restartCountdown] = useCountdown(Number(params.resendAfterSeconds) || 60);

  async function submit(code = otp) {
    if (code.length !== OTP_LENGTH || loading) return;
    setError(null);
    setLoading(true);
    try {
      // On success the root layout's guard switches to the signed-in screens.
      await verifyOtp(identifier, code);
    } catch (err) {
      setError(authErrorMessage(err));
      setOtp('');
      setLoading(false);
    }
  }

  async function resend() {
    setError(null);
    try {
      const { resendAfterSeconds } = await requestOtp(identifier);
      restartCountdown(resendAfterSeconds);
    } catch (err) {
      setError(authErrorMessage(err));
      if (err?.retryAfterSeconds) restartCountdown(err.retryAfterSeconds);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>Enter the code</Text>
        <Text style={styles.subtitle}>
          Sent to {email ?? formatPhone(identifier.phoneNumber)}
          {email ? '. Check your spam folder if it hasn’t arrived.' : ''}
        </Text>

        <Field
          value={otp}
          onChangeText={(text) => {
            const digits = text.replace(/\D/g, '').slice(0, OTP_LENGTH);
            setOtp(digits);
            setError(null);
            if (digits.length === OTP_LENGTH) submit(digits);
          }}
          placeholder="123456"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete={email ? 'one-time-code' : 'sms-otp'}
          autoFocus
          maxLength={OTP_LENGTH}
          style={styles.otp}
          accessibilityLabel="Verification code"
          testID="otp-input"
        />
        <ErrorText>{error}</ErrorText>

        <PrimaryButton
          title="Verify"
          onPress={() => submit()}
          loading={loading}
          disabled={otp.length !== OTP_LENGTH}
        />

        <View style={styles.resend}>
          {resendIn > 0 ? (
            <Text style={styles.subtitle}>Resend code in {resendIn}s</Text>
          ) : (
            <TextButton title="Resend code" onPress={resend} />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, gap: 14 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: 15, color: colors.muted },
  otp: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 14,
    fontSize: 28,
    letterSpacing: 12,
    textAlign: 'center',
    color: colors.text,
  },
  resend: { alignItems: 'center', minHeight: 40, justifyContent: 'center' },
});
