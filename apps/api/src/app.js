import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { HEADERS, LIMITS } from '@secure-chat/shared/constants';

import { serializeError } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createAccountRouter } from './modules/account/account.routes.js';
import { createAttachmentsRouter } from './modules/attachments/attachments.routes.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createCallsRouter } from './modules/calls/calls.routes.js';
import { createContactsRouter } from './modules/contacts/contacts.routes.js';
import { createDevicesRouter } from './modules/devices/devices.routes.js';
import { createKeysRouter } from './modules/keys/keys.routes.js';
import { createMessagesRouter } from './modules/messages/messages.routes.js';
import { createPresenceRouter } from './modules/presence/presence.routes.js';
import { createRealtimeRouter } from './modules/realtime/realtime.routes.js';
import { createHealthRouter } from './routes/health.js';

// Accept an upstream request id only if it is short and harmless; otherwise mint one.
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Builds the Express app. Dependencies are injected so tests can run without real datastores.
 *
 * @param {{
 *   config: ReturnType<typeof import('./config/env.js').loadEnv>,
 *   logger: import('pino').Logger,
 *   healthChecks: Record<string, () => Promise<void>>,
 *   container: ReturnType<typeof import('./container.js').createContainer>,
 * }} deps
 */
export function createApp({ config, logger, healthChecks, container }) {
  const app = express();

  app.disable('x-powered-by');
  // Private API: no ETags/304s and no caching, so responses (ciphertext envelopes, tokens,
  // key material) never land in an HTTP cache on the device or a proxy.
  app.set('etag', false);
  app.set('trust proxy', config.trustProxyHops);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const incoming = req.headers[HEADERS.REQUEST_ID];
        const id =
          typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader(HEADERS.REQUEST_ID, id);
        return id;
      },
      // Log a minimal request shape: no headers, no query string, no body.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: req.url.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
        err: serializeError,
      },
      customLogLevel(req, res, err) {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req) => req.url === '/health' && !config.isProduction },
    }),
  );

  app.use(helmet());
  app.use(
    cors({
      // Native mobile clients send no Origin header; this only governs browsers.
      origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', HEADERS.DEVICE_ID, HEADERS.IDEMPOTENCY_KEY],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: LIMITS.JSON_BODY_BYTES, strict: true }));

  app.use(
    '/health',
    createHealthRouter({
      checks: healthChecks,
      timeoutMs: config.healthCheckTimeoutMs,
      logger,
    }),
  );
  app.use('/auth', createAuthRouter(container));
  app.use('/account', createAccountRouter(container));
  app.use('/devices', createDevicesRouter(container));
  app.use('/keys', createKeysRouter(container));
  app.use('/messages', createMessagesRouter(container));
  app.use('/pusher', createRealtimeRouter(container));
  app.use('/contacts', createContactsRouter(container));
  app.use('/calls', createCallsRouter(container));
  app.use('/presence', createPresenceRouter(container));
  app.use('/attachments', createAttachmentsRouter(container));
  // Signed-URL transfers of encrypted blobs, when the storage driver serves them itself
  // (`local`). Authorised by the URL's signature, not a bearer token, like S3 pre-signed URLs.
  const { attachmentService } = container;
  const blobRouter = attachmentService.storage.router?.({
    sizeOf: attachmentService.pendingUploadSize,
  });
  if (blobRouter) app.use('/blobs', blobRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
