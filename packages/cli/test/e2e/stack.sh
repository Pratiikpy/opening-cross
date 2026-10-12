#!/bin/bash
# A throwaway Opening Cross stack on private ports: a local validator with the current programs, the indexer and the API on a scratch
# Postgres database. Only the processes it starts are ever signalled (their PIDs are written to $STATE/pids).
#
#   stack.sh start    # waits until the validator, the indexer and the API answer
#   stack.sh stop     # kills exactly those processes and removes the ledger
#
# Environment (defaults are this workstream's ports): AGAVE_BIN, DATABASE_URL (a scratch database it may wipe), RPC_PORT=8960, API_PORT=8460,
# PROGRAMS (directory with cross_core.so and cross_gate.so; default target/deploy), STATE=/tmp/oc-s1.
set -u
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
STATE=${STATE:-/tmp/oc-s1}
RPC_PORT=${RPC_PORT:-8960}
API_PORT=${API_PORT:-8460}
PROGRAMS=${PROGRAMS:-$ROOT/target/deploy}
AGAVE_BIN=${AGAVE_BIN:-$HOME/agave-4.0.2/solana-release/bin}
export PATH="$AGAVE_BIN:$PATH"
CORE=F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ
GATE=2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr

stop() {
  if [ -f "$STATE/pids" ]; then
    while read -r pid; do
      [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done < "$STATE/pids"
    sleep 2
    while read -r pid; do
      [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
    done < "$STATE/pids"
    rm -f "$STATE/pids"
  fi
  rm -rf "$STATE/ledger"
}

start() {
  mkdir -p "$STATE"
  stop
  : > "$STATE/pids"
  solana-test-validator --ledger "$STATE/ledger" --reset --quiet --rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 2)) \
    --dynamic-port-range 18960-19060 --bind-address 127.0.0.1 \
    --bpf-program "$CORE" "$PROGRAMS/cross_core.so" --bpf-program "$GATE" "$PROGRAMS/cross_gate.so" > "$STATE/validator.log" 2>&1 &
  echo $! >> "$STATE/pids"
  for _ in $(seq 1 90); do
    solana -u "http://127.0.0.1:$RPC_PORT" cluster-version >/dev/null 2>&1 && break
    sleep 1
  done
  solana -u "http://127.0.0.1:$RPC_PORT" cluster-version >/dev/null 2>&1 || { echo "validator did not start"; tail -20 "$STATE/validator.log"; stop; exit 1; }
  if [ -n "${DATABASE_URL:-}" ]; then
    node -e "const pg=require('$ROOT/node_modules/.pnpm/node_modules/pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL});c.connect().then(()=>c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')).then(()=>c.end())" || { stop; exit 1; }
    (cd "$ROOT/services/indexer" && RPC_URL="http://127.0.0.1:$RPC_PORT" POLL_MS=1000 RECONCILE_EVERY=30 exec node --import tsx src/main.ts > "$STATE/indexer.log" 2>&1) &
    echo $! >> "$STATE/pids"
    (cd "$ROOT/services/api" && RPC_URL="http://127.0.0.1:$RPC_PORT" NETWORK=localnet PORT="$API_PORT" HOST=127.0.0.1 NOTIFIER=0 exec node --import tsx src/main.ts > "$STATE/api.log" 2>&1) &
    echo $! >> "$STATE/pids"
    for _ in $(seq 1 90); do
      curl -sf "http://127.0.0.1:$API_PORT/v1/health" >/dev/null 2>&1 && break
      sleep 1
    done
    curl -sf "http://127.0.0.1:$API_PORT/v1/health" >/dev/null 2>&1 || { echo "API did not start"; tail -20 "$STATE/api.log"; stop; exit 1; }
  fi
  echo "stack up: rpc http://127.0.0.1:$RPC_PORT${DATABASE_URL:+ api http://127.0.0.1:$API_PORT}"
}

case "${1:-}" in
  start) start ;;
  stop) stop; echo "stack stopped" ;;
  *) echo "usage: stack.sh start|stop"; exit 2 ;;
esac
