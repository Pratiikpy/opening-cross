#!/bin/sh
# Full end-to-end run from nothing: fresh local validator with the current programs, fresh
# database, indexer + API + web app, seed, then the browser flows. Linux only (LiteSVM-free, but
# the validator and Playwright run here). Requires AGAVE_BIN (Agave 4.0.x bin dir), DATABASE_URL
# and CHROME (a Chromium binary).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${AGAVE_BIN:?}" "${DATABASE_URL:?}" "${CHROME:?}"
LOGS="$ROOT/target/e2e-logs"
mkdir -p "$LOGS"
trap 'cp /tmp/oc-*.log /tmp/oc-e2e.json "$LOGS"/ 2>/dev/null; kill 0 2>/dev/null' EXIT INT TERM
# Optional: a Postgres container to start first (docker name).
if [ -n "${PG_CONTAINER:-}" ]; then docker start "$PG_CONTAINER" >/dev/null; until docker exec "$PG_CONTAINER" pg_isready -q; do sleep 1; done; fi
rm -rf /tmp/oc-ledger
"$AGAVE_BIN/solana-test-validator" --ledger /tmp/oc-ledger --reset --quiet --rpc-port 8899 \
  --bpf-program F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ "$ROOT/target/deploy/cross_core.so" \
  --bpf-program 2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr "$ROOT/target/deploy/cross_gate.so" >/tmp/oc-validator.log 2>&1 &
until "$AGAVE_BIN/solana" -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; do sleep 1; done
node -e "const pg=require('$ROOT/node_modules/.pnpm/node_modules/pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')).then(()=>c.end())"
sh "$ROOT/tests/e2e/run-stack.sh" &
until curl -s -o /dev/null http://localhost:3000/ && curl -s -o /dev/null http://localhost:8080/v1/health; do sleep 2; done
(cd "$ROOT/tests/e2e" && CALL_SECS=${CALL_SECS:-240} REVEAL_SECS=${REVEAL_SECS:-120} OUT=/tmp/oc-e2e.json node --import tsx src/seed.ts >/tmp/oc-seed.log)
cd "$ROOT/apps/web"
if [ "${MODE:-flow}" = issuer ]; then
  SEED=/tmp/oc-e2e.json OUT="$ROOT/docs/evidence/screens/w4" node e2e/issuer-flow.mjs >/tmp/oc-flow.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow.log || echo FLOW-FAILED >>/tmp/oc-flow.log
  exit 0
fi
if [ "${MODE:-flow}" = visual ]; then
  OPEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/oc-e2e.json','utf8')).crosses.open)")
  ROUTES="/,/crosses,/crosses/$OPEN,/issue,/developers,/status" OUT="$ROOT/docs/evidence/screens" node e2e/visual.mjs >/tmp/oc-flow.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow.log || echo FLOW-FAILED >>/tmp/oc-flow.log
  exit 0
fi
SEED=/tmp/oc-e2e.json OUT=${OUT:-"$ROOT/docs/evidence/screens/w3"} node e2e/investor-flow.mjs >/tmp/oc-flow.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow.log || echo FLOW-FAILED >>/tmp/oc-flow.log
