import mongoose from 'mongoose';

import { Counter } from '../../models/Counter.js';
import { Device } from '../../models/Device.js';
import { Message } from '../../models/Message.js';
import { MessageEnvelope } from '../../models/MessageEnvelope.js';
import { OneTimePreKey } from '../../models/OneTimePreKey.js';
import { Session } from '../../models/Session.js';
import { User } from '../../models/User.js';

/**
 * Account deletion (the signed-in user deletes their own account; there is no way to name
 * another account). Everything is removed in ONE transaction, so a failure leaves the account
 * intact rather than half deleted:
 *
 *  - all sessions (every refresh token and access token stops working immediately, because
 *    authentication requires a live session)
 *  - all devices, with their push tokens and public Signal keys (identity, signed, Kyber)
 *  - all unused one-time pre-keys
 *  - envelopes (ciphertext) addressed to the user, and their per-device sequence counters
 *  - message metadata the user sent or received
 *  - the user record (phone number / email, profile)
 *
 * Kept: envelopes the user already sent to OTHER people, so they still receive what was sent
 * to them before the deletion. They are ciphertext the server cannot read and expire by TTL.
 * OTP and rate-limit entries in Redis are keyed by HMACs and expire on their own.
 */
export function createAccountService({ logger }) {
  async function deleteAccount(auth) {
    let deleted = false;
    await mongoose.connection.transaction(async (session) => {
      const user = await User.findById(auth.userId).select('_id').session(session).lean();
      if (!user) return; // already deleted by a concurrent request
      const userId = user._id;

      const devices = await Device.find({ userId }).select('deviceId').session(session).lean();
      const sequenceCounters = devices.map((device) => `envelope:${device.deviceId}`);

      await Session.deleteMany({ userId }, { session });
      await OneTimePreKey.deleteMany({ userId }, { session });
      await MessageEnvelope.deleteMany({ recipientUserId: userId }, { session });
      await Message.deleteMany(
        mongoose.trusted({ $or: [{ senderUserId: userId }, { recipientUserId: userId }] }),
        { session },
      );
      if (sequenceCounters.length > 0) {
        await Counter.deleteMany({ _id: mongoose.trusted({ $in: sequenceCounters }) }, { session });
      }
      await Device.deleteMany({ userId }, { session });
      await User.deleteOne({ _id: userId }, { session });
      deleted = true;
    });
    // The id only: no phone number, email or device details.
    if (deleted) logger.info({ userId: auth.userId }, 'Account deleted');
    return { deleted };
  }

  return { deleteAccount };
}
