import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUnreadTotal } from '../../../messaging/hooks';
import { colors, radius, spacing } from '../../../theme';

/** Height of the icons + labels row, above the system navigation area. */
const TAB_ROW_HEIGHT = 56;

/** Tab icon: filled when selected, outline otherwise. */
function icon(name) {
  return function TabIcon({ color, size, focused }) {
    return <Ionicons name={focused ? name : `${name}-outline`} size={size} color={color} />;
  };
}

/** Main bottom tabs. Screens that open on top (chat, new chat...) live in the parent stack. */
export default function TabsLayout() {
  const unread = useUnreadTotal();
  const insets = useSafeAreaInsets();
  // Keep the labels clear of the gesture bar / navigation buttons (edge-to-edge), with a
  // little extra room even where the system reports no inset.
  const bottom = Math.max(insets.bottom, spacing.sm) + spacing.sm;

  return (
    <Tabs
      screenOptions={{
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        headerTitleStyle: { fontSize: 22, fontWeight: '700', color: colors.text },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          height: TAB_ROW_HEIGHT + bottom,
          paddingTop: spacing.sm,
          paddingBottom: bottom,
          backgroundColor: colors.background,
          borderTopWidth: 0,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          // The shadow outlines the rounded top edge against the screen above it.
          elevation: 12,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.08,
          shadowRadius: 8,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chats',
          headerTitle: 'CipherChat',
          headerTitleStyle: { fontSize: 22, fontWeight: '700', color: colors.primary },
          tabBarIcon: icon('chatbubbles'),
          tabBarBadge: unread > 0 ? (unread > 99 ? '99+' : unread) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.primary, fontSize: 11 },
        }}
      />
      <Tabs.Screen name="updates" options={{ title: 'Updates', tabBarIcon: icon('aperture') }} />
      <Tabs.Screen name="calls" options={{ title: 'Calls', tabBarIcon: icon('call') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings') }} />
    </Tabs>
  );
}
