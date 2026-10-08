import { describe, expect, it } from 'vitest';

import { createCapturingLogger } from './helpers.js';

describe('logger redaction', () => {
  it('redacts sensitive fields at the top level and when nested', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info(
      {
        otp: '123456',
        phoneNumber: '+15550001111',
        user: { accessToken: 'at-1', refreshToken: 'rt-1' },
        message: { envelope: { ciphertext: 'base64cipher' } },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
      },
      'test',
    );

    const [line] = lines;
    const serialized = JSON.stringify(line);
    for (const leaked of ['123456', '+15550001111', 'at-1', 'rt-1', 'base64cipher', 'Bearer abc']) {
      expect(serialized).not.toContain(leaked);
    }
    expect(line.otp).toBe('[REDACTED]');
    expect(line.user.accessToken).toBe('[REDACTED]');
    expect(line.message.envelope.ciphertext).toBe('[REDACTED]');
    expect(line.req.headers.authorization).toBe('[REDACTED]');
  });

  it('keeps non-sensitive fields and error codes', () => {
    const { logger, lines } = createCapturingLogger();
    const err = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });

    logger.error({ err, chatId: 'abc' }, 'failed');

    expect(lines[0].chatId).toBe('abc');
    expect(lines[0].err.code).toBe('ECONNREFUSED');
  });

  it('removes values that database errors quote in their message, stack and fields', () => {
    const { logger, lines } = createCapturingLogger();
    const message =
      'E11000 duplicate key error collection: securechat.users index: phoneNumber_1 ' +
      'dup key: { phoneNumber: "+919812345678" }';
    // Shape of a MongoServerError from the driver.
    const err = Object.assign(new Error(message), {
      name: 'MongoServerError',
      code: 11000,
      keyPattern: { phoneNumber: 1 },
      keyValue: { phoneNumber: '+919812345678' },
      errorResponse: { code: 11000, errmsg: message, keyValue: { phoneNumber: '+919812345678' } },
      errmsg: message,
    });

    logger.error({ err }, 'failed');

    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain('+919812345678');
    expect(serialized).not.toContain('9812345678');
    expect(lines[0].err.code).toBe(11000); // still diagnosable
    expect(lines[0].err.message).toContain('dup key: [REDACTED]');
  });
});
