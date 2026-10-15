import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The LiteSVM suite: runs the compiled cross_gate (target/deploy, or OC_DEPLOY_DIR) through the shared harness in
// tests/core, the same way tests/core exercises the other programs. The harness and the packages the tests drive
// (litesvm, the SAS client, the token programs) are tests/core's dependencies, so they are resolved from there.
const core = (name: string) => fileURLToPath(new URL(`../../tests/core/node_modules/${name}`, import.meta.url));

export default defineConfig({
  resolve: { alias: { 'sas-lib': core('sas-lib'), '@solana-program/token-2022': core('@solana-program/token-2022'), '@solana-program/system': core('@solana-program/system') } },
  server: { fs: { strict: false } },
  test: { include: ['test/svm/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 180_000 },
});
