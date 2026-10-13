import { Router } from 'express';
import {
  clientAttachmentIdSchema,
  encryptedAttachmentSizeSchema,
  objectIdSchema,
} from '@secure-chat/shared/validation';
import { z } from 'zod';

import { validate } from '../../middleware/validate.js';

// No field for the media key, the file type or the file name: the server never learns them.
const createBody = z.strictObject({
  clientAttachmentId: clientAttachmentIdSchema,
  recipientUserId: objectIdSchema,
  size: encryptedAttachmentSizeSchema,
});
const idParams = z.object({ attachmentId: objectIdSchema });

export function createAttachmentsRouter({ attachmentService, rateLimiters, authenticate }) {
  const router = Router();

  router.use(authenticate, rateLimiters.byUser('authenticatedPerUser'));

  router.post(
    '/',
    rateLimiters.byUser('attachmentCreatePerUser'),
    validate({ body: createBody }),
    async (req, res) => {
      res.status(201).json(await attachmentService.createUpload(req.auth, req.valid.body));
    },
  );

  router.post('/:attachmentId/complete', validate({ params: idParams }), async (req, res) => {
    res
      .status(200)
      .json(await attachmentService.completeUpload(req.auth, req.valid.params.attachmentId));
  });

  router.get('/:attachmentId', validate({ params: idParams }), async (req, res) => {
    res
      .status(200)
      .json(await attachmentService.getDownload(req.auth, req.valid.params.attachmentId));
  });

  router.post('/:attachmentId/received', validate({ params: idParams }), async (req, res) => {
    await attachmentService.markReceived(req.auth, req.valid.params.attachmentId);
    res.status(204).end();
  });

  return router;
}
