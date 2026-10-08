import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/** Numbers typed without a +country code are read as Indian numbers. */
export const DEFAULT_COUNTRY = 'IN';

/**
 * Returns the E.164 form (e.g. +919876543210) or null if the number is not valid.
 * The server re-validates with full metadata; this is for instant feedback.
 */
export function toE164(input) {
  const parsed = parsePhoneNumberFromString(String(input ?? '').trim(), DEFAULT_COUNTRY);
  return parsed?.isValid() ? parsed.number : null;
}

export function formatPhone(e164) {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}
