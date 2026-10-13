import {
  CALL_INPUT,
  CALL_PHASE,
  END_REASON,
  endReasonText,
  isActivePhase,
  nextPhase,
} from '../src/calls/callMachine';

/** The call state machine: every valid path, and every invalid transition rejected. */
const P = CALL_PHASE;
const I = CALL_INPUT;

const run = (inputs, from = P.IDLE) =>
  inputs.reduce((phase, input) => {
    const next = nextPhase(phase, input);
    if (!next) throw new Error(`${input} not allowed in ${phase}`);
    return next;
  }, from);

describe('call state machine', () => {
  it('outgoing: idle → outgoing → connecting → connected → ended → idle', () => {
    expect(run([I.DIAL])).toBe(P.OUTGOING);
    expect(run([I.DIAL, I.REMOTE_ACCEPTED])).toBe(P.CONNECTING);
    expect(run([I.DIAL, I.REMOTE_ACCEPTED, I.CONNECTED])).toBe(P.CONNECTED);
    expect(run([I.DIAL, I.REMOTE_ACCEPTED, I.CONNECTED, I.END, I.RESET])).toBe(P.IDLE);
  });

  it('incoming: idle → incoming → answering → connecting → connected', () => {
    expect(run([I.RING, I.ANSWER, I.MEDIA_READY, I.CONNECTED])).toBe(P.CONNECTED);
  });

  it('a dropped connection can recover, or end', () => {
    const connected = run([I.DIAL, I.REMOTE_ACCEPTED, I.CONNECTED]);
    expect(run([I.DISCONNECTED], connected)).toBe(P.RECONNECTING);
    expect(run([I.DISCONNECTED, I.CONNECTED], connected)).toBe(P.CONNECTED);
    expect(run([I.DISCONNECTED, I.END], connected)).toBe(P.ENDED);
  });

  it('every active phase can end; idle and ended cannot end again', () => {
    for (const phase of [
      P.OUTGOING,
      P.INCOMING,
      P.ANSWERING,
      P.CONNECTING,
      P.CONNECTED,
      P.RECONNECTING,
    ]) {
      expect(nextPhase(phase, I.END)).toBe(P.ENDED);
      expect(isActivePhase(phase)).toBe(true);
    }
    expect(nextPhase(P.IDLE, I.END)).toBeNull();
    expect(nextPhase(P.ENDED, I.END)).toBeNull(); // ending twice changes nothing
    expect(isActivePhase(P.IDLE)).toBe(false);
    expect(isActivePhase(P.ENDED)).toBe(false);
  });

  it('rejects transitions that do not fit (late, duplicate or replayed events)', () => {
    const invalid = [
      [P.IDLE, I.ANSWER], // answering a call that does not exist
      [P.IDLE, I.REMOTE_ACCEPTED],
      [P.IDLE, I.CONNECTED],
      [P.OUTGOING, I.ANSWER], // the caller cannot answer its own call
      [P.OUTGOING, I.RING], // a second call while calling
      [P.INCOMING, I.REMOTE_ACCEPTED],
      [P.INCOMING, I.DIAL],
      [P.CONNECTING, I.REMOTE_ACCEPTED], // duplicate "accepted"
      [P.CONNECTED, I.REMOTE_ACCEPTED],
      [P.CONNECTED, I.RING],
      [P.CONNECTED, I.ANSWER],
      [P.ENDED, I.CONNECTED], // a late "connected" after hang-up
      [P.ENDED, I.REMOTE_ACCEPTED],
      [P.ENDED, I.DIAL], // must reset first
    ];
    for (const [phase, input] of invalid) {
      expect([phase, input, nextPhase(phase, input)]).toEqual([phase, input, null]);
    }
    expect(nextPhase('nonsense', I.END)).toBeNull();
  });

  it('has a human message for every end reason', () => {
    for (const reason of Object.values(END_REASON)) {
      expect(endReasonText(reason)).toEqual(expect.any(String));
    }
    expect(endReasonText(END_REASON.PERMISSION_DENIED)).toMatch(/microphone/i);
    expect(endReasonText(END_REASON.BUSY)).toMatch(/another call/i);
    expect(endReasonText(END_REASON.CAMERA_DENIED)).toMatch(/camera.*video calls/i);
    expect(endReasonText('unknown')).toBe('Call ended');
    // An unanswered call: the caller got no answer, the callee missed it.
    expect(endReasonText(END_REASON.MISSED, 'outgoing')).toBe('No answer');
    expect(endReasonText(END_REASON.MISSED, 'incoming')).toBe('Missed call');
  });
});
