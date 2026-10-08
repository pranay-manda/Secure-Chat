import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './helpers.js';

describe('Express security middleware', () => {
  it('sets helmet headers and hides x-powered-by', async () => {
    const { app } = buildTestApp();

    const res = await request(app).get('/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('forbids caching of API responses and sends no ETags', async () => {
    const { app } = buildTestApp();

    const res = await request(app).get('/health');

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
  });

  it('returns a request id, reusing a safe incoming one', async () => {
    const { app } = buildTestApp();

    const generated = await request(app).get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const reused = await request(app).get('/health').set('x-request-id', 'trace-abc-12345');
    expect(reused.headers['x-request-id']).toBe('trace-abc-12345');

    const rejected = await request(app).get('/health').set('x-request-id', '<script>');
    expect(rejected.headers['x-request-id']).not.toBe('<script>');
  });

  it('does not allow cross-origin browser requests by default', async () => {
    const { app } = buildTestApp();

    const res = await request(app).get('/health').set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows configured origins only', async () => {
    const { app } = buildTestApp({ env: { CORS_ORIGINS: 'https://app.example' } });

    const allowed = await request(app).get('/health').set('Origin', 'https://app.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example');

    const denied = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns JSON 404 for unknown routes', async () => {
    const { app } = buildTestApp();

    const res = await request(app).get('/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed JSON with 400 and no stack trace', async () => {
    const { app } = buildTestApp();

    const res = await request(app)
      .post('/does-not-exist')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
  });

  it('rejects oversized JSON bodies with 413', async () => {
    const { app } = buildTestApp();

    const res = await request(app)
      .post('/does-not-exist')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
