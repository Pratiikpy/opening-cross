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
if [ "${MODE:-flow}" = trust ]; then
  # Trust layer: a promiser key funded on the local validator, and the premium monitor on a few real tickers.
  "$AGAVE_BIN/solana-keygen" new --no-bip39-passphrase --silent --force -o /tmp/oc-promiser.json >/dev/null
  export PROMISER_KEYPAIR=/tmp/oc-promiser.json
  PROMISE_SIGNER=$("$AGAVE_BIN/solana-keygen" pubkey /tmp/oc-promiser.json)
  export PROMISE_SIGNER
  "$AGAVE_BIN/solana" -u http://127.0.0.1:8899 airdrop 10 "$PROMISE_SIGNER" >/dev/null
  export PREMIUM_TICKERS=${PREMIUM_TICKERS:-TSLA,NVDA,AAPL,GOOGL,META,AMZN,COIN,HOOD,MSTR}
fi
sh "$ROOT/tests/e2e/run-stack.sh" &
until curl -s -o /dev/null http://localhost:3000/ && curl -s -o /dev/null http://localhost:8080/v1/health; do sleep 2; done
(cd "$ROOT/tests/e2e" && CALL_SECS=${CALL_SECS:-240} REVEAL_SECS=${REVEAL_SECS:-120} OUT=/tmp/oc-e2e.json node --import tsx src/seed.ts >/tmp/oc-seed.log)
cd "$ROOT/apps/web"
if [ "${MODE:-flow}" = trust ]; then
  OPEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/oc-e2e.json','utf8')).crosses.open)")
  TRUST_OUT="${TRUST_OUT:-$ROOT/docs/evidence/screens/trust}"
  (cd "$ROOT/tests/e2e" && node --import tsx src/trust-seed.ts) >/tmp/oc-trust-seed.log 2>&1
  # A band is signed once the book crosses.
  for i in $(seq 1 40); do curl -sf "http://localhost:8080/v1/crosses/$OPEN/promise" >/tmp/oc-promise.json && break; sleep 3; done
  PID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/oc-promise.json','utf8')).promise.id)")
  # The premium monitor needs one full round.
  for i in $(seq 1 100); do N=$(curl -sf http://localhost:8080/v1/premium/summary | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).coverage.rounds))" 2>/dev/null || echo 0); [ "$N" -ge 1 ] && break; sleep 3; done
  cd "$ROOT/apps/web"
  SEED=/tmp/oc-e2e.json PHASE=open OUT="$TRUST_OUT" node e2e/trust-flow.mjs >/tmp/oc-flow.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow.log || echo FLOW-FAILED >>/tmp/oc-flow.log
  # A stranger checks the promise by following the published instruction, with the book and the chain.
  (cd "$ROOT" && pnpm --filter @opening-cross/promises verify "http://localhost:8080/v1/promises/$PID" --signer "$PROMISE_SIGNER" --inputs "http://localhost:8080/v1/promises/$PID/inputs") >/tmp/oc-verify-open.log 2>&1 || echo VERIFY-OPEN-FAILED >>/tmp/oc-verify-open.log
  (cd "$ROOT/tests/e2e" && node --import tsx src/settle-open.ts) >/tmp/oc-settle.log 2>&1
  for i in $(seq 1 40); do curl -sf "http://localhost:8080/v1/promises/$PID" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).grade?.status==='SCORED'?0:1))" && break; sleep 3; done
  SEED=/tmp/oc-e2e.json PHASE=settled OUT="$TRUST_OUT" node e2e/trust-flow.mjs >/tmp/oc-flow-settled.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow-settled.log || echo FLOW-FAILED >>/tmp/oc-flow-settled.log
  (cd "$ROOT" && pnpm --filter @opening-cross/promises verify "http://localhost:8080/v1/promises/$PID" --signer "$PROMISE_SIGNER" --inputs "http://localhost:8080/v1/promises/$PID/inputs" --rpc http://127.0.0.1:8899) >/tmp/oc-verify-settled.log 2>&1 || echo VERIFY-SETTLED-FAILED >>/tmp/oc-verify-settled.log
  exit 0
fi
if [ "${MODE:-flow}" = issuer ]; then
  SEED=/tmp/oc-e2e.json OUT="${OUT:-$ROOT/docs/evidence/screens/w4}" node e2e/issuer-flow.mjs >/tmp/oc-flow.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow.log || echo FLOW-FAILED >>/tmp/oc-flow.log
  exit 0
fi
if [ "${MODE:-flow}" = visual ]; then
  OPEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/oc-e2e.json','utf8')).crosses.open)")
  ROUTES="/,/crosses,/crosses/$OPEN,/issue,/developers,/status" OUT="${OUT:-$ROOT/docs/evidence/screens}" node e2e/visual.mjs >/tmp/oc-flow.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow.log || echo FLOW-FAILED >>/tmp/oc-flow.log
  exit 0
fi
SEED=/tmp/oc-e2e.json OUT=${OUT:-"$ROOT/docs/evidence/screens/w3"} node e2e/investor-flow.mjs >/tmp/oc-flow.log 2>&1 && echo FLOW-OK >>/tmp/oc-flow.log || echo FLOW-FAILED >>/tmp/oc-flow.log
