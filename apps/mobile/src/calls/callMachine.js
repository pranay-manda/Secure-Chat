/**
 * Explicit state machine of a 1:1 call (voice or video) on this phone. The phases are the same
 * for both kinds: what differs is which tracks the call carries. Pure: no I/O, so every transition
 * rule is unit-tested. The call engine only ever changes phase through `nextPhase`, so an event
 * that does not fit the current phase (a duplicate, late or replayed event) is ignored instead
 * of corrupting the call.
 *
 *   idle ──DIAL──▶ outgoing ──REMOTE_ACCEPTED──▶ connecting ──CONNECTED──▶ connected
 *   idle ──RING──▶ incoming ──ANSWER──▶ answering ──MEDIA_READY──▶ connecting
 *   connected ──DISCONNECTED──▶ reconnecting ──CONNECTED──▶ connected
 *   any active phase ──END──▶ ended ──RESET──▶ idle
 */
export const CALL_PHASE = Object.freeze({
  IDLE: 'idle',
  /** We are calling; the other phone rings. */
  OUTGOING: 'outgoing',
  /** Our phone rings. */
  INCOMING: 'incoming',
  /** We answered; microphone and connection are being prepared. */
  ANSWERING: 'answering',
  /** Both sides agreed; WebRTC is negotiating (SDP + ICE). */
  CONNECTING: 'connecting',
  /** Audio flows. */
  CONNECTED: 'connected',
  /** The network path broke; WebRTC tries to recover (ICE restart). */
  RECONNECTING: 'reconnecting',
  /** Over; the reason is shown briefly, then back to idle. */
  ENDED: 'ended',
});

export const CALL_INPUT = Object.freeze({
  DIAL: 'DIAL',
  RING: 'RING',
  ANSWER: 'ANSWER',
  REMOTE_ACCEPTED: 'REMOTE_ACCEPTED',
  MEDIA_READY: 'MEDIA_READY',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  END: 'END',
  RESET: 'RESET',
});

const P = CALL_PHASE;
const I = CALL_INPUT;
const TRANSITIONS = Object.freeze({
  [P.IDLE]: { [I.DIAL]: P.OUTGOING, [I.RING]: P.INCOMING },
  [P.OUTGOING]: { [I.REMOTE_ACCEPTED]: P.CONNECTING, [I.END]: P.ENDED },
  [P.INCOMING]: { [I.ANSWER]: P.ANSWERING, [I.END]: P.ENDED },
  [P.ANSWERING]: { [I.MEDIA_READY]: P.CONNECTING, [I.END]: P.ENDED },
  [P.CONNECTING]: { [I.CONNECTED]: P.CONNECTED, [I.END]: P.ENDED },
  [P.CONNECTED]: { [I.DISCONNECTED]: P.RECONNECTING, [I.END]: P.ENDED },
  [P.RECONNECTING]: { [I.CONNECTED]: P.CONNECTED, [I.END]: P.ENDED },
  [P.ENDED]: { [I.RESET]: P.IDLE },
});

/** The phase after `input`, or null if `input` is not valid in `phase`. */
export function nextPhase(phase, input) {
  return TRANSITIONS[phase]?.[input] ?? null;
}

/** A call exists and is not over. */
export const isActivePhase = (phase) => phase !== P.IDLE && phase !== P.ENDED;

/** Why a call ended, from this phone's point of view (drives the text shown). */
export const END_REASON = Object.freeze({
  HANGUP: 'hangup', // we hung up or cancelled
  REMOTE_HANGUP: 'remote_hangup', // they hung up
  DECLINED: 'declined', // we declined an incoming call
  REJECTED: 'rejected', // they declined our call
  MISSED: 'missed', // nobody answered (either side's view)
  BUSY: 'busy', // they are on another call
  ALREADY_IN_CALL: 'already_in_call', // we are (server-side) on another call
  UNAVAILABLE: 'unavailable', // they cannot be called (no active device)
  CONNECTION_LOST: 'connection_lost', // network broke and did not recover
  FAILED: 'failed', // negotiation or setup failed
  PERMISSION_DENIED: 'permission_denied', // no microphone permission
  CAMERA_DENIED: 'camera_denied', // video call, but no camera permission
  MEDIA_UNAVAILABLE: 'media_unavailable', // the camera/microphone did not start on this phone
  SIGNED_OUT: 'signed_out', // this phone signed out
  IDENTITY_CHANGED: 'identity_changed', // their security code changed: review it first
  SECURITY_UNVERIFIED: 'security_unverified', // the call's encryption keys could not be verified
});

const TEXT = {
  [END_REASON.HANGUP]: 'Call ended',
  [END_REASON.REMOTE_HANGUP]: 'Call ended',
  [END_REASON.DECLINED]: 'Call declined',
  [END_REASON.REJECTED]: 'Call declined',
  [END_REASON.MISSED]: 'No answer',
  [END_REASON.BUSY]: 'On another call',
  [END_REASON.ALREADY_IN_CALL]: 'You are already in a call',
  [END_REASON.UNAVAILABLE]: 'Can’t be called right now',
  [END_REASON.CONNECTION_LOST]: 'Connection lost',
  [END_REASON.FAILED]: 'Call failed',
  [END_REASON.PERMISSION_DENIED]: 'Microphone permission is needed for calls',
  [END_REASON.CAMERA_DENIED]: 'Camera permission is needed for video calls',
  [END_REASON.MEDIA_UNAVAILABLE]:
    'Camera or microphone not responding. Close and reopen CipherChat',
  [END_REASON.SIGNED_OUT]: 'Call ended',
  [END_REASON.IDENTITY_CHANGED]: 'Security code changed',
  [END_REASON.SECURITY_UNVERIFIED]: 'Couldn’t verify this call',
};

/** What the ended screen says; a call that was never answered reads differently per side. */
export const endReasonText = (reason, direction) =>
  reason === END_REASON.MISSED && direction === 'incoming'
    ? 'Missed call'
    : (TEXT[reason] ?? 'Call ended');
