import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Starts one in-memory MongoDB replica set (transactions need a replica set) for all files.
    globalSetup: ['./test/globalSetup.js'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
