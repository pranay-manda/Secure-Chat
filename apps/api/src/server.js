import { createApp } from './app.js';
import { EnvValidationError, loadEnv } from './config/env.js';
import { createContainer } from './container.js';
import { connectMongo, disconnectMongo, pingMongo } from './db/mongo.js';
import { connectRedis, pingRedis } from './db/redis.js';
import { createLogger } from './lib/logger.js';
import { migrateUserIndexes } from './models/User.js';

async function main() {
  const config = loadEnv();
  const logger = createLogger({ level: config.logLevel, nodeEnv: config.nodeEnv });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exitCode = 1;
  });

  // Fail fast: the API is not useful without its source of truth and Redis.
  await connectMongo({ uri: config.mongoUri, isProduction: config.isProduction, logger });
  if (await migrateUserIndexes()) {
    logger.info('Migrated users.phoneNumber index to a partial unique index');
  }
  const redis = await connectRedis({ url: config.redisUrl, logger });

  const app = createApp({
    config,
    logger,
    healthChecks: {
      mongodb: pingMongo,
      redis: () => pingRedis(redis),
    },
    container: createContainer({ config, logger, redis }),
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port, env: config.nodeEnv }, 'API listening');
  });
  // Keep idle connections open longer than typical load balancer timeouts (60s).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    try {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await Promise.allSettled([disconnectMongo(), redis.quit()]);
      logger.info('Shutdown complete');
      logger.flush();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Logger may not exist yet (e.g. invalid env), so write the reason to stderr.
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else {
    console.error('Failed to start API:', err?.message ?? err);
  }
  process.exit(1);
});
