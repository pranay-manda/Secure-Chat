import { Router } from 'express';
import { deviceIdSchema } from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';
import { deviceDetailsSchema } from '../auth/auth.routes.js';

export function createDevicesRouter({ deviceService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.post('/', validate({ body: deviceDetailsSchema }), async (req, res) => {
    const device = await deviceService.registerCurrentDevice(req.auth, req.valid.body);
    res.status(200).json({ device });
  });

  router.get('/', async (req, res) => {
    res.status(200).json({ devices: await deviceService.listDevices(req.auth) });
  });

  router.delete(
    '/:deviceId',
    validate({ params: z.object({ deviceId: deviceIdSchema }) }),
    async (req, res) => {
      await deviceService.revokeDevice(req.auth, req.valid.params.deviceId);
      res.status(204).end();
    },
  );

  return router;
}
