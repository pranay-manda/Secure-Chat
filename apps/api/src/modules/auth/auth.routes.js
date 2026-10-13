import { Router } from 'express';
import { OTP_CHANNEL } from '@secure-chat/shared/constants';
import {
  deviceIdSchema,
  devicePlatformSchema,
  emailSchema,
  otpSchema,
} from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';
import { phoneNumberSchema } from './phone.js';
import { REFRESH_SECRET_PATTERN } from './tokenService.js';

// No control characters in free-text device metadata.
const label = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, 'Contains invalid characters');

export const deviceDetailsSchema = z.object({
  platform: devicePlatformSchema,
  name: label(64).optional(),
  appVersion: label(32).optional(),
  osVersion: label(32).optional(),
});

/** Sign-in identifier: exactly one of `email` or `phoneNumber`. */
const identifierFields = z.object({
  email: emailSchema.optional(),
  phoneNumber: phoneNumberSchema.optional(),
});

function requireOneIdentifier(body, ctx) {
  if ((body.email === undefined) === (body.phoneNumber === undefined)) {
    ctx.addIssue({ code: 'custom', path: [], message: 'Provide either email or phoneNumber' });
  }
}

const otpRequestBody = identifierFields.superRefine(requireOneIdentifier);

/**
 * Sign in by email: `email` + `otp` (+ `phoneNumber`, required for a new account; saved
 * unverified). Sign in by phone: `phoneNumber` + `otp` (an SMS code).
 */
const otpVerifyBody = identifierFields
  .extend({
    otp: otpSchema,
    device: deviceDetailsSchema.extend({ deviceId: deviceIdSchema }),
  })
  .superRefine((body, ctx) => {
    if (body.email === undefined && body.phoneNumber === undefined) {
      ctx.addIssue({ code: 'custom', path: [], message: 'Provide email or phoneNumber' });
    }
  });

function toIdentity({ email, phoneNumber }) {
  return email !== undefined
    ? { channel: OTP_CHANNEL.EMAIL, value: email }
    : { channel: OTP_CHANNEL.PHONE, value: phoneNumber };
}

const refreshBody = z.object({
  refreshToken: z.string().min(1).max(256),
  deviceId: deviceIdSchema,
  // The secret of the next refresh token, chosen (32 random bytes) and saved by the app before
  // it sends this request, so a retry after a lost response can prove it made the rotation.
  nextRefreshSecret: z.string().regex(REFRESH_SECRET_PATTERN).optional(),
});

export function createAuthRouter({ authService, otpService, rateLimiters, authenticate }) {
  const router = Router();

  router.post(
    '/otp/request',
    rateLimiters.byIp('otpRequestPerIp'),
    validate({ body: otpRequestBody }),
    async (req, res) => {
      const identity = toIdentity(req.valid.body);
      await rateLimiters.consume('otpRequestPerIdentifier', otpService.identityKey(identity));
      // Same response for new and existing accounts: no account enumeration.
      res.status(202).json(await otpService.requestOtp(identity));
    },
  );

  router.post(
    '/otp/verify',
    rateLimiters.byIp('otpVerifyPerIp'),
    validate({ body: otpVerifyBody }),
    async (req, res) => {
      const { otp, device, email, phoneNumber } = req.valid.body;
      const identity = toIdentity(req.valid.body);
      await rateLimiters.consume('otpVerifyPerIdentifier', otpService.identityKey(identity));
      // With email sign-in, the phone number is account data (not proven by this code).
      const profilePhone = email !== undefined ? phoneNumber : undefined;
      res.status(200).json(await authService.loginWithOtp({ identity, otp, device, profilePhone }));
    },
  );

  router.post(
    '/refresh',
    rateLimiters.byIp('refreshPerIp'),
    validate({ body: refreshBody }),
    async (req, res) => {
      res.status(200).json(await authService.refresh(req.valid.body));
    },
  );

  router.post('/logout', authenticate, async (req, res) => {
    await authService.logout(req.auth);
    res.status(204).end();
  });

  return router;
}
