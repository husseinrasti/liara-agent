import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname) },
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'app/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
