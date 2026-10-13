import { ERROR_CODE } from '@secure-chat/shared/constants';

import { HttpError } from './errors.js';

/**
 * Validates request parts with zod schemas and exposes the parsed result as `req.valid`.
 * Unknown body fields are stripped. Error details list field paths and rules, never values.
 *
 * @param {{ body?: import('zod').ZodType, params?: import('zod').ZodType,
 *           query?: import('zod').ZodType }} schemas
 */
export function validate(schemas) {
  return (req, res, next) => {
    const valid = {};
    const issues = [];

    for (const [part, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) {
        valid[part] = result.data;
      } else {
        issues.push(
          ...result.error.issues.map((issue) => ({
            field: [part, ...issue.path].join('.'),
            message: issue.message,
          })),
        );
      }
    }

    if (issues.length > 0) {
      return next(
        new HttpError(400, ERROR_CODE.VALIDATION_ERROR, 'Invalid request', {
          details: { issues },
        }),
      );
    }

    req.valid = valid;
    return next();
  };
}
