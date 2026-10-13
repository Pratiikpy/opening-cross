# One image for every Opening Cross service. Each compose service picks its own working directory and runs
# `node --import tsx src/main.ts`, exactly as tests/e2e/run-stack.sh does. The workspace packages are consumed
# as TypeScript source (their package.json `main` is src/index.ts), so there is no build step.
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Manifests first so the dependency layer is cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY tests ./tests
COPY examples ./examples
COPY apps/web/package.json ./apps/web/package.json

# Services and everything they depend on; devDependencies stay because tsx is one. The web app and the
# Rust/LiteSVM test harness are not installed.
RUN pnpm install --frozen-lockfile --filter "{./services/*}..." --prod=false \
    && pnpm store prune \
    && chown -R node:node /app

USER node
EXPOSE 8080
