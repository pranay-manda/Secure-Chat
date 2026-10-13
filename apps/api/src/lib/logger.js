import pino from 'pino';

const CENSOR = '[REDACTED]';

/** Keys that must never reach logs (architecture §4, §14). */
const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'password',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'refreshTokenHash',
  'usedRefreshTokenHashes',
  'codeHash',
  'idToken',
  'secret',
  'apiKey',
  'privateKey',
  'identityPrivateKey',
  'ciphertext',
  'content',
  'plaintext',
  'body',
  'phoneNumber',
  'phoneNumbers',
  'email',
  // SMTP credentials (email OTP delivery).
  'pass',
  'smtpPass',
  'pushToken',
  // Voice-call signaling: session descriptions and ICE candidates (network addresses) and
  // TURN credentials never go to logs.
  'sdp',
  'candidate',
  'candidates',
  'credential',
  'iceServers',
  'turnSecret',
];

/**
 * Redaction paths. pino wildcards match exactly one level, so each key is covered at
 * the top level, one level down and two levels down.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

/** MongoDB duplicate-key messages quote the duplicate value, e.g. a phone number or email. */
const DUPLICATE_KEY_VALUE = /dup key: \{[^}]*\}/g;
/** Error properties in which database drivers echo document values. */
const VALUE_BEARING_ERROR_FIELDS = [
  'keyValue',
  'errorResponse',
  'errInfo',
  'writeErrors',
  'errmsg',
];

/**
 * Error serializer: pino's standard one, minus document values that database errors carry in
 * their message, stack and extra fields (field redaction cannot see inside a message string).
 */
export function serializeError(err) {
  const serialized = pino.stdSerializers.err(err);
  if (!serialized || typeof serialized !== 'object') return serialized;
  const scrub = (value) =>
    typeof value === 'string' ? value.replace(DUPLICATE_KEY_VALUE, `dup key: ${CENSOR}`) : value;
  serialized.message = scrub(serialized.message);
  serialized.stack = scrub(serialized.stack);
  for (const field of VALUE_BEARING_ERROR_FIELDS) delete serialized[field];
  if (serialized.cause && typeof serialized.cause === 'object') {
    serialized.cause = serializeError(serialized.cause);
  }
  return serialized;
}

/**
 * @param {{ level?: string, nodeEnv?: string }} options
 * @param {import('pino').DestinationStream} [destination] optional stream (used by tests)
 */
export function createLogger({ level = 'info', nodeEnv = 'development' } = {}, destination) {
  const usePretty = nodeEnv === 'development' && !destination;

  return pino(
    {
      level,
      base: { service: 'secure-chat-api' },
      redact: { paths: REDACT_PATHS, censor: CENSOR },
      serializers: { err: serializeError },
      timestamp: pino.stdTimeFunctions.isoTime,
      ...(usePretty && {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
    },
    destination,
  );
}
