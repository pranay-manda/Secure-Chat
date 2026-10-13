import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { avatarPalette, colors, radius, spacing, type } from '../theme';

/** Stable colour for an id (same person, same colour, on every screen). */
function paletteColor(id) {
  let hash = 0;
  for (const ch of String(id ?? '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return avatarPalette[hash % avatarPalette.length];
}

/** Initials avatar (no photos yet). Falls back to a person icon when there is no name. */
export function Avatar({ id, name, size = 48 }) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: paletteColor(id) },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {initials ? (
        <Text style={[styles.initials, { fontSize: size * 0.38 }]}>{initials}</Text>
      ) : (
        <Ionicons name="person" size={size * 0.5} color={colors.onPrimary} />
      )}
    </View>
  );
}

/** Round icon button for headers and toolbars. */
export function IconButton({
  icon,
  onPress,
  label,
  color = colors.text,
  disabled,
  size = 24,
  testID,
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}

/** Floating action button (bottom right). */
export function Fab({ icon, onPress, label, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.fab,
        pressed && { backgroundColor: colors.primaryPressed },
        disabled && styles.disabled,
      ]}
    >
      <Ionicons name={icon} size={26} color={colors.onPrimary} />
    </Pressable>
  );
}

export function EmptyState({ icon, title, message, children }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={36} color={colors.primary} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
      {children}
    </View>
  );
}

export function SectionHeader({ children }) {
  return <Text style={styles.sectionHeader}>{children}</Text>;
}

/**
 * Settings-style row. `badge` shows a small pill (e.g. "Soon"); rows without `onPress` render
 * as plain information.
 */
export function ListRow({ icon, title, subtitle, value, onPress, danger, badge, disabled }) {
  const content = (
    <>
      {icon ? (
        <View style={styles.rowIcon}>
          <Ionicons name={icon} size={22} color={danger ? colors.danger : colors.primary} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, danger && { color: colors.danger }]}>{title}</Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      {onPress && !disabled && !danger ? (
        <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
      ) : null}
    </>
  );
  if (!onPress) {
    return <View style={[styles.row, disabled && styles.disabled]}>{content}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        disabled && styles.disabled,
      ]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  initials: { color: colors.onPrimary, fontWeight: '700' },
  iconButton: { padding: spacing.sm, borderRadius: radius.pill },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: { ...type.heading, textAlign: 'center' },
  emptyMessage: {
    ...type.secondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  sectionHeader: {
    ...type.sectionLabel,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 56,
    backgroundColor: colors.background,
  },
  rowPressed: { backgroundColor: colors.surface },
  rowIcon: { width: 28, alignItems: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: type.body,
  rowSubtitle: type.secondary,
  rowValue: type.secondary,
  badge: {
    ...type.caption,
    color: colors.primary,
    backgroundColor: colors.primaryTint,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
});
