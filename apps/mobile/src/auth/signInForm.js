import { emailSchema } from '@secure-chat/shared/validation';

import { toE164 } from '../lib/phone';

const PHONE_HINT = 'Enter a valid mobile number, e.g. +91 98765 43210';

/**
 * Email sign-in (the default): email AND phone number are both required. The code goes to the
 * email; the phone number is saved with the account so friends who have it in their contacts
 * can find you. Phone sign-in (code by SMS) stays available as an alternative.
 *
 * @returns {{ request?: object, verify?: object, error?: string }}
 */
export function readSignInForm({ mode, emailInput, phoneInput }) {
  const phoneNumber = phoneInput.trim() ? toE164(phoneInput) : null;
  if (mode === 'phone') {
    if (!phoneInput.trim()) return { error: 'Enter your phone number' };
    if (!phoneNumber) return { error: PHONE_HINT };
    return { request: { phoneNumber }, verify: { phoneNumber } };
  }
  if (!emailInput.trim()) return { error: 'Enter your email address' };
  const email = emailSchema.safeParse(emailInput);
  if (!email.success) return { error: 'Enter a valid email address, e.g. you@example.com' };
  if (!phoneInput.trim()) return { error: 'Enter your phone number' };
  if (!phoneNumber) return { error: PHONE_HINT };
  return { request: { email: email.data }, verify: { email: email.data, phoneNumber } };
}
