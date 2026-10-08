import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

const commaList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const secretSchema = z
  .string()
  .min(32, 'must be at least 32 characters (use a random value)')
  .refine((value) => !/change-me|<[^>]+>/i.test(value), 'must be replaced with a random value');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://'),

    /** Comma-separated browser origins allowed by CORS. Native apps send no Origin. */
    CORS_ORIGINS: commaList,
    /** Number of reverse-proxy hops to trust for client IPs (0 = trust none). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

    // --- Authentication (Phase 1) ---
    /** HMAC-SHA256 key for access-token JWTs. Generate with `openssl rand -base64 48`. */
    JWT_ACCESS_SECRET: secretSchema,
    JWT_ISSUER: z.string().min(1).default('secure-chat-api'),
    JWT_AUDIENCE: z.string().min(1).default('secure-chat-app'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /** Sliding refresh-session lifetime; extended on every successful rotation. */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    /** HMAC key for OTP hashes and phone-number keys in Redis (never stored with the data). */
    OTP_HMAC_SECRET: secretSchema,
    OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(600).default(60),

    /**
     * `console` prints OTPs to the dev terminal and is refused in production.
     * `none` turns phone sign-in off until a real SMS provider is added.
     */
    SMS_PROVIDER: z.enum(['console', 'none']).default('console'),

    /** `resend` sends real email; `console` (development only) prints codes; `none` = off. */
    EMAIL_PROVIDER: z.enum(['resend', 'console', 'none']).default('resend'),
    RESEND_API_KEY: z
      .string()
      .regex(/^re_[A-Za-z0-9_]+$/, 'must be a Resend API key (starts with re_)')
      .optional(),
    /** Verified Resend sender: `you@your-domain` or `Secure Chat <you@your-domain>`. */
    RESEND_FROM_EMAIL: z
      .string()
      .trim()
      .regex(
        /^(?:[^<>\r\n]+ <[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/,
        'must be an email address or "Name <email address>"',
      )
      .optional(),

    // --- Push notifications (Expo push service -> FCM V1; credentials live in the EAS project) ---
    /** `expo` sends through Expo's push service; `none` disables push notifications. */
    PUSH_PROVIDER: z.enum(['expo', 'none']).default('expo'),
    /** Only needed if "enhanced push security" is enabled in the Expo project. */
    EXPO_ACCESS_TOKEN: z.string().min(20).optional(),
    /** Wait this long for the device to ack over realtime before sending a push. */
    PUSH_NOTIFY_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3000),

    // --- Realtime (Pusher Channels). All four or none; without them clients rely on sync. ---
    PUSHER_APP_ID: z.string().min(1).optional(),
    PUSHER_KEY: z.string().min(1).optional(),
    PUSHER_SECRET: z.string().min(1).optional(),
    PUSHER_CLUSTER: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const pusherKeys = ['PUSHER_APP_ID', 'PUSHER_KEY', 'PUSHER_SECRET', 'PUSHER_CLUSTER'];
    const pusherSet = pusherKeys.filter((key) => env[key]);
    if (pusherSet.length > 0 && pusherSet.length < pusherKeys.length) {
      for (const key of pusherKeys.filter((k) => !env[k])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when Pusher is configured',
        });
      }
    }

    if (env.JWT_ACCESS_SECRET === env.OTP_HMAC_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_HMAC_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }

    if (env.EMAIL_PROVIDER === 'resend') {
      for (const key of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL']) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when EMAIL_PROVIDER=resend',
          });
        }
      }
    }

    if (env.EMAIL_PROVIDER === 'none' && env.SMS_PROVIDER === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: 'at least one of EMAIL_PROVIDER or SMS_PROVIDER must be enabled',
      });
    }

    // Catch copy-pasted connection strings that still contain e.g. <db_password>.
    for (const key of ['MONGODB_URI', 'REDIS_URL']) {
      if (/<[^>]+>/.test(env[key])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'contains an unfilled <placeholder>; replace it with the real value',
        });
      }
    }

    if (env.NODE_ENV !== 'production') return;

    // Production must never run against unauthenticated datastores.
    if (!hasCredentials(env.MONGODB_URI)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message: 'must include credentials in production',
      });
    }
    if (!hasCredentials(env.REDIS_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'must include a password in production',
      });
    }
    if (env.SMS_PROVIDER === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'console provider is for development only; configure a real SMS provider',
      });
    }
    if (env.EMAIL_PROVIDER === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: 'console provider is for development only; use resend',
      });
    }
  });

function hasCredentials(uri) {
  try {
    const url = new URL(uri);
    return Boolean(url.password);
  } catch {
    return false;
  }
}

export class EnvValidationError extends Error {
  constructor(issues) {
    // Only variable names and rule messages: values may contain secrets.
    const details = issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    super(`Invalid environment configuration:\n${details.join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates environment variables and returns a frozen config object.
 * Throws EnvValidationError so the process fails fast on misconfiguration.
 */
export function loadEnv(source = process.env) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }

  const env = result.data;
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    mongoUri: env.MONGODB_URI,
    redisUrl: env.REDIS_URL,
    corsOrigins: Object.freeze(env.CORS_ORIGINS),
    trustProxyHops: env.TRUST_PROXY_HOPS,
    healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    auth: Object.freeze({
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      jwtIssuer: env.JWT_ISSUER,
      jwtAudience: env.JWT_AUDIENCE,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    }),
    otp: Object.freeze({
      hmacSecret: env.OTP_HMAC_SECRET,
      ttlSeconds: env.OTP_TTL_SECONDS,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
      resendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
    }),
    sms: Object.freeze({ provider: env.SMS_PROVIDER }),
    email: Object.freeze({
      provider: env.EMAIL_PROVIDER,
      resendApiKey: env.RESEND_API_KEY,
      from: env.RESEND_FROM_EMAIL,
      otpTtlSeconds: env.OTP_TTL_SECONDS,
    }),
    push: Object.freeze({
      provider: env.PUSH_PROVIDER,
      accessToken: env.EXPO_ACCESS_TOKEN,
      notifyDelayMs: env.PUSH_NOTIFY_DELAY_MS,
    }),
    pusher: env.PUSHER_APP_ID
      ? Object.freeze({
          appId: env.PUSHER_APP_ID,
          key: env.PUSHER_KEY,
          secret: env.PUSHER_SECRET,
          cluster: env.PUSHER_CLUSTER,
        })
      : null,
  });
}
