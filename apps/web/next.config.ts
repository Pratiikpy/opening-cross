import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages that ship TypeScript source (no build step) and are imported by the web app.
  transpilePackages: ['@opening-cross/presets'],
  // A second dev server or a test build can use its own output directory (NEXT_DIST_DIR) without touching the default one.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default config;
