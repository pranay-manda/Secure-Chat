/**
 * CipherChat design system: the only place colours, spacing and type sizes are defined.
 * Screens use these tokens instead of literal values.
 */

export const colors = {
  primary: '#0b6e4f',
  primaryPressed: '#095c42',
  primaryTint: '#e2f2eb',
  onPrimary: '#ffffff',
  background: '#ffffff',
  chatBackground: '#f1f4f2',
  surface: '#f6f8fa',
  bubbleOut: '#d6f0e3',
  bubbleIn: '#ffffff',
  text: '#1b1f23',
  muted: '#5f6b76',
  subtle: '#8b949e',
  border: '#d0d7de',
  divider: '#e6e9ec',
  danger: '#cf222e',
  dangerTint: '#fde8e8',
  read: '#1f6feb',
  notice: '#fff8c5',
  warning: '#9a6700',
  // Voice call screen (dark, like a phone call).
  callBackground: '#0d2b22',
  callControl: '#2c4a40',
  callMuted: '#b7c9c1',
  callAccept: '#1f9d55',
};

/** Avatar backgrounds, picked deterministically from the user id (no random colours). */
export const avatarPalette = ['#0b6e4f', '#1a7f8e', '#3f6fb5', '#6b5fb5', '#a35a8b', '#b06b2c'];

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };

export const type = {
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  heading: { fontSize: 17, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, color: colors.text },
  secondary: { fontSize: 14, color: colors.muted },
  caption: { fontSize: 12, color: colors.subtle },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
};

/** "14:05" today, "Yesterday", weekday within a week, else a short date. */
export function formatListTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (ms >= startOfToday) return formatClock(ms);
  if (ms >= startOfToday - day) return 'Yesterday';
  if (ms >= startOfToday - 6 * day) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

export function formatClock(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Label for a day separator in a conversation. */
export function formatDay(ms) {
  const label = formatListTime(ms);
  if (label === 'Yesterday') return label;
  const date = new Date(ms);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return 'Today';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
