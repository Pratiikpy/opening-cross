#!/bin/bash
# Runs the CLI lifecycle against a fresh local stack, holding the machine-wide heavy lock for the whole run, and always tears the stack down.
#   bash packages/cli/test/e2e/run.sh        (Linux or WSL; needs the Agave binaries and a scratch Postgres database)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
source ~/.nvm/nvm.sh >/dev/null 2>&1 || true
export DATABASE_URL=${DATABASE_URL:-postgres://postgres:oc@localhost:55432/oc_s1}
export RPC_URL=http://127.0.0.1:${RPC_PORT:-8960}
export OC_API=http://127.0.0.1:${API_PORT:-8460}
export OUT=${OUT:-$ROOT/target/s1-cli-lifecycle.json}
LOCK=${LOCK:-/tmp/oc-heavy.lock}
mkdir -p "$(dirname "$OUT")"
flock -w "${LOCK_WAIT:-14400}" "$LOCK" bash -c '
  trap "bash '"$HERE"'/stack.sh stop" EXIT
  bash '"$HERE"'/stack.sh start || exit 1
  cd '"$ROOT"'/packages/cli && node --import tsx test/e2e/lifecycle.ts
'
