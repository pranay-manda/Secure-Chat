import { PRESENCE, REALTIME_EVENT } from '@secure-chat/shared/constants';
import mongoose from 'mongoose';

import { Device } from '../../models/Device.js';
import { directConversationId, Message } from '../../models/Message.js';
import { deviceChannel } from '../../services/realtime/index.js';

/**
 * Online status, kept only in Redis and only for as long as a device keeps proving it is
 * connected:
 *
 *   presence:{userId}  string  deviceId of the active device, PX = TTL
 *
 * A heartbeat (POST /presence/heartbeat) from an authenticated session sets the key with the
 * TTL; a device that stops heartbeating (app closed, backgrounded, offline, crashed) is forgotten
 * when the key expires. Nothing is written to MongoDB: this is app connectivity, not a profile
 * attribute, and no "last seen" time is kept or served.
 *
 * Who may see it: only people the user has exchanged messages with (a conversation exists in
 * `messages`), so presence cannot be probed for arbitrary user ids.
 *
 * Changes are also pushed (REALTIME_EVENT.PRESENCE on the existing device channels) to those
 * same people when a device comes online (first beat) or goes away on purpose, so an open chat
 * updates at once instead of at its next poll. A connection that simply vanishes is not pushed:
 * the key expires after the TTL and the next poll reads offline.
 */
const key = (userId) => `presence:${userId}`;

/** Deletes the key only if it still belongs to `deviceId` (a newer device's beat survives). */
const CLEAR_IF_DEVICE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const conversationId = directConversationId;

/**
 * @param {{ redis: import('ioredis').Redis, config: { ttlSeconds: number },
 *           logger: import('pino').Logger,
 *           realtime?: { publish(channel: string, event: string, payload: object): Promise<void> } }} deps
 */
export function createPresenceService({ redis, config, logger, realtime }) {
  if (!redis.presenceClearIfDevice) {
    redis.defineCommand('presenceClearIfDevice', { numberOfKeys: 1, lua: CLEAR_IF_DEVICE });
  }
  const ttlMs = config.ttlSeconds * 1000;

  /**
   * Tells the people `userId` has a chat with (their active devices) that the user's online
   * status changed. Best effort: presence is advisory, and polling recovers any loss.
   */
  async function announce(userId, online) {
    if (!realtime) return;
    try {
      const uid = new mongoose.Types.ObjectId(userId);
      const conversations = await Message.distinct('conversationId', {
        $or: [{ senderUserId: uid }, { recipientUserId: uid }],
      });
      const peers = [
        ...new Set(
          conversations
            .flatMap((id) => String(id).split(':'))
            .filter((id) => id && id !== String(userId)),
        ),
      ];
      if (peers.length === 0) return;
      const devices = await Device.find({
        userId: mongoose.trusted({ $in: peers }),
        revokedAt: null,
      })
        .select('deviceId')
        .lean();
      await Promise.allSettled(
        devices.map((d) =>
          realtime.publish(deviceChannel(d.deviceId), REALTIME_EVENT.PRESENCE, {
            userId: String(userId),
            online,
          }),
        ),
      );
    } catch (err) {
      logger.warn({ err }, 'Could not announce a presence change');
    }
  }

  /** The device is online now; forgotten after the TTL unless renewed. */
  async function heartbeat({ userId, deviceId }) {
    const previous = await redis.get(key(userId));
    await redis.set(key(userId), deviceId, 'PX', ttlMs);
    if (!previous) await announce(userId, true); // came online: tell people right away
  }

  /**
   * The device went away on purpose (app backgrounded, logout, revocation, deletion). With a
   * `deviceId`, only that device's status is cleared: a beat from a newer device stands.
   * Never throws: sign-out must not fail on it.
   */
  async function clear(userId, { deviceId } = {}) {
    let removed = 0;
    try {
      removed = deviceId
        ? await redis.presenceClearIfDevice(key(userId), deviceId)
        : await redis.del(key(userId));
    } catch (err) {
      logger.warn({ err }, 'Could not clear presence');
    }
    if (removed > 0) await announce(userId, false);
  }

  /**
   * Online flags for `userIds`, for people the caller has a conversation with. Anyone else
   * (including unknown ids) reads as offline, so the answer reveals nothing about strangers.
   *
   * @returns {Promise<Record<string, boolean>>}
   */
  async function query(auth, userIds) {
    const ids = [...new Set(userIds.map(String))].filter((id) => id !== auth.userId);
    const result = Object.fromEntries(userIds.map((id) => [String(id), false]));
    if (ids.length === 0) return result;

    // `$in` is ours, not from the request (Mongoose runs with sanitizeFilter).
    const known = new Set(
      await Message.distinct('conversationId', {
        conversationId: mongoose.trusted({
          $in: ids.map((id) => conversationId(auth.userId, id)),
        }),
      }),
    );
    const allowed = ids.filter((id) => known.has(conversationId(auth.userId, id)));
    if (allowed.length === 0) return result;

    const values = await redis.mget(...allowed.map(key));
    allowed.forEach((id, i) => {
      result[id] = Boolean(values[i]);
    });
    return result;
  }

  return { heartbeat, clear, query, ttlSeconds: config.ttlSeconds };
}

export const PRESENCE_DEFAULT_TTL_SECONDS = PRESENCE.TTL_SECONDS;
