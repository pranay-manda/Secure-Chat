import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { startCall } from '../../../calls/callEngine';
import { deleteCallLogEntry, describeCall } from '../../../calls/callHistory';
import { Avatar, EmptyState, Fab, IconButton } from '../../../components/design';
import { peerLabel, useCallLog } from '../../../messaging/hooks';
import { unlockChats, useChatLockStore } from '../../../security/chatLock';
import { colors, formatClock, formatListTime, spacing, type } from '../../../theme';

/** "Today, 14:05", "Yesterday, 09:12", "Mon, 18:40", "2 Oct 26, 11:00". */
function callTime(ms) {
  const day = formatListTime(ms);
  const clock = formatClock(ms);
  return `${day === clock ? 'Today' : day}, ${clock}`;
}

function CallRow({ entry, hidden }) {
  const call = describeCall(entry);
  const name = hidden ? 'Locked chat' : peerLabel(entry.peerUserId, entry.title, entry.peerPhone);
  const color = call.missed ? colors.danger : colors.primary;
  // The arrow shows the direction and a red name a missed call, so the line stays short.
  const meta = [callTime(entry.startedAt), call.video ? 'Video' : null, call.detail]
    .filter(Boolean)
    .join(' · ');

  // A locked chat's call says nothing about who it was until Chat Lock is unlocked.
  const open = () =>
    hidden ? unlockChats('Unlock to see this call') : router.push(`/chat/${entry.peerUserId}`);
  const remove = () =>
    Alert.alert('Delete from call history?', 'The call is removed from this phone only.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteCallLogEntry(entry.callId).catch(() => {}),
      },
    ]);

  return (
    <Pressable
      onPress={open}
      onLongPress={remove}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${call.kind} call, ${meta}`}
      accessibilityHint={hidden ? 'Unlocks to show who called' : 'Opens the chat'}
      testID={`call-log-${entry.callId}`}
    >
      {hidden ? (
        <View style={styles.lockedAvatar}>
          <Ionicons name="lock-closed" size={22} color={colors.primary} />
        </View>
      ) : (
        <Avatar id={entry.peerUserId} name={entry.title} />
      )}
      <View style={styles.rowText}>
        <Text style={[type.heading, call.missed && styles.missed]} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.meta}>
          <Ionicons
            name={call.outgoing ? 'arrow-up' : 'arrow-down'}
            size={14}
            color={color}
            style={styles.arrow}
          />
          <Text style={[type.secondary, styles.metaText]} numberOfLines={1}>
            {meta}
          </Text>
        </View>
      </View>
      {hidden ? null : (
        <IconButton
          icon={call.video ? 'videocam-outline' : 'call-outline'}
          label={`${call.video ? 'Video call' : 'Call'} ${name}`}
          color={colors.primary}
          onPress={() => startCall(entry.peerUserId, { video: call.video })}
        />
      )}
    </Pressable>
  );
}

/**
 * Calls tab: this phone's voice call history, newest first. It is kept only on this phone (see
 * calls/callHistory.js). New calls are started from a chat (call button in its header) or with
 * the call button of a row here.
 */
export default function CallsScreen() {
  const { data, error } = useCallLog();
  const unlocked = useChatLockStore((state) => state.unlocked);

  return (
    <View style={styles.container}>
      {data === null ? (
        <ActivityIndicator style={styles.loading} color={colors.primary} />
      ) : (
        <FlatList
          data={data}
          keyExtractor={(entry) => entry.callId}
          renderItem={({ item }) => (
            <CallRow entry={item} hidden={item.locked === 1 && !unlocked} />
          )}
          ListHeaderComponent={data.length > 0 ? <Text style={styles.section}>Recent</Text> : null}
          contentContainerStyle={data.length === 0 ? styles.emptyContainer : styles.list}
          ListEmptyComponent={
            <EmptyState
              icon={error ? 'alert-circle-outline' : 'call-outline'}
              title={error ? 'Could not load calls' : 'No calls yet'}
              message="Open a chat and tap the call button to start a voice call. Calls are encrypted in transit and go directly between the two phones when possible. Your call history is kept only on this phone."
            />
          }
        />
      )}
      <Fab icon="call" label="Start a call from a chat" disabled />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loading: { marginTop: spacing.xxl },
  list: { paddingBottom: 96 },
  emptyContainer: { flexGrow: 1 },
  section: {
    ...type.caption,
    fontWeight: '600',
    color: colors.muted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: { backgroundColor: colors.surface },
  rowText: { flex: 1, gap: 2 },
  missed: { color: colors.danger },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { flexShrink: 1 },
  // Diagonal arrows: incoming ↙, outgoing ↗.
  arrow: { transform: [{ rotate: '45deg' }] },
  lockedAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primaryTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
