import { Router } from 'express';
import { SIGNAL } from '@secure-chat/shared/constants';
import {
  ecPublicKeySchema,
  kyberPreKeySchema,
  objectIdSchema,
  oneTimePreKeySchema,
  registrationIdSchema,
  signedPreKeySchema,
} from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';

const oneTimePreKeys = z
  .array(oneTimePreKeySchema)
  .max(SIGNAL.ONE_TIME_PREKEY_BATCH)
  .refine((keys) => new Set(keys.map((k) => k.keyId)).size === keys.length, 'Duplicate keyId');

// Strict objects: any unexpected field (e.g. a private key sent by a buggy client) is rejected,
// never silently stored.
const registerBody = z.strictObject({
  registrationId: registrationIdSchema,
  identityKey: ecPublicKeySchema,
  signedPreKey: signedPreKeySchema.strict(),
  kyberPreKey: kyberPreKeySchema.strict(),
  oneTimePreKeys: oneTimePreKeys.optional(),
});

const oneTimeBody = z.strictObject({ preKeys: oneTimePreKeys.min(1) });

export function createKeysRouter({ keyService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.put('/', validate({ body: registerBody }), async (req, res) => {
    res.status(200).json({ status: await keyService.registerKeys(req.auth, req.valid.body) });
  });

  router.post('/one-time', validate({ body: oneTimeBody }), async (req, res) => {
    res
      .status(200)
      .json({ status: await keyService.addOneTimePreKeys(req.auth, req.valid.body.preKeys) });
  });

  router.get('/status', async (req, res) => {
    res.status(200).json({ status: await keyService.getStatus(req.auth) });
  });

  router.get(
    '/bundle/:userId',
    rateLimiters.byUser('bundleFetchPerUser'),
    validate({ params: z.object({ userId: objectIdSchema }) }),
    async (req, res) => {
      res
        .status(200)
        .json({ bundle: await keyService.getBundle(req.auth, req.valid.params.userId) });
    },
  );

  return router;
}
