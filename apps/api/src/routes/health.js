import { Router } from 'express';
import { HEALTH_STATUS } from '@secure-chat/shared/constants';

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(name, check, timeoutMs, logger) {
  const startedAt = performance.now();
  try {
    await withTimeout(Promise.resolve().then(check), timeoutMs);
    return { status: HEALTH_STATUS.OK, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    // Details go to logs only; the public response never exposes internals.
    logger.warn({ err, check: name }, 'Health check failed');
    return { status: HEALTH_STATUS.DOWN, latencyMs: Math.round(performance.now() - startedAt) };
  }
}

/**
 * GET /health reports the API and each dependency. 200 when everything is up, 503 otherwise.
 *
 * @param {{ checks: Record<string, () => Promise<void>>, timeoutMs: number, logger: import('pino').Logger }} options
 */
export function createHealthRouter({ checks, timeoutMs, logger }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => [
        name,
        await runCheck(name, check, timeoutMs, logger),
      ]),
    );
    const dependencies = Object.fromEntries(entries);
    const healthy = entries.every(([, result]) => result.status === HEALTH_STATUS.OK);

    res
      .status(healthy ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({
        status: healthy ? HEALTH_STATUS.OK : HEALTH_STATUS.DEGRADED,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        checks: { api: { status: HEALTH_STATUS.OK }, ...dependencies },
      });
  });

  return router;
}
