import { Router } from 'express';
import {
  ciphertextSchema,
  ciphertextTypeSchema,
  clientMessageIdSchema,
  cursorSchema,
  deviceIdSchema,
  messageIdBatchSchema,
  objectIdSchema,
  pageSizeSchema,
} from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';

// Only ciphertext is accepted: there is no field for plaintext content.
const sendBody = z.strictObject({
  recipientUserId: objectIdSchema,
  recipientDeviceId: deviceIdSchema,
  clientMessageId: clientMessageIdSchema,
  type: ciphertextTypeSchema,
  ciphertext: ciphertextSchema,
});

const listQuery = z.object({ after: cursorSchema.default(0), limit: pageSizeSchema });
const ackBody = z.strictObject({ upToSeq: cursorSchema });
const messageIdsBody = z.strictObject({ messageIds: messageIdBatchSchema });

export function createMessagesRouter({ messageService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.post(
    '/',
    rateLimiters.byUser('messageSendPerUser'),
    validate({ body: sendBody }),
    async (req, res) => {
      const result = await messageService.sendEnvelope(req.auth, req.valid.body);
      res.status(result.duplicate ? 200 : 201).json(result);
    },
  );

  router.get('/envelopes', validate({ query: listQuery }), async (req, res) => {
    res
      .status(200)
      .json({ envelopes: await messageService.listEnvelopes(req.auth, req.valid.query) });
  });

  router.post('/envelopes/ack', validate({ body: ackBody }), async (req, res) => {
    res.status(200).json(await messageService.ackEnvelopes(req.auth, req.valid.body.upToSeq));
  });

  // Read receipts from the recipient; metadata only.
  router.post('/read', validate({ body: messageIdsBody }), async (req, res) => {
    res.status(200).json(await messageService.markRead(req.auth, req.valid.body.messageIds));
  });

  // Sender's view of its own messages (sent / delivered / read).
  router.post('/status', validate({ body: messageIdsBody }), async (req, res) => {
    res.status(200).json({
      statuses: await messageService.getStatuses(req.auth, req.valid.body.messageIds),
    });
  });

  return router;
}
