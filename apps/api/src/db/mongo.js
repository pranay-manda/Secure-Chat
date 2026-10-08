import mongoose from 'mongoose';

// Reject query filters on fields not in the schema, and neutralise `$`-operators
// injected through user input (e.g. { phoneNumber: { $ne: null } }).
mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true);

/**
 * @param {{ uri: string, isProduction: boolean, logger: import('pino').Logger }} options
 */
export async function connectMongo({ uri, isProduction, logger }) {
  const { connection } = mongoose;

  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 20,
    // Index builds are a deliberate migration step in production.
    autoIndex: !isProduction,
  });

  logger.info({ db: connection.name }, 'MongoDB connected');
  return connection;
}

export async function pingMongo() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('MongoDB not connected');
  }
  await mongoose.connection.db.admin().ping();
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}
