import { Redis } from 'ioredis';

/**
 * @param {{ url: string, logger: import('pino').Logger }} options
 */
export async function connectRedis({ url, logger }) {
  const redis = new Redis(url, {
    lazyConnect: true,
    // Fail commands fast instead of queueing them while Redis is unreachable;
    // callers (rate limiting, presence) must handle errors explicitly.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });

  redis.on('error', (err) => logger.error({ err }, 'Redis error'));
  redis.on('reconnecting', () => logger.warn('Redis reconnecting'));
  redis.on('ready', () => logger.info('Redis ready'));

  await redis.connect();
  return redis;
}

/** @param {Redis} redis */
export async function pingRedis(redis) {
  const reply = await redis.ping();
  if (reply !== 'PONG') {
    throw new Error('Unexpected Redis PING reply');
  }
}
