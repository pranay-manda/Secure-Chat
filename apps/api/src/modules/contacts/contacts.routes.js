import { Router } from 'express';
import { LIMITS } from '@secure-chat/shared/constants';
import { objectIdSchema } from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';

// Plain strings only (no names, no objects); normalized server-side with the sign-in rules.
const matchBody = z.strictObject({
  phoneNumbers: z
    .array(z.string().trim().min(1).max(32))
    .min(1)
    .max(LIMITS.CONTACT_MATCH_BATCH_MAX),
});

const peersQuery = z.strictObject({
  userIds: z
    .string()
    .min(1)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(objectIdSchema).min(1).max(LIMITS.CONTACT_PEERS_MAX)),
});

/**
 *   POST /contacts/match            contact discovery (batch-limited, rate-limited per number)
 *   GET  /contacts/peers?userIds=   phone numbers of people who have messaged the caller
 */
export function createContactsRouter({ contactService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.post('/match', validate({ body: matchBody }), async (req, res) => {
    const { phoneNumbers } = req.valid.body;
    await rateLimiters.consume('contactMatchNumbersPerUser', req.auth.userId, phoneNumbers.length);
    res.status(200).json({ matches: await contactService.match(req.auth, phoneNumbers) });
  });

  router.get('/peers', validate({ query: peersQuery }), async (req, res) => {
    res
      .status(200)
      .json({ peers: await contactService.peerNumbers(req.auth, req.valid.query.userIds) });
  });

  return router;
}
