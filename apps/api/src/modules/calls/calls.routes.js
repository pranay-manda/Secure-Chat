import { Router } from 'express';
import { CALL_KIND, CALL_KINDS, CALL_LIMITS } from '@secure-chat/shared/constants';
import {
  base64Bytes,
  ciphertextTypeSchema,
  objectIdSchema,
  registrationIdSchema,
} from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';
import { END_REASONS } from './callService.js';

const callParams = z.object({ callId: z.uuid() });
const startBody = z.strictObject({
  calleeUserId: objectIdSchema,
  kind: z.enum(CALL_KINDS).default(CALL_KIND.VOICE),
});
const endBody = z.strictObject({ reason: z.enum(END_REASONS).default('hangup') });
const missedAckBody = z.strictObject({
  callIds: z.array(z.uuid()).min(1).max(CALL_LIMITS.MISSED_MAX),
});

// SDP is relayed through Pusher (10 KB per event): bounded, and it must look like SDP.
const sdp = z
  .string()
  .min(10)
  .max(CALL_LIMITS.SDP_MAX_CHARS)
  .refine((value) => value.startsWith('v=0'), 'must be an SDP description');
const candidate = z.strictObject({
  candidate: z.string().min(1).max(CALL_LIMITS.CANDIDATE_MAX_CHARS),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
});
// Which ICE restart an offer is (1, 2, ...); the answer echoes it, so a caller that re-sent its
// restart offer can ignore a late answer to an older one. Absent on the first offer/answer.
const restart = z.number().int().min(1).max(CALL_LIMITS.ICE_RESTARTS_MAX).optional();
const signalBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('offer'), sdp, restart }),
  z.strictObject({ kind: z.literal('answer'), sdp, restart }),
  z.strictObject({
    kind: z.literal('candidates'),
    candidates: z.array(candidate).min(1).max(CALL_LIMITS.CANDIDATES_PER_REQUEST),
  }),
  // Camera on/off of the sender (video calls). A flag only: never any media.
  z.strictObject({ kind: z.literal('media'), video: z.boolean() }),
  // The sender's call-security attestation (its DTLS fingerprints, for the other phone to check
  // the connection against): Signal ciphertext only, opaque here. As for messages, the
  // recipient's registration id lets the server refuse ciphertext for keys it no longer has.
  z.strictObject({
    kind: z.literal('attest'),
    attestation: z.strictObject({
      type: ciphertextTypeSchema,
      body: base64Bytes({ min: 1, max: CALL_LIMITS.ATTESTATION_MAX_BYTES }),
    }),
    recipientRegistrationId: registrationIdSchema.optional(),
  }),
]);

/**
 * Voice-call signaling API. Phones never talk to each other through Pusher directly: every
 * action is an authenticated request the server authorizes, then relays to the other
 * participant's device channel. Audio never comes here.
 *
 *   POST /calls                      start a voice or video call (returns ICE servers for the caller)
 *   GET  /calls/current              this device's ongoing call (recovery; no polling)
 *   POST /calls/:callId/accept       callee answers (returns ICE servers for the callee)
 *   POST /calls/:callId/reject       callee declines
 *   POST /calls/:callId/signal       SDP offer/answer, ICE candidates, camera flag or the
 *                                    sender's Signal-encrypted attestation, for the other side
 *   POST /calls/:callId/end          hang up / cancel / report failure (idempotent)
 *   GET  /calls/missed               unanswered calls not yet in this phone's call history
 *   POST /calls/missed/ack           the phone saved them: forget those notes (idempotent)
 */
export function createCallsRouter({ callService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.post(
    '/',
    rateLimiters.byUser('callStartPerUser'),
    validate({ body: startBody }),
    async (req, res) => {
      res.status(201).json(await callService.createCall(req.auth, req.valid.body));
    },
  );

  router.get('/current', async (req, res) => {
    res.status(200).json({ call: await callService.currentCall(req.auth) });
  });

  router.get('/missed', async (req, res) => {
    res.status(200).json({ missed: await callService.listMissedCalls(req.auth) });
  });

  router.post('/missed/ack', validate({ body: missedAckBody }), async (req, res) => {
    await callService.ackMissedCalls(req.auth, req.valid.body.callIds);
    res.status(204).end();
  });

  router.post('/:callId/accept', validate({ params: callParams }), async (req, res) => {
    res.status(200).json(await callService.acceptCall(req.auth, req.valid.params.callId));
  });

  router.post('/:callId/reject', validate({ params: callParams }), async (req, res) => {
    await callService.rejectCall(req.auth, req.valid.params.callId);
    res.status(204).end();
  });

  router.post(
    '/:callId/signal',
    validate({ params: callParams, body: signalBody }),
    async (req, res) => {
      await callService.relaySignal(req.auth, req.valid.params.callId, req.valid.body);
      res.status(204).end();
    },
  );

  router.post('/:callId/end', validate({ params: callParams, body: endBody }), async (req, res) => {
    await callService.endCall(req.auth, req.valid.params.callId, req.valid.body.reason);
    res.status(204).end();
  });

  return router;
}
