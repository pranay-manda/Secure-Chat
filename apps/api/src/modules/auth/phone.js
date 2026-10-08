import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';

/**
 * Accepts international format (+<country code><number>) and normalises to E.164.
 * Uses the full ("max") metadata so validation matches real numbering plans.
 */
export const phoneNumberSchema = z
  .string()
  .trim()
  .max(32)
  .transform((value, ctx) => {
    const parsed = parsePhoneNumberFromString(value);
    if (!parsed || !parsed.isValid()) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be a valid phone number in international format, e.g. +919876543210',
      });
      return z.NEVER;
    }
    return parsed.number;
  });
