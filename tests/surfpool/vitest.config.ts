import { defineConfig } from 'vitest/config';

// One surfnet is shared by every file, and the protocol account is a singleton: files run one after another.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 240_000, hookTimeout: 600_000 } });
