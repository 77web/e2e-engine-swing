import { defineConfig } from 'vitest/config';

/**
 * Unit tests need neither a JVM nor a display. Integration tests own a real
 * JVM and a window, so they run serially and only with `E2E_SWING=1`.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          pool: 'forks',
          maxWorkers: 1,
        },
      },
    ],
  },
});
