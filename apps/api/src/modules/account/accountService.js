import { ERROR_CODE, OTP_CHANNEL } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { HttpError } from '../../middleware/errors.js';

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
 * OTP and rate-limit entries in Redis are keyed by HMACs and expire on their own. The user's
 * uncollected missed-call notes are deleted; notes of calls they made to others stay with those
 * people (like messages already sent) and expire on their own.
 */
export function createAccountService({
  logger,
  callService,
  presenceService,
  attachmentService,
  otpService,
  authService,
}) {
  /** OTPs that add an email to an account: never usable to sign in (and the reverse). */
  const linkIdentity = (email) => ({ channel: OTP_CHANNEL.EMAIL, value: email, purpose: 'link' });

  /** The caller's own account details (id, email, phone number, profile). */
  async function getAccount(auth) {
    const user = await User.findById(auth.userId);
    if (!user) throw new HttpError(404, ERROR_CODE.NOT_FOUND, 'Account not found');
    return user.toJSON();
  }

  /** Adds a phone number to an account that has none (saved unverified, like at sign-up). */
  async function addPhone(auth, phoneNumber) {
    await authService.attachPhone(new mongoose.Types.ObjectId(auth.userId), phoneNumber);
    return getAccount(auth);
  }

  async function emailInUse(email) {
    return Boolean(await User.exists({ email }));
  }

  /** Sends a code to `email` so it can be added to the caller's account (which has none). */
  async function requestEmailCode(auth, email) {
    const user = await User.findById(auth.userId).select('email').lean();
    if (user?.email) {
      throw new HttpError(409, ERROR_CODE.ALREADY_SET, 'This account already has an email');
    }
    if (await emailInUse(email)) {
      throw new HttpError(409, ERROR_CODE.EMAIL_TAKEN, 'This email is used by another account');
    }
    return otpService.requestOtp(linkIdentity(email));
  }

  /** Verifies the code and adds the email (only if the account still has none). */
  async function addEmail(auth, email, otp) {
    await otpService.verifyOtp(linkIdentity(email), otp);
    try {
      const result = await User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(auth.userId), email: { $exists: false } },
        { $set: { email, updatedAt: new Date() } },
      );
      if (result.matchedCount === 0) {
        throw new HttpError(409, ERROR_CODE.ALREADY_SET, 'This account already has an email');
      }
    } catch (err) {
      if (err?.code === 11000) {
        throw new HttpError(409, ERROR_CODE.EMAIL_TAKEN, 'This email is used by another account');
      }
      throw err;
    }
    return getAccount(auth);
  }

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
      // Attachments sent to the user (and their unfinished uploads) expire now; their encrypted
      // blobs are deleted by the sweep below. Attachments they sent to others stay, like
      // envelopes, until they expire.
      await attachmentService?.expireForDeletedUser(userId, { session });
      await Device.deleteMany({ userId }, { session });
      await User.deleteOne({ _id: userId }, { session });
      deleted = true;
    });
    // The id only: no phone number, email or device details.
    if (deleted) {
      // A call in progress ends; the other participant is told the call is over.
      await callService?.endCallsForUser(auth.userId, 'account_deleted');
      await callService?.forgetUser(auth.userId);
      await presenceService?.clear(auth.userId);
      await attachmentService?.sweepExpired().catch((err) => {
        logger.error({ err }, 'Attachment sweep after account deletion failed; retried later');
      });
      logger.info({ userId: auth.userId }, 'Account deleted');
    }
    return { deleted };
  }

  return { deleteAccount, getAccount, addPhone, requestEmailCode, addEmail, linkIdentity };
}
