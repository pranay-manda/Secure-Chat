import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';

import { useUnreadTotal } from '../../../messaging/hooks';
import { colors } from '../../../theme';

/** Tab icon: filled when selected, outline otherwise. */
function icon(name) {
  return function TabIcon({ color, size, focused }) {
    return <Ionicons name={focused ? name : `${name}-outline`} size={size} color={color} />;
  };
}

/** Main bottom tabs. Screens that open on top (chat, new chat...) live in the parent stack. */
export default function TabsLayout() {
  const unread = useUnreadTotal();

  return (
    <Tabs
      screenOptions={{
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        headerTitleStyle: { fontSize: 22, fontWeight: '700', color: colors.text },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { borderTopColor: colors.divider, backgroundColor: colors.background },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Chats',
          headerTitle: 'Secure Chat',
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
