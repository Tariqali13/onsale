import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration suites share one Postgres database and Redis db, so run files serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
