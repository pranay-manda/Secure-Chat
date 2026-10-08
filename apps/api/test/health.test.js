import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './helpers.js';

describe('GET /health', () => {
  it('returns 200 when MongoDB and Redis are healthy', async () => {
    const { app } = buildTestApp();

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.api.status).toBe('ok');
    expect(res.body.checks.mongodb.status).toBe('ok');
    expect(res.body.checks.redis.status).toBe('ok');
    expect(typeof res.body.checks.mongodb.latencyMs).toBe('number');
  });

  it('returns 503 and hides error details when a dependency fails', async () => {
    const { app, lines } = buildTestApp({
      healthChecks: {
        mongodb: async () => {},
        redis: async () => {
          throw new Error('connect ECONNREFUSED redis://:secret@10.0.0.5:6379');
        },
      },
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis.status).toBe('down');
    expect(res.body.checks.mongodb.status).toBe('ok');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|secret|10\.0\.0\.5/);
    expect(lines.some((line) => line.check === 'redis')).toBe(true);
  });

  it('marks a hanging dependency as down after the timeout', async () => {
    const { app } = buildTestApp({
      healthChecks: {
        mongodb: () => new Promise(() => {}),
        redis: async () => {},
      },
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.checks.mongodb.status).toBe('down');
  });
});
