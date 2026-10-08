import { createAuthenticate } from './middleware/authenticate.js';
import { createRateLimiters } from './middleware/rateLimit.js';
import { createAuthService } from './modules/auth/authService.js';
import { createOtpDelivery } from './modules/auth/otpDelivery.js';
import { createOtpService } from './modules/auth/otpService.js';
import { createPushNotifier } from './modules/messages/pushNotifier.js';
import { createTokenService } from './modules/auth/tokenService.js';
import { createDeviceService } from './modules/devices/deviceService.js';
import { createKeyService } from './modules/keys/keyService.js';
import { createMessageService } from './modules/messages/messageService.js';
import { createEmailProvider } from './services/email/index.js';
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
}) {
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

  return {
    tokenService,
    otpService,
    keyService,
    authService: createAuthService({ otpService, tokenService, keyService, logger }),
    deviceService: createDeviceService({ logger }),
    pushNotifier,
    messageService: createMessageService({
      realtime: realtime ?? createRealtime(config.pusher),
      pushNotifier,
      logger,
    }),
    channelAuthorizer: createChannelAuthorizer(config.pusher),
    rateLimiters: createRateLimiters({ redis, inMemory: inMemoryRateLimits }),
    authenticate: createAuthenticate({ tokenService }),
  };
}
