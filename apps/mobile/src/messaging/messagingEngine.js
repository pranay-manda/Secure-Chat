import { LIMITS, PRESENCE } from '@secure-chat/shared/constants';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { create } from 'zustand';

import {
  handleCallEvent,
  handleCallNetworkChange,
  isCallActive,
  reconcileCall,
  recoverInterruptedCall,
  useCallStore,
} from '../calls/callEngine';
import { syncMissedCalls } from '../calls/callHistory';
import { isActivePhase } from '../calls/callMachine';
import { ENDPOINTS } from '../config/endpoints';
import {
  acceptIdentityChange,
  deliverOutgoing,
  enqueueAttachment,
  enqueueText,
  ensureKeysRegistered,
  flushOutbox,
  handleRealtimeEnvelope,
  retryMessage,
  syncInbox,
} from '../crypto/signalService';
import { apiRequest, NetworkError } from '../lib/api';
import { applyNetworkState, useConnectivityStore } from '../lib/connectivity';
import { systemUiGraceMs } from '../lib/systemUi';
import {
  cleanUpMediaFiles,
  downloadPendingAttachments,
  prepareAttachment,
  releaseAllPlaintext,
} from '../media/attachmentService';
import { handlePresenceEvent, handleTypingEvent } from '../presence/usePresence';
import * as messages from './messageStore';
import { connectRealtime } from './realtime';

/** While realtime is not connected, poll the server this often (app in foreground only). */
const POLL_INTERVAL_MS = 30_000;
/** Online-status heartbeat (see the API's presenceService): two beats per server TTL. */
const HEARTBEAT_INTERVAL_MS = PRESENCE.HEARTBEAT_INTERVAL_SECONDS * 1000;

/**
 * UI-facing messaging state. `revision` increases whenever local messages change, so screens
 * know when to re-read the encrypted database.
 *
 * realtime: idle | connecting | connected | unavailable | disconnected | failed
 */
export const useMessagingStore = create(() => ({
  online: true,
  realtime: 'idle',
  syncing: false,
  lastSyncError: null,
  revision: 0,
}));

const bump = () => useMessagingStore.setState((s) => ({ revision: s.revision + 1 }));

/** Tells screens that local conversation data changed (e.g. a chat was locked). */
export const bumpRevision = bump;

let engine = null;

/** True while `run` belongs to the current, not yet stopped engine. */
const isCurrent = (run) => engine === run && !run.stopped;

/**
 * Full catch-up, in order: resend queued messages, pull and decrypt pending envelopes, send
 * read receipts, refresh delivery/read state of our messages. Every step is idempotent.
 */
async function runSync(run) {
  const { userId } = run;
  useMessagingStore.setState({ syncing: true });
  try {
    await flushOutbox(userId);
    if (!isCurrent(run)) return;
    await syncInbox(userId);
    if (!isCurrent(run)) return;
    fetchAttachments(run);
    await sendReadReceipts();
    await refreshOutgoingStatuses();
    if (isCurrent(run)) useMessagingStore.setState({ lastSyncError: null });
  } catch (err) {
    if (isCurrent(run)) {
      useMessagingStore.setState({
        lastSyncError: err instanceof NetworkError ? 'offline' : (err?.code ?? 'error'),
      });
    }
  } finally {
    if (isCurrent(run)) {
      useMessagingStore.setState({ syncing: false });
      bump();
    }
  }
}

/** Single-flight with one queued re-run, so a sync requested mid-run is never lost. */
export function requestSync() {
  const run = engine;
  if (!run || run.stopped) return Promise.resolve();
  if (run.inFlight) {
    run.again = true;
    return run.inFlight;
  }
  run.inFlight = (async () => {
    do {
      run.again = false;
      await runSync(run);
    } while (run.again && isCurrent(run));
  })().finally(() => {
    run.inFlight = null;
  });
  return run.inFlight;
}

/** Sends queued read receipts (batches); kept queued if offline. Concurrent calls share one run. */
let receiptsInFlight = null;
function sendReadReceipts() {
  receiptsInFlight ??= flushReadReceipts().finally(() => {
    receiptsInFlight = null;
  });
  return receiptsInFlight;
}

async function flushReadReceipts() {
  for (;;) {
    const ids = await messages.listPendingReadReceipts(LIMITS.MESSAGE_BATCH_MAX);
    if (ids.length === 0) return;
    await apiRequest('POST', ENDPOINTS.MESSAGES.READ, { body: { messageIds: ids } });
    await messages.clearPendingReadReceipts(ids);
    if (ids.length < LIMITS.MESSAGE_BATCH_MAX) return;
  }
}

/** Recovers receipts missed while offline by asking the server for our messages' state. */
async function refreshOutgoingStatuses() {
  const ids = await messages.listUnsettledOutgoing(LIMITS.MESSAGE_BATCH_MAX);
  if (ids.length === 0) return;
  const { statuses } = await apiRequest('POST', ENDPOINTS.MESSAGES.STATUS, {
    body: { messageIds: ids },
  });
  await messages.applyReceipts(
    statuses
      .filter((s) => s.status !== 'sent')
      .map((s) => ({ messageId: s.messageId, status: s.status, at: s.readAt ?? s.deliveredAt })),
  );
}

/** Tracks background work started by realtime events (see waitForIdle). */
function track(run, promise) {
  run.tasks.add(promise);
  promise.finally(() => run.tasks.delete(promise));
}

/** Downloads (encrypted) photos, videos and voice notes that arrived; never blocks a sync. */
function fetchAttachments(run) {
  if (!isCurrent(run)) return;
  track(
    run,
    downloadPendingAttachments()
      .then((done) => done > 0 && isCurrent(run) && bump())
      .catch(() => {}),
  );
}

function onEnvelope(run, payload) {
  if (!isCurrent(run)) return;
  track(
    run,
    handleRealtimeEnvelope(run.userId, payload)
      .then(() => fetchAttachments(run))
      .catch(() => requestSync()) // decrypted later by the regular sync
      .finally(() => isCurrent(run) && bump()),
  );
}

function onReceipt(run, payload) {
  if (!isCurrent(run) || !Array.isArray(payload?.receipts)) return;
  track(
    run,
    messages
      .applyReceipts(payload.receipts)
      .then((changed) => changed > 0 && isCurrent(run) && bump())
      .catch(() => {}),
  );
}

/** Resolves once startup, syncs and realtime-triggered work have all finished. */
export async function waitForIdle() {
  const run = engine;
  if (!run) return;
  while (run.tasks.size > 0 || run.inFlight || run.starting) {
    await Promise.allSettled([...run.tasks, run.inFlight, run.starting]);
  }
}

function startPolling(run) {
  const timer = setInterval(() => {
    const { realtime, online } = useMessagingStore.getState();
    if (online && realtime !== 'connected' && AppState.currentState === 'active') requestSync();
  }, POLL_INTERVAL_MS);
  run.cleanups.push(() => clearInterval(timer));
}

/**
 * "This device is online": sent while the app is on screen (or in a call) and the network is
 * up. The server forgets it after two missed beats, so a crash, a dead network or a closed app
 * reads as offline without any further action. Best effort; never blocks anything.
 */
function sendHeartbeat(run) {
  if (!isCurrent(run) || !useMessagingStore.getState().online) return Promise.resolve();
  // Off screen = background/inactive; an unknown state (just launched) counts as on screen.
  const appState = AppState.currentState;
  const offScreen = appState === 'background' || appState === 'inactive';
  if (offScreen && !isCallActive()) return Promise.resolve();
  const beat = apiRequest('POST', ENDPOINTS.PRESENCE.HEARTBEAT).catch(() => {});
  track(run, beat);
  return beat;
}

/** The app left the screen: tell the server now rather than waiting for the TTL. */
function clearPresence(run) {
  if (!isCurrent(run)) return;
  track(
    run,
    apiRequest('DELETE', ENDPOINTS.PRESENCE.ROOT).catch(() => {}),
  );
}

function startHeartbeat(run) {
  const timer = setInterval(() => sendHeartbeat(run), HEARTBEAT_INTERVAL_MS);
  run.cleanups.push(() => clearInterval(timer));
}

async function startRealtime(run) {
  if (run.realtimeActive) return;
  run.realtimeActive = true;
  useMessagingStore.setState({ realtime: 'connecting' });
  try {
    const disconnect = await connectRealtime({
      onEnvelope: (payload) => onEnvelope(run, payload),
      onReceipt: (payload) => onReceipt(run, payload),
      onCall: (payload) => isCurrent(run) && handleCallEvent(payload),
      onTyping: (payload) => isCurrent(run) && handleTypingEvent(payload),
      onPresence: (payload) => isCurrent(run) && handlePresenceEvent(payload),
      onSubscribed: () => {
        if (!isCurrent(run)) return;
        requestSync();
        // Call events published while we were not subscribed are recovered here too, and
        // calls missed while the app was closed are added to the call history.
        track(run, reconcileCall());
        track(run, syncMissedCalls());
        sendHeartbeat(run); // (re)connected: say so at once
      },
      onStateChange: (state) => isCurrent(run) && useMessagingStore.setState({ realtime: state }),
    });
    if (isCurrent(run) && run.realtimeActive) run.disconnectRealtime = disconnect;
    else disconnect();
  } catch (err) {
    run.realtimeActive = false;
    // Offline or API down: polling and the next foreground/reconnect sync cover delivery.
    if (__DEV__) console.warn('[realtime] connect failed:', err?.code ?? err?.message);
    if (isCurrent(run)) {
      useMessagingStore.setState({ realtime: 'failed' });
      run.retryRealtime = true;
    }
  }
}

/**
 * Drops the Pusher connection. Used in the background: the server then sees no ack and sends
 * a push notification instead (the user cannot see messages arriving in a backgrounded app),
 * and the device does not keep a socket open.
 */
function stopRealtime(run) {
  run.realtimeActive = false;
  const disconnect = run.disconnectRealtime;
  run.disconnectRealtime = null;
  disconnect?.();
}

/** Off screen for real: drop Pusher (push notifications take over) and appear offline. */
function pauseInBackground(run) {
  stopRealtime(run);
  useMessagingStore.setState({ realtime: 'paused' });
  clearPresence(run);
}

/**
 * Background: drop Pusher (push notifications take over), except during a call, whose
 * signaling (hang-up, reconnection) must keep arriving, and while one of our own system screens
 * (photo picker, permission dialog) is open: the user has not left the app (lib/systemUi.js).
 * Foreground: reconnect and sync.
 */
export function handleAppStateChange(state) {
  const run = engine;
  if (!run || !isCurrent(run)) return;
  clearTimeout(run.systemUiTimer);
  if (state === 'background') {
    // Decrypted media (open photos, videos, voice notes) never stays behind in the background.
    releaseAllPlaintext();
    if (isCallActive()) return; // dropped once the call ends (see startMessaging)
    const grace = systemUiGraceMs();
    if (grace > 0) {
      // Still away when the grace runs out (e.g. went home from the picker): pause then.
      run.systemUiTimer = setTimeout(() => {
        if (isCurrent(run) && AppState.currentState === 'background' && !isCallActive()) {
          pauseInBackground(run);
        }
      }, grace);
      return;
    }
    pauseInBackground(run);
  } else if (state === 'active') {
    run.retryRealtime = false;
    startRealtime(run); // no-op if still connected
    sendHeartbeat(run);
    requestSync();
    track(run, reconcileCall());
    track(run, syncMissedCalls());
    // Key maintenance (one-time pre-key top-up, signed/Kyber pre-key rotation) also runs for
    // apps that stay open for days, not only at launch. Best effort; retried next foreground.
    track(
      run,
      ensureKeysRegistered().catch(() => {}),
    );
  }
}

/**
 * Starts messaging for the signed-in user (after Signal keys are registered). Idempotent.
 * Delivery never depends on Pusher alone: the server is the source of truth and the engine
 * syncs on start, on (re)subscribe, on foreground, on network reconnect and by polling.
 */
export function startMessaging(userId) {
  if (engine?.userId === userId && !engine.stopped) return engine.ready;
  stopMessaging();

  const run = {
    userId,
    stopped: false,
    cleanups: [],
    tasks: new Set(),
    inFlight: null,
    again: false,
    starting: null,
    realtimeActive: false,
    disconnectRealtime: null,
    systemUiTimer: null,
  };
  engine = run;
  useMessagingStore.setState({ realtime: 'idle', syncing: false, lastSyncError: null });

  const appState = AppState.addEventListener('change', handleAppStateChange);
  run.cleanups.push(() => appState.remove());
  run.cleanups.push(() => stopRealtime(run));
  run.cleanups.push(() => clearTimeout(run.systemUiTimer));
  // A call that ends while the app is in the background: drop Pusher as usual now.
  run.cleanups.push(
    useCallStore.subscribe((state, previous) => {
      const callJustEnded = !isActivePhase(state.phase) && isActivePhase(previous.phase);
      if (callJustEnded && AppState.currentState === 'background' && isCurrent(run)) {
        pauseInBackground(run);
      }
    }),
  );

  const unsubscribeNet = NetInfo.addEventListener((net) => {
    if (!isCurrent(run)) return;
    const change = applyNetworkState(net);
    // An interface is necessary, not sufficient: lib/connectivity.js adds backend reachability.
    const online = net.isConnected !== false && net.isInternetReachable !== false;
    useMessagingStore.setState({ online });
    if (!change.cameOnline && !change.switched) return;
    // Back online, or Wi-Fi ⇄ mobile data: sockets on the old path may hang, so reconnect
    // realtime now, catch up over HTTPS, and let a call in progress restart ICE.
    if (run.retryRealtime) {
      run.retryRealtime = false;
      startRealtime(run);
    } else if (change.switched) {
      run.disconnectRealtime?.reconnect?.();
    }
    requestSync();
    track(run, reconcileCall());
    sendHeartbeat(run);
    handleCallNetworkChange();
  });
  run.cleanups.push(unsubscribeNet);
  // The backend answered again after requests had been failing (whatever the interface said):
  // catch up now, so a sync that failed during the outage is not left waiting for a poll.
  run.cleanups.push(
    useConnectivityStore.subscribe((state, previous) => {
      const recovered =
        state.reachableAt > previous.reachableAt && previous.unreachableAt > previous.reachableAt;
      if (!recovered || !isCurrent(run)) return;
      requestSync();
      sendHeartbeat(run);
      if (run.retryRealtime) {
        run.retryRealtime = false;
        startRealtime(run);
      }
    }),
  );

  startPolling(run);
  startHeartbeat(run);
  // Plaintext media left by a crash or kill, partial downloads and orphaned blobs go now.
  track(
    run,
    cleanUpMediaFiles().catch(() => {}),
  );
  // A call this phone was in when the app was last killed goes into the history now.
  track(
    run,
    recoverInterruptedCall().catch(() => {}),
  );
  run.starting = Promise.all([startRealtime(run), requestSync()]).finally(() => {
    run.starting = null;
  });
  run.ready = run.starting.then(() => {});
  return run.ready;
}

/** Disconnects realtime and stops all timers/listeners. Called before local data is wiped. */
export function stopMessaging() {
  const run = engine;
  engine = null;
  if (!run) return;
  run.stopped = true;
  for (const cleanup of run.cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // Best effort: a failing cleanup must not block logout.
    }
  }
  useMessagingStore.setState({ realtime: 'idle', syncing: false });
}

// --- Actions used by the screens ---

export async function createConversation(peerUserId, title) {
  await messages.ensureConversation(peerUserId, { title: title?.trim() || null });
  bump();
}

/** Stores, encrypts and sends. Failures leave a retryable `failed` message, never an exception. */
export async function sendMessage(userId, peerUserId, text) {
  const clientMessageId = await enqueueText(peerUserId, text);
  bump(); // show the `sending` bubble right away
  try {
    await deliverOutgoing(userId, clientMessageId);
  } catch {
    // Shown as failed in the chat; temporary failures are retried by the next sync.
  } finally {
    bump();
  }
}

/**
 * Encrypts and sends a photo, video or voice note (`media`: { uri, contentType, width?, height?,
 * durationMs?, voiceNote? }) with an optional caption. Throws a MediaError if the file cannot be
 * sent at all (too large, unsupported, unreadable); after that, failures leave a retryable
 * `failed` message like text.
 */
export async function sendAttachment(userId, peerUserId, media, caption = '') {
  const prepared = await prepareAttachment(media);
  const clientMessageId = await enqueueAttachment(peerUserId, prepared, caption);
  bump();
  try {
    await deliverOutgoing(userId, clientMessageId);
  } catch {
    // Shown as failed in the chat; temporary failures are retried by the next sync.
  } finally {
    bump();
  }
}

export async function retryFailedMessage(userId, clientMessageId) {
  try {
    await retryMessage(userId, clientMessageId);
  } catch {
    // Still failed; state is shown in the chat.
  } finally {
    bump();
  }
}

/**
 * The user accepted a contact's new security code (`identityKey` = the key whose code was
 * shown). Held messages are then decrypted and held outgoing messages sent.
 * @returns {Promise<boolean>} false if there was nothing (or something else) to accept
 */
export async function acceptSecurityCode(userId, peerUserId, identityKey) {
  try {
    return await acceptIdentityChange(userId, peerUserId, identityKey);
  } finally {
    bump();
  }
}

/** Marks the open conversation as read locally and sends read receipts (queued if offline). */
export async function markConversationRead(peerUserId) {
  const changed = await messages.markIncomingRead(peerUserId);
  if (changed > 0) bump();
  await sendReadReceipts().catch(() => {});
}
