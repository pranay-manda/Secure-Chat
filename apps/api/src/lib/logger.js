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
  'email',
  'resendApiKey',
  'pushToken',
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
      timestamp: pino.stdTimeFunctions.isoTime,
      ...(usePretty && {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
    },
    destination,
  );
}
