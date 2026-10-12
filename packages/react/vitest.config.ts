import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { pool: 'threads', environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'] },
});
