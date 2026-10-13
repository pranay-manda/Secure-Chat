import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import mongoose from 'mongoose';

import { directConversationId, Message } from '../../models/Message.js';
import { User } from '../../models/User.js';

/** Same E.164 normalization as sign-in (modules/auth/phone.js); invalid numbers are dropped. */
function toE164(value) {
  const parsed = parsePhoneNumberFromString(String(value).trim());
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Contact discovery: which of these phone numbers belong to CipherChat accounts?
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

  /**
   * Phone numbers of the given people, but only of those who have sent the caller a message
   * (like WhatsApp showing the number of someone who wrote to you). Starting a chat with a user
   * id does not reveal that person's number: the condition is a message FROM them TO the
   * caller, which only they can create. Anyone else is left out, so the answer says nothing
   * about strangers. Message metadata expires after 90 days, and with it this permission.
   *
   * @returns {Promise<Array<{ userId: string, phoneNumber: string }>>}
   */
  async function peerNumbers(auth, userIds) {
    const ids = [...new Set(userIds.map(String))].filter((id) => id !== auth.userId);
    if (ids.length === 0) return [];

    // `$in` is ours, not from the request (Mongoose runs with sanitizeFilter).
    const senders = await Message.distinct('senderUserId', {
      conversationId: mongoose.trusted({
        $in: ids.map((id) => directConversationId(auth.userId, id)),
      }),
      recipientUserId: auth.userId,
    });
    if (senders.length === 0) return [];

    const users = await User.find({
      _id: mongoose.trusted({ $in: senders }),
      phoneNumber: mongoose.trusted({ $ne: null }),
    })
      .select('phoneNumber')
      .lean();
    return users.map((user) => ({ userId: String(user._id), phoneNumber: user.phoneNumber }));
  }

  return { match, peerNumbers };
}
