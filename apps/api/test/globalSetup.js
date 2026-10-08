import { MongoMemoryReplSet } from 'mongodb-memory-server';

/** First run downloads a MongoDB binary (cached afterwards). Tests never touch Atlas. */
export default async function setup({ provide }) {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  provide('mongoUri', replSet.getUri());

  return async () => {
    await replSet.stop();
  };
}
