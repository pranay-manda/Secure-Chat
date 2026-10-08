import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../../../auth/authStore';
import { Avatar, ListRow, SectionHeader } from '../../../components/design';
import { formatPhone } from '../../../lib/phone';
import {
  registerForPushNotifications,
  usePushStore,
} from '../../../notifications/pushNotifications';
import { colors, spacing, type } from '../../../theme';

const NOTIFICATION_LABEL = {
  granted: 'On',
  denied: 'Off (blocked in system settings)',
  unavailable: 'Unavailable on this build',
  error: 'Not registered — tap to retry',
  unknown: 'Checking…',
};

export default function SettingsScreen() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const pushStatus = usePushStore((state) => state.status);
  const [loggingOut, setLoggingOut] = useState(false);

  const identifier = user ? (user.email ?? formatPhone(user.phoneNumber)) : '';

  const confirmLogout = () =>
    Alert.alert('Log out?', 'This removes your session, keys and messages from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: async () => {
          setLoggingOut(true);
          await logout();
        },
      },
    ]);

  const onNotifications = () => {
    if (pushStatus === 'denied') Linking.openSettings();
    else registerForPushNotifications({ force: true });
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.profile}>
        <Avatar id={user?.id} name={user?.displayName} size={64} />
        <View style={styles.profileText}>
          <Text style={type.title} numberOfLines={1}>
            {user?.displayName || identifier}
          </Text>
          <Text style={type.secondary}>End-to-end encrypted account</Text>
        </View>
      </View>

      <SectionHeader>Account</SectionHeader>
      <ListRow
        icon="person-circle-outline"
        title="Profile"
        subtitle="Name and photo"
        badge="Soon"
        disabled
      />
      <ListRow
        icon="key-outline"
        title="Your ID"
        subtitle={user?.id}
        onPress={() => Share.share({ message: user?.id ?? '' })}
      />
      <ListRow icon="mail-outline" title="Signed in with" subtitle={identifier} />

      <SectionHeader>Privacy & security</SectionHeader>
      <ListRow
        icon="eye-off-outline"
        title="Privacy"
        subtitle="Last seen, read receipts"
        badge="Soon"
        disabled
      />
      <ListRow
        icon="lock-closed-outline"
        title="Chat lock"
        subtitle="Lock chats with your fingerprint"
        badge="Soon"
        disabled
      />
      <ListRow
        icon="shield-checkmark-outline"
        title="Security"
        subtitle="Encryption, session and local storage"
        onPress={() => router.push('/security')}
      />
      <ListRow
        icon="phone-portrait-outline"
        title="Devices"
        subtitle="Where you’re signed in"
        onPress={() => router.push('/devices')}
      />

      <SectionHeader>App</SectionHeader>
      <ListRow
        icon="notifications-outline"
        title="Notifications"
        subtitle={NOTIFICATION_LABEL[pushStatus] ?? pushStatus}
        onPress={onNotifications}
      />
      <ListRow
        icon="information-circle-outline"
        title="About"
        subtitle={`Secure Chat ${Constants.expoConfig?.version ?? ''}`}
      />

      <View style={styles.logout}>
        <ListRow
          icon="log-out-outline"
          title={loggingOut ? 'Logging out…' : 'Log out'}
          danger
          disabled={loggingOut}
          onPress={confirmLogout}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.divider,
  },
  profileText: { flex: 1, gap: 2 },
  logout: { marginTop: spacing.xl },
});
