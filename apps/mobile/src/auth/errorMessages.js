import { ERROR_CODE } from '@secure-chat/shared/constants';

import { NetworkError } from '../lib/api';

/** Maps API errors to short, user-facing messages. Never shows raw server text. */
export function authErrorMessage(err) {
  if (err instanceof NetworkError) return 'No connection. Check your internet and try again.';

  switch (err?.code) {
    case ERROR_CODE.VALIDATION_ERROR:
      return 'Please check what you entered and try again.';
    case ERROR_CODE.OTP_CHANNEL_UNAVAILABLE:
      return 'Phone sign-in isn’t available yet. Please use your email address.';
    case ERROR_CODE.OTP_COOLDOWN:
      return `Please wait ${err.retryAfterSeconds ?? 60}s before requesting another code.`;
    case ERROR_CODE.RATE_LIMITED:
      return 'Too many attempts. Please try again later.';
    case ERROR_CODE.OTP_INVALID: {
      const left = err.details?.attemptsRemaining;
      return left
        ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'This code is incorrect or has expired. Request a new one.';
    }
    case ERROR_CODE.OTP_ATTEMPTS_EXCEEDED:
      return 'Too many incorrect attempts. Request a new code.';
    case ERROR_CODE.OTP_DELIVERY_FAILED:
      return "We couldn't send the code. Please try again.";
    case ERROR_CODE.DEVICE_REVOKED:
      return 'This device was signed out. Request a new code to sign in again.';
    case ERROR_CODE.SERVICE_UNAVAILABLE:
      return 'Service is temporarily unavailable. Please try again shortly.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
