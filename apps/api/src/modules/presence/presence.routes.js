import { Router } from 'express';
import { PRESENCE, REALTIME_EVENT } from '@secure-chat/shared/constants';
import { objectIdSchema } from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';
import { Device } from '../../models/Device.js';
import { deviceChannel } from '../../services/realtime/index.js';

const queryParams = z.strictObject({
  userIds: z
    .string()
    .min(1)
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(objectIdSchema).min(1).max(PRESENCE.QUERY_MAX_IDS)),
});

const typingBody = z.strictObject({
  peerUserId: objectIdSchema,
  typing: z.boolean().default(true),
});

/**
 * Online status (see presenceService.js).
 *
 *   POST   /presence/heartbeat   this device is on screen and connected (renews the TTL)
 *   DELETE /presence             this device is going away (app left the screen)
 *   GET    /presence?userIds=a,b online flags for people the caller has chats with
 *   POST   /presence/typing      notifies peer that this user is typing
 */
export function createPresenceRouter({ presenceService, rateLimiters, authenticate, realtime }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.post('/heartbeat', rateLimiters.byUser('presenceHeartbeatPerUser'), async (req, res) => {
    await presenceService.heartbeat(req.auth);
    res.status(204).end();
  });

  router.delete('/', async (req, res) => {
    await presenceService.clear(req.auth.userId, { deviceId: req.auth.deviceId });
    res.status(204).end();
  });

  router.get('/', validate({ query: queryParams }), async (req, res) => {
    res
      .status(200)
      .json({ presence: await presenceService.query(req.auth, req.valid.query.userIds) });
  });

  router.post('/typing', validate({ body: typingBody }), async (req, res) => {
    const { peerUserId, typing } = req.valid.body;
    if (peerUserId === req.auth.userId) return res.status(204).end();

    if (realtime) {
      const devices = await Device.find({
        userId: peerUserId,
        revokedAt: null,
      })
        .select('deviceId')
        .lean();

      if (devices.length > 0) {
        await Promise.allSettled(
          devices.map((d) =>
            realtime.publish(deviceChannel(d.deviceId), REALTIME_EVENT.TYPING, {
              fromUserId: req.auth.userId,
              typing,
            }),
          ),
        );
      }
    }

    res.status(204).end();
  });

  return router;
}
