import { Router } from 'express';
import { ERROR_CODE } from '@secure-chat/shared/constants';
import { pusherSocketIdSchema } from '@secure-chat/shared/validation';
import { z } from 'zod';

import { HttpError } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { deviceChannel } from '../../services/realtime/index.js';

const authBody = z.strictObject({
  socketId: pusherSocketIdSchema,
  channelName: z.string().min(1).max(200),
});

/**
 * Pusher endpoints. A device may subscribe to exactly one private channel: its own
 * `private-device-{deviceId}`, taken from the authenticated session (not from the request).
 */
export function createRealtimeRouter({ channelAuthorizer, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  // Public connection settings only (key + cluster). The secret never leaves the server.
  router.get('/config', (req, res) => {
    res.status(200).json({
      realtime: channelAuthorizer?.publicConfig ?? null,
      channel: deviceChannel(req.auth.deviceId),
    });
  });

  router.post('/auth', validate({ body: authBody }), (req, res) => {
    if (!channelAuthorizer) {
      throw new HttpError(503, ERROR_CODE.SERVICE_UNAVAILABLE, 'Realtime is not configured');
    }
    const { socketId, channelName } = req.valid.body;
    if (channelName !== deviceChannel(req.auth.deviceId)) {
      throw new HttpError(403, ERROR_CODE.FORBIDDEN, 'Not allowed to subscribe to this channel');
    }
    res.status(200).json(channelAuthorizer.authorize(socketId, channelName));
  });

  return router;
}
