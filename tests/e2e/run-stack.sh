#!/bin/sh
# Starts the indexer, API and web app against a local validator (already running on 8899) and a
# Postgres at DATABASE_URL, logging to /tmp/oc-*.log. Stops them all on exit.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${DATABASE_URL:?set DATABASE_URL}"
export RPC_URL=${RPC_URL:-http://127.0.0.1:8899}
trap 'kill 0' EXIT INT TERM
(cd "$ROOT/services/indexer" && POLL_MS=1000 RECONCILE_EVERY=30 node --import tsx src/main.ts >/tmp/oc-indexer.log 2>&1) &
(cd "$ROOT/services/api" && NETWORK=localnet PORT=8080 HOST=0.0.0.0 PROMISE_SIGNER="${PROMISE_SIGNER:-}" node --import tsx src/main.ts >/tmp/oc-api.log 2>&1) &
# Trust layer (optional): the promiser signs and grades bands for the local validator's crosses; the premium
# monitor measures real mainnet liquidity regardless of the local cluster.
if [ -n "${PROMISER_KEYPAIR:-}" ]; then
  (cd "$ROOT/services/promiser" && NETWORK=localnet PROMISE_KEYPAIR="$PROMISER_KEYPAIR" ROUND_MS=3000 ANCHOR_EVERY_MS=15000 node --import tsx src/main.ts >/tmp/oc-promiser.log 2>&1) &
fi
if [ -n "${PREMIUM_TICKERS:-}" ]; then
  (cd "$ROOT/services/premium" && NETWORK=mainnet-beta RPC_URL=https://api.mainnet-beta.solana.com TICKERS="$PREMIUM_TICKERS" ROUND_MS=60000 node --import tsx src/main.ts >/tmp/oc-premium.log 2>&1) &
fi
(cd "$ROOT/apps/web" && NEXT_PUBLIC_API_URL=http://localhost:8080 NEXT_PUBLIC_RPC_URL=$RPC_URL NEXT_PUBLIC_CHAIN=solana:localnet npx next build >/tmp/oc-web-build.log 2>&1 \
  && NEXT_PUBLIC_API_URL=http://localhost:8080 npx next start -p 3000 >/tmp/oc-web.log 2>&1) &
wait
