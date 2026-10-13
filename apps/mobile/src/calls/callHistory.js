import { CALL_LIMITS } from '@secure-chat/shared/constants';
import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';

import { ENDPOINTS } from '../config/endpoints';
import { getDatabase } from '../db/database';
import { apiRequest } from '../lib/api';
import { END_REASON } from './callMachine';

/**
 * Voice call history, kept only on this phone: a table in the SQLCipher database, deleted with
 * it on sign-out and account deletion. The server keeps no call history. It only holds a
 * short-lived note of each call nobody answered, so a missed call still reaches this list when
 * the app was closed while it rang (collected by syncMissedCalls, then deleted on the server).
 */

export const CALL_OUTCOME = Object.freeze({
  ANSWERED: 'answered',
  /** Incoming, never answered (rang out, or the caller gave up). */
  MISSED: 'missed',
  /** Incoming: we declined. Outgoing: they declined. */
  DECLINED: 'declined',
  /** Outgoing: rang out unanswered. */
  NO_ANSWER: 'no_answer',
  /** Outgoing: we hung up before it was answered. */
  CANCELLED: 'cancelled',
  BUSY: 'busy',
  UNAVAILABLE: 'unavailable',
  /** Answered or dialled, but audio never connected. */
  FAILED: 'failed',
  /**
   * Connected, then this phone's app was killed or crashed before the call was recorded:
   * found at the next start (see recoverInterruptedCall). Its end time is approximate.
   */
  INTERRUPTED: 'interrupted',
});

const O = CALL_OUTCOME;

/** Bumped on every change to the history, so screens showing it read it again. */
export const useCallLogStore = create(() => ({ revision: 0 }));
const changed = () => useCallLogStore.setState((state) => ({ revision: state.revision + 1 }));
/** Call-related local data changed outside this module (e.g. a chat was created for a caller). */
export const bumpCallRevision = changed;

const OUTGOING_NOT_CONNECTED = {
  [END_REASON.REJECTED]: O.DECLINED,
  [END_REASON.MISSED]: O.NO_ANSWER,
  [END_REASON.HANGUP]: O.CANCELLED,
  [END_REASON.BUSY]: O.BUSY,
  [END_REASON.UNAVAILABLE]: O.UNAVAILABLE,
};

const INCOMING_NOT_CONNECTED = {
  [END_REASON.DECLINED]: O.DECLINED,
  [END_REASON.MISSED]: O.MISSED,
  // The caller hung up before audio connected.
  [END_REASON.REMOTE_HANGUP]: O.MISSED,
};

/**
 * How a finished call goes into the history. Null for attempts that never became a call (no
 * microphone permission, already in another call, a security code to review first) and for
 * sign-out (the history is being wiped anyway).
 *
 * @param {{ direction: 'incoming'|'outgoing', reason: string, connected: boolean }} call
 */
export function callOutcome({ direction, reason, connected }) {
  if (reason === END_REASON.SIGNED_OUT) return null;
  if (connected) return O.ANSWERED;
  if (direction === 'outgoing') {
    if (
      reason === END_REASON.PERMISSION_DENIED ||
      reason === END_REASON.CAMERA_DENIED ||
      reason === END_REASON.MEDIA_UNAVAILABLE ||
      reason === END_REASON.ALREADY_IN_CALL ||
      reason === END_REASON.IDENTITY_CHANGED
    ) {
      return null;
    }
    return OUTGOING_NOT_CONNECTED[reason] ?? O.FAILED;
  }
  return INCOMING_NOT_CONNECTED[reason] ?? O.FAILED;
}

/** 2:05, or 1:02:05 for calls over an hour. */
export function formatCallDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

const DETAIL = {
  [O.NO_ANSWER]: 'No answer',
  [O.DECLINED]: 'Declined',
  [O.CANCELLED]: 'Cancelled',
  [O.BUSY]: 'Busy',
  [O.UNAVAILABLE]: 'Unavailable',
  [O.FAILED]: 'Not connected',
  [O.INTERRUPTED]: 'Interrupted',
};

/**
 * How a history entry reads, in the Calls tab and in the chat timeline.
 *
 * @param {{ direction: 'in'|'out', outcome: string, kind?: string,
 *           connectedAt?: number|null, endedAt: number }} entry
 * @returns {{ outgoing: boolean, missed: boolean, video: boolean, title: string, kind: string,
 *             detail: string }}
 */
export function describeCall(entry) {
  const outgoing = entry.direction === 'out';
  const missed = !outgoing && entry.outcome === O.MISSED;
  const answered = entry.outcome === O.ANSWERED && entry.connectedAt != null;
  const video = entry.kind === 'video';
  const noun = video ? 'video call' : 'voice call';
  return {
    outgoing,
    missed,
    video,
    title: missed ? `Missed ${noun}` : video ? 'Video call' : 'Voice call',
    kind: missed ? 'Missed' : outgoing ? 'Outgoing' : 'Incoming',
    detail: answered
      ? formatCallDuration(entry.endedAt - entry.connectedAt)
      : missed
        ? ''
        : (DETAIL[entry.outcome] ?? ''),
  };
}

/**
 * Adds one call. A call id already in the history is kept as it is: this phone's own record of
 * a call is never replaced by the server's missed-call note for it.
 */
export async function recordCall({
  callId,
  peerUserId,
  direction,
  kind = 'voice',
  outcome,
  startedAt,
  connectedAt = null,
  endedAt = Date.now(),
}) {
  const result = await getDatabase().runAsync(
    `INSERT OR IGNORE INTO call_log
       (call_id, peer_user_id, direction, kind, outcome, started_at, connected_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    // Calls refused before the server created them (busy, offline...) have no server id.
    callId ?? `local-${randomUUID()}`,
    peerUserId,
    direction === 'outgoing' ? 'out' : 'in',
    kind === 'video' ? 'video' : 'voice',
    outcome,
    startedAt,
    connectedAt,
    endedAt,
  );
  if (result.changes > 0) changed();
}

const SELECT = `SELECT l.call_id AS callId, l.peer_user_id AS peerUserId, l.direction, l.kind,
                       l.outcome, l.started_at AS startedAt, l.connected_at AS connectedAt,
                       l.ended_at AS endedAt`;

/**
 * Most recent calls first, with the conversation's local name and lock state. Callers must
 * hide the identity of calls whose conversation is locked (see the Calls tab).
 */
export async function listCallLog(limit = 300) {
  return getDatabase().getAllAsync(
    `${SELECT}, c.title, c.peer_phone AS peerPhone, COALESCE(c.locked, 0) AS locked
       FROM call_log l LEFT JOIN conversations c ON c.peer_user_id = l.peer_user_id
      ORDER BY l.started_at DESC LIMIT ?;`,
    limit,
  );
}

/** Calls with one person, newest first (shown in that chat's timeline). */
export async function listPeerCalls(peerUserId, limit = 200) {
  return getDatabase().getAllAsync(
    `${SELECT} FROM call_log l WHERE l.peer_user_id = ? ORDER BY l.started_at DESC LIMIT ?;`,
    peerUserId,
    limit,
  );
}

export async function deleteCallLogEntry(callId) {
  const result = await getDatabase().runAsync('DELETE FROM call_log WHERE call_id = ?;', callId);
  if (result.changes > 0) changed();
}

const timeOr = (value, fallback) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
};

/**
 * Moves the server's missed-call notes into the local history, then lets the server forget
 * them. Notes are acknowledged only after they are saved, so a crash in between just collects
 * them again (saving is idempotent). Best effort: offline, it runs again on the next
 * reconnect / foreground. Single-flight.
 *
 * @returns {Promise<number>} notes collected
 */
let syncing = null;
export function syncMissedCalls() {
  syncing ??= collectMissedCalls()
    .catch(() => 0)
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

async function collectMissedCalls() {
  const { missed } = await apiRequest('GET', ENDPOINTS.CALLS.MISSED);
  if (!Array.isArray(missed) || missed.length === 0) return 0;
  const saved = [];
  for (const note of missed) {
    if (typeof note?.callId !== 'string' || typeof note.callerUserId !== 'string') continue;
    const startedAt = timeOr(note.createdAt, Date.now());
    await recordCall({
      callId: note.callId,
      peerUserId: note.callerUserId,
      direction: 'incoming',
      kind: note.kind,
      outcome: O.MISSED,
      startedAt,
      endedAt: timeOr(note.endedAt, startedAt),
    });
    saved.push(note.callId);
  }
  for (let i = 0; i < saved.length; i += CALL_LIMITS.MISSED_MAX) {
    await apiRequest('POST', ENDPOINTS.CALLS.MISSED_ACK, {
      body: { callIds: saved.slice(i, i + CALL_LIMITS.MISSED_MAX) },
    });
  }
  return saved.length;
}
