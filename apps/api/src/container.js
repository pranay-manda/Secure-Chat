import { createAuthenticate } from './middleware/authenticate.js';
import { createAccountService } from './modules/account/accountService.js';
import { createAttachmentService } from './modules/attachments/attachmentService.js';
import { createRateLimiters } from './middleware/rateLimit.js';
import { createAuthService } from './modules/auth/authService.js';
import { createCallService } from './modules/calls/callService.js';
import { createOtpDelivery } from './modules/auth/otpDelivery.js';
import { createOtpService } from './modules/auth/otpService.js';
import { createPushNotifier } from './modules/messages/pushNotifier.js';
import { createPresenceService } from './modules/presence/presenceService.js';
import { createTokenService } from './modules/auth/tokenService.js';
import { createContactService } from './modules/contacts/contactService.js';
import { createDeviceService } from './modules/devices/deviceService.js';
import { createKeyService } from './modules/keys/keyService.js';
import { createMessageService } from './modules/messages/messageService.js';
import { createEmailProvider } from './services/email/index.js';
import { createAttachmentStorage } from './services/storage/index.js';
import { createPushProvider } from './services/push/index.js';
import { createChannelAuthorizer, createRealtime } from './services/realtime/index.js';
import { createSmsProvider } from './services/sms/index.js';

/**
 * Builds the application services once, from config and live clients.
 * Tests pass fake SMS/email providers, a capturing realtime and in-memory rate limiters.
 *
 * @param {{
 *   config: ReturnType<typeof import('./config/env.js').loadEnv>,
 *   logger: import('pino').Logger,
 *   redis: import('ioredis').Redis,
 *   smsProvider?: { sendOtp(phone: string, otp: string): Promise<void> },
 *   emailProvider?: { sendOtp(email: string, otp: string): Promise<void> },
 *   realtime?: { publish(channel: string, event: string, payload: object): Promise<void> },
 *   inMemoryRateLimits?: boolean,
 * }} deps
 */
export function createContainer({
  config,
  logger,
  redis,
  smsProvider,
  emailProvider,
  pushProvider,
  realtime,
  inMemoryRateLimits,
  attachmentStorage,
}) {
  const rateLimiters = createRateLimiters({ redis, inMemory: inMemoryRateLimits });
  const tokenService = createTokenService(config.auth);
  const otpService = createOtpService({
    redis,
    delivery: createOtpDelivery({
      smsProvider: smsProvider ?? createSmsProvider(config.sms),
      emailProvider: emailProvider ?? createEmailProvider(config.email),
    }),
    config: config.otp,
    logger,
  });
  const keyService = createKeyService({ logger });
  const pushNotifier = createPushNotifier({
    pushProvider: pushProvider === undefined ? createPushProvider(config.push) : pushProvider,
    delayMs: config.push.notifyDelayMs,
    logger,
  });
  const realtimeClient = realtime ?? createRealtime(config.pusher);
  if (config.isProduction && !config.calls.turn) {
    // Not fatal (calls on simple networks still connect), but expected in production.
    logger.warn('TURN is not configured: calls between phones behind strict NATs will fail');
  }
  // Calls end when a participant signs out, is signed out elsewhere or deletes the account.
  const callService = createCallService({
    redis,
    realtime: realtimeClient,
    pushNotifier,
    config: config.calls,
    logger,
  });
  // Online status, cleared by the same sign-out paths.
  const presenceService = createPresenceService({
    redis,
    config: config.presence,
    logger,
    realtime: realtimeClient,
  });
  // Encrypted media: metadata in MongoDB, encrypted blobs in attachment storage.
  const attachmentService = createAttachmentService({
    storage: attachmentStorage ?? createAttachmentStorage(config.attachments),
    rateLimiters,
    config: config.attachments,
    logger,
  });

  const authService = createAuthService({
    otpService,
    tokenService,
    keyService,
    callService,
    presenceService,
    logger,
  });

  return {
    tokenService,
    otpService,
    keyService,
    authService,
    deviceService: createDeviceService({ logger, callService, presenceService }),
    accountService: createAccountService({
      logger,
      callService,
      presenceService,
      attachmentService,
      otpService,
      authService,
    }),
    presenceService,
    attachmentService,
    contactService: createContactService(),
    pushNotifier,
    callService,
    messageService: createMessageService({
      realtime: realtimeClient,
      pushNotifier,
      logger,
    }),
    channelAuthorizer: createChannelAuthorizer(config.pusher),
    realtime: realtimeClient,
    rateLimiters,
    authenticate: createAuthenticate({ tokenService }),
  };
}
