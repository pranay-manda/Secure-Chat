import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors } from '../theme';

// Re-exported so existing screens keep importing colours from here.
export { colors };

export function PrimaryButton({ title, onPress, loading = false, disabled = false }) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.buttonPressed,
        inactive && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={styles.buttonText}>{title}</Text>
      )}
    </Pressable>
  );
}

export function TextButton({ title, onPress, disabled = false, color = colors.primary }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} hitSlop={8}>
      <Text style={[styles.textButton, { color }, disabled && styles.textButtonDisabled]}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Field(props) {
  return <TextInput placeholderTextColor={colors.muted} style={styles.field} {...props} />;
}

export function ErrorText({ children }) {
  if (!children) return null;
  return (
    <Text accessibilityRole="alert" style={styles.error}>
      {children}
    </Text>
  );
}

export function Card({ title, children }) {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
  },
  buttonPressed: { backgroundColor: colors.primaryPressed },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  textButton: { fontSize: 15, fontWeight: '600', paddingVertical: 8 },
  textButtonDisabled: { opacity: 0.5 },
  field: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    color: colors.text,
  },
  error: { color: colors.danger, fontSize: 14 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  cardTitle: { fontSize: 13, fontWeight: '700', color: colors.muted, textTransform: 'uppercase' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowLabel: { color: colors.muted, fontSize: 14 },
  rowValue: { color: colors.text, fontSize: 14, flexShrink: 1, textAlign: 'right' },
});
