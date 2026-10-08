import Ionicons from '@expo/vector-icons/Ionicons';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { Avatar, EmptyState, Fab } from '../../../components/design';
import { peerLabel } from '../../../messaging/hooks';
import { colors, formatListTime, spacing, type } from '../../../theme';

/** How each kind of call is shown once calling exists. */
const DIRECTION = {
  incoming: { icon: 'arrow-down', color: colors.primary, label: 'Incoming' },
  outgoing: { icon: 'arrow-up', color: colors.primary, label: 'Outgoing' },
  missed: { icon: 'arrow-down', color: colors.danger, label: 'Missed' },
};

function CallRow({ call }) {
  const direction = DIRECTION[call.direction];
  return (
    <View style={styles.row}>
      <Avatar id={call.peerUserId} name={call.title} />
      <View style={styles.rowText}>
        <Text style={[type.heading, call.direction === 'missed' && { color: colors.danger }]}>
          {peerLabel(call.peerUserId, call.title)}
        </Text>
        <View style={styles.meta}>
          <Ionicons name={direction.icon} size={14} color={direction.color} />
          <Text style={type.secondary}>
            {direction.label} · {formatListTime(call.at)}
          </Text>
        </View>
      </View>
      <Ionicons
        name={call.video ? 'videocam-outline' : 'call-outline'}
        size={22}
        color={colors.primary}
      />
    </View>
  );
}

/**
 * Calls UI shell, ready for the WebRTC phase. There is no calling yet, so the call history is
 * always empty and the call button is disabled: nothing here pretends a call happened.
 */
export default function CallsScreen() {
  const calls = [];

  return (
    <View style={styles.container}>
      <FlatList
        data={calls}
        keyExtractor={(call) => call.id}
        renderItem={({ item }) => <CallRow call={item} />}
        contentContainerStyle={styles.emptyContainer}
        ListEmptyComponent={
          <EmptyState
            icon="call-outline"
            title="No calls yet"
            message="Voice and video calls are coming in a future update. They will be end-to-end encrypted, like your chats."
          />
        }
      />
      <Fab icon="call" label="New call (coming soon)" disabled />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  emptyContainer: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowText: { flex: 1, gap: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
