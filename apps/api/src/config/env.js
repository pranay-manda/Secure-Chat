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

/** An email sender: `you@example.com` or `CipherChat <you@example.com>`. */
const SENDER = /^(?:[^<>\r\n]+ <[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/;
const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

/** An optional variable; an empty value (e.g. `SMTP_PORT=`) counts as not set. */
const optionalEnv = (schema) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  );

const secretSchema = z
  .string()
  .min(32, 'must be at least 32 characters (use a random value)')
  .refine((value) => !/change-me|<[^>]+>/i.test(value), 'must be replaced with a random value');

/**
 * STUN/TURN URI (RFC 7064 / RFC 7065): `scheme:host[:port]`, TURN optionally with
 * `?transport=udp|tcp`. There is deliberately no room for a user name or password: these URLs
 * are sent to every phone, while TURN credentials are minted per call (see iceServers.js).
 * Returns null if the value is not such a URI.
 */
export function parseIceUrl(url) {
  const match =
    /^(stuns?|turns?):(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(
      url,
    );
  if (!match) return null;
  const port = match[3] === undefined ? null : Number(match[3]);
  if (port !== null && (port < 1 || port > 65_535)) return null;
  const scheme = match[1].toLowerCase();
  const transport = match[4]?.toLowerCase() ?? null;
  if (transport && !scheme.startsWith('turn')) return null; // STUN URIs have no transport
  if (scheme === 'turns' && transport === 'udp') return null; // turns: is TLS over TCP
  return { scheme, host: match[2], port, transport };
}

const isUrlOf = (kind) => (url) => parseIceUrl(url)?.scheme.startsWith(kind) === true;

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

    /**
     * `smtp` sends real email through an SMTP server (Nodemailer, TLS required); `console`
     * (development only) prints codes to the terminal; `none` switches email sign-in off.
     */
    EMAIL_PROVIDER: z
      .enum(['smtp', 'console', 'none'], {
        error: 'must be smtp, console or none (resend was replaced by smtp; see .env.example)',
      })
      .default('smtp'),
    /** SMTP server host name, e.g. smtp.gmail.com (no scheme, no port). */
    SMTP_HOST: optionalEnv(
      z
        .string()
        .trim()
        .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i, 'must be a host name like smtp.gmail.com'),
    ),
    /** 587 (recommended): STARTTLS, required. 465: TLS from the start. Never plain text. */
    SMTP_PORT: optionalEnv(z.coerce.number().int().min(1).max(65_535)),
    SMTP_USER: optionalEnv(z.string().trim().min(1)),
    /** Gmail: an App Password (needs 2-Step Verification), not the account password. */
    SMTP_PASS: optionalEnv(z.string().min(1)),
    /** Sender shown to users; defaults to SMTP_USER. `you@x.com` or `CipherChat <you@x.com>`. */
    SMTP_FROM: optionalEnv(
      z.string().trim().regex(SENDER, 'must be an email address or "Name <email address>"'),
    ),

    // --- Push notifications (Expo push service -> FCM V1; credentials live in the EAS project) ---
    /** `expo` sends through Expo's push service; `none` disables push notifications. */
    PUSH_PROVIDER: z.enum(['expo', 'none']).default('expo'),
    /** Only needed if "enhanced push security" is enabled in the Expo project. */
    EXPO_ACCESS_TOKEN: z.string().min(20).optional(),
    /** Wait this long for the device to ack over realtime before sending a push. */
    PUSH_NOTIFY_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(3000),

    // --- Voice calls (WebRTC; the server only relays signaling, never audio) ---
    /** An unanswered call ends as "missed" after this long. */
    CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(45),
    /** Backstop lifetime of an answered call's server state (cleared normally on hang-up). */
    CALL_MAX_DURATION_SECONDS: z.coerce.number().int().min(60).max(86_400).default(14_400),
    /**
     * STUN servers (comma-separated `stun:` URLs). The default is Google's public STUN server:
     * fine for development; production should point at its own (e.g. the TURN host's STUN port).
     */
    STUN_URLS: z
      .string()
      .default('stun:stun.l.google.com:19302')
      .transform((value) =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    /**
     * TURN relay (coturn-compatible "TURN REST API"): comma-separated `turn:`/`turns:` URLs and
     * the shared secret configured on the TURN server (`static-auth-secret`). The API mints
     * short-lived credentials per call from it; the secret itself never leaves the server.
     * Both or neither. Without TURN, calls behind strict NATs/firewalls cannot connect.
     */
    TURN_URLS: commaList,
    TURN_SECRET: secretSchema.optional(),
    /** Lifetime of minted TURN credentials; must cover the longest possible call. */
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(18_000),
    /**
     * `all` (default): direct connections when possible, TURN as fallback. `relay`: media always
     * goes through TURN (hides each phone's IP address from the other; also the way to prove a
     * TURN server works). Needs TURN.
     */
    ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).default('all'),

    // --- Attachments: encrypted blobs only (the server never has media keys or plaintext) ---
    /** `local`: the API host's disk, single instance only. */
    ATTACHMENT_STORAGE: z.enum(['local']).default('local'),
    ATTACHMENT_STORAGE_DIR: z.string().min(1).default('./data/attachments'),
    /** Expired blobs are deleted this often (0 disables the sweep). */
    ATTACHMENT_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(600),

    // --- Presence (online status): forgotten this long after the last heartbeat ---
    PRESENCE_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(45),

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

    if (env.TURN_URLS.length > 0 && !env.TURN_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['TURN_SECRET'], message: 'required with TURN_URLS' });
    }
    if (env.TURN_SECRET && env.TURN_URLS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['TURN_URLS'], message: 'required with TURN_SECRET' });
    }
    if (!env.TURN_URLS.every(isUrlOf('turn'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_URLS'],
        message:
          'must be turn:/turns: URLs like turn:host:3478?transport=udp (no user name or password in the URL)',
      });
    }
    if (!env.STUN_URLS.every(isUrlOf('stun'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['STUN_URLS'],
        message: 'must be stun:/stuns: URLs like stun:host:3478',
      });
    }
    if (env.TURN_SECRET && [env.JWT_ACCESS_SECRET, env.OTP_HMAC_SECRET].includes(env.TURN_SECRET)) {
      // The TURN server holds this secret too: it must not be able to sign tokens.
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET and OTP_HMAC_SECRET',
      });
    }
    if (
      env.TURN_URLS.length > 0 &&
      env.TURN_CREDENTIAL_TTL_SECONDS <
        env.CALL_RING_TIMEOUT_SECONDS + env.CALL_MAX_DURATION_SECONDS
    ) {
      // The TURN server checks the credential on every allocation refresh: if it expires
      // mid-call, a relayed call loses its audio.
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_CREDENTIAL_TTL_SECONDS'],
        message: 'must be at least CALL_RING_TIMEOUT_SECONDS + CALL_MAX_DURATION_SECONDS',
      });
    }
    if (env.ICE_TRANSPORT_POLICY === 'relay' && env.TURN_URLS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ICE_TRANSPORT_POLICY'],
        message: 'relay needs TURN_URLS and TURN_SECRET',
      });
    }

    if (env.JWT_ACCESS_SECRET === env.OTP_HMAC_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_HMAC_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }

    if (env.EMAIL_PROVIDER === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when EMAIL_PROVIDER=smtp',
          });
        }
      }
      // The sender defaults to SMTP_USER, which then has to be an email address.
      if (!env.SMTP_FROM && env.SMTP_USER && !EMAIL_ADDRESS.test(env.SMTP_USER)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_FROM'],
          message: 'required when SMTP_USER is not an email address (it is the default sender)',
        });
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
        message: 'console provider is for development only; use smtp',
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
      smtp:
        env.EMAIL_PROVIDER === 'smtp'
          ? Object.freeze({
              host: env.SMTP_HOST,
              port: env.SMTP_PORT,
              user: env.SMTP_USER,
              pass: env.SMTP_PASS,
              from: env.SMTP_FROM || env.SMTP_USER,
            })
          : null,
      otpTtlSeconds: env.OTP_TTL_SECONDS,
    }),
    push: Object.freeze({
      provider: env.PUSH_PROVIDER,
      accessToken: env.EXPO_ACCESS_TOKEN,
      notifyDelayMs: env.PUSH_NOTIFY_DELAY_MS,
    }),
    calls: Object.freeze({
      ringTimeoutSeconds: env.CALL_RING_TIMEOUT_SECONDS,
      maxDurationSeconds: env.CALL_MAX_DURATION_SECONDS,
      stunUrls: Object.freeze(env.STUN_URLS),
      iceTransportPolicy: env.ICE_TRANSPORT_POLICY,
      turn:
        env.TURN_URLS.length > 0
          ? Object.freeze({
              urls: Object.freeze(env.TURN_URLS),
              secret: env.TURN_SECRET,
              credentialTtlSeconds: env.TURN_CREDENTIAL_TTL_SECONDS,
            })
          : null,
    }),
    presence: Object.freeze({ ttlSeconds: env.PRESENCE_TTL_SECONDS }),
    attachments: Object.freeze({
      driver: env.ATTACHMENT_STORAGE,
      dir: env.ATTACHMENT_STORAGE_DIR,
      sweepIntervalSeconds: env.ATTACHMENT_SWEEP_INTERVAL_SECONDS,
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
