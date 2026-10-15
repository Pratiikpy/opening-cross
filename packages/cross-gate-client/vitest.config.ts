import { defineConfig } from 'vitest/config';

// `pnpm test`: the unit tests, which need nothing built. The LiteSVM suite against the compiled program is `pnpm test:svm`.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['test/svm/**', 'node_modules/**'] } });
