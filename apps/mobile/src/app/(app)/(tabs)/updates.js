import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuthStore } from '../../../auth/authStore';
import { Avatar, EmptyState, SectionHeader } from '../../../components/design';
import { colors, spacing, type } from '../../../theme';

/**
 * Status/updates shell. Status updates are not implemented yet (no backend); this screen only
 * shows the layout they will use.
 */
export default function UpdatesScreen() {
  const user = useAuthStore((state) => state.user);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionHeader>Status</SectionHeader>
      <View style={styles.myStatus}>
        <Avatar id={user?.id} name={user?.displayName} size={52} />
        <View style={styles.myStatusText}>
          <Text style={type.heading}>My status</Text>
          <Text style={type.secondary}>Status updates are coming soon</Text>
        </View>
      </View>

      <SectionHeader>Recent updates</SectionHeader>
      <EmptyState
        icon="aperture-outline"
        title="No updates yet"
        message="Updates from your chats will appear here, end-to-end encrypted like your messages."
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1 },
  myStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  myStatusText: { gap: 2 },
});
