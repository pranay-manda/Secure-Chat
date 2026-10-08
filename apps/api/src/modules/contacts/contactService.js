import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import mongoose from 'mongoose';

import { User } from '../../models/User.js';

/** Same E.164 normalization as sign-in (modules/auth/phone.js); invalid numbers are dropped. */
function toE164(value) {
  const parsed = parsePhoneNumberFromString(String(value).trim());
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Contact discovery: which of these phone numbers belong to Secure Chat accounts?
 *
 * Privacy: the numbers are used for one query and then dropped. Nothing about the request is
 * stored (no address book, no "who looked up whom"), and nothing is logged. Only accounts
 * with a phone number can match, so email-only users are never discoverable by phone.
 */
export function createContactService() {
  async function match(auth, phoneNumbers) {
    const normalized = [...new Set(phoneNumbers.map(toE164).filter(Boolean))];
    if (normalized.length === 0) return [];

    const users = await User.find({
      phoneNumber: mongoose.trusted({ $in: normalized }),
      _id: mongoose.trusted({ $ne: auth.userId }), // never "discover" yourself
    })
      .select('phoneNumber displayName')
      .lean();

    // Only what the New Chat screen needs: no email, photo, timestamps or keys.
    return users.map((user) => ({
      userId: String(user._id),
      phoneNumber: user.phoneNumber,
      displayName: user.displayName ?? '',
    }));
  }

  return { match };
}
