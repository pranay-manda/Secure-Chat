import { ERROR_CODE } from '@secure-chat/shared/constants';

/** Thrown by route handlers and services to return a specific status without leaking internals. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code stable machine-readable code (see ERROR_CODE)
   * @param {string} message safe, user-facing message
   * @param {{ retryAfterSeconds?: number, details?: object }} [extra]
   */
  constructor(status, code, message, { retryAfterSeconds, details } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: ERROR_CODE.NOT_FOUND, message: 'Route not found' } });
}

// Body-parser errors (raised by express.json) mapped to safe client responses.
const BODY_PARSER_ERRORS = {
  'entity.too.large': [413, 'PAYLOAD_TOO_LARGE', 'Request body too large'],
  'entity.parse.failed': [400, 'INVALID_JSON', 'Malformed JSON body'],
  'encoding.unsupported': [415, 'UNSUPPORTED_ENCODING', 'Unsupported content encoding'],
};

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    if (err.retryAfterSeconds) {
      res.set('Retry-After', String(Math.ceil(err.retryAfterSeconds)));
    }
    if (err.status >= 500) {
      req.log.error({ err }, 'Request failed');
    }
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
    });
  }

  const known = BODY_PARSER_ERRORS[err.type];
  if (known) {
    const [status, code, message] = known;
    return res.status(status).json({ error: { code, message } });
  }

  req.log.error({ err }, 'Unhandled error');
  return res
    .status(500)
    .json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
