import { Router } from 'express';
import { emailSchema, otpSchema } from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';
import { phoneNumberSchema } from '../auth/phone.js';

const phoneBody = z.strictObject({ phoneNumber: phoneNumberSchema });
const emailCodeBody = z.strictObject({ email: emailSchema });
const emailBody = z.strictObject({ email: emailSchema, otp: otpSchema });

/**
 * The caller's own account. Authentication (a live session on an active device) is required;
 * the account to act on always comes from that session, never from the request.
 */
export function createAccountRouter({ accountService, otpService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.get('/', async (req, res) => {
    res.status(200).json({ user: await accountService.getAccount(req.auth) });
  });

  // Email and phone number are both required; older accounts add the missing one once.
  router.post(
    '/phone',
    rateLimiters.byUser('accountDetailsPerUser'),
    validate({ body: phoneBody }),
    async (req, res) => {
      res
        .status(200)
        .json({ user: await accountService.addPhone(req.auth, req.valid.body.phoneNumber) });
    },
  );

  router.post(
    '/email/otp',
    rateLimiters.byUser('accountDetailsPerUser'),
    validate({ body: emailCodeBody }),
    async (req, res) => {
      const identity = accountService.linkIdentity(req.valid.body.email);
      await rateLimiters.consume('otpRequestPerIdentifier', otpService.identityKey(identity));
      res.status(202).json(await accountService.requestEmailCode(req.auth, req.valid.body.email));
    },
  );

  router.post(
    '/email',
    rateLimiters.byUser('accountDetailsPerUser'),
    validate({ body: emailBody }),
    async (req, res) => {
      const { email, otp } = req.valid.body;
      const identity = accountService.linkIdentity(email);
      await rateLimiters.consume('otpVerifyPerIdentifier', otpService.identityKey(identity));
      res.status(200).json({ user: await accountService.addEmail(req.auth, email, otp) });
    },
  );

  // Permanently deletes the account and signs it out everywhere.
  router.delete('/', async (req, res) => {
    await accountService.deleteAccount(req.auth);
    res.status(204).end();
  });

  return router;
}
