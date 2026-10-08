import { Router } from 'express';
import { LIMITS } from '@secure-chat/shared/constants';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';

// Plain strings only (no names, no objects); normalized server-side with the sign-in rules.
const matchBody = z.strictObject({
  phoneNumbers: z
    .array(z.string().trim().min(1).max(32))
    .min(1)
    .max(LIMITS.CONTACT_MATCH_BATCH_MAX),
});

/** Contact discovery. Authenticated, batch-limited and rate-limited per number checked. */
export function createContactsRouter({ contactService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.post('/match', validate({ body: matchBody }), async (req, res) => {
    const { phoneNumbers } = req.valid.body;
    await rateLimiters.consume('contactMatchNumbersPerUser', req.auth.userId, phoneNumbers.length);
    res.status(200).json({ matches: await contactService.match(req.auth, phoneNumbers) });
  });

  return router;
}
