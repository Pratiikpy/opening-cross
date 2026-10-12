#!/bin/sh
# Starts the indexer, API and promiser against the public devnet cluster and a Postgres at DATABASE_URL, logging to
# /tmp/dn-*.log. The promiser signs with a fresh keypair funded from FUNDER (default: .keys/devnet-promiser.json).
# Needs the Solana CLI on PATH. Stops everything on exit.
#   DATABASE_URL=postgres://postgres:oc@localhost:55432/oc_devnet sh tests/devnet/run-stack.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${DATABASE_URL:?set DATABASE_URL}"
export RPC_URL=${RPC_URL:-https://api.devnet.solana.com}
FUNDER=${FUNDER:-$ROOT/.keys/devnet-promiser.json}
KEYS=$ROOT/.keys/fork-d2
mkdir -p "$KEYS"
[ -f "$KEYS/promiser.json" ] || solana-keygen new --no-bip39-passphrase --silent -o "$KEYS/promiser.json" >/dev/null
PADDR=$(solana address -k "$KEYS/promiser.json")
if [ "$(solana balance "$PADDR" -u devnet | cut -d' ' -f1)" = "0" ]; then
  solana transfer --from "$FUNDER" --fee-payer "$FUNDER" "$PADDR" "${PROMISER_FUND:-0.15}" -u devnet --allow-unfunded-recipient
fi
echo "promiser $PADDR"
trap 'kill 0' EXIT INT TERM
(cd "$ROOT/services/indexer" && POLL_MS=8000 RECONCILE_EVERY=20 node --import tsx src/main.ts >/tmp/dn-indexer.log 2>&1) &
(cd "$ROOT/services/api" && NETWORK=devnet PORT=8080 HOST=0.0.0.0 PROMISE_SIGNER="$PADDR" node --import tsx src/main.ts >/tmp/dn-api.log 2>&1) &
(cd "$ROOT/services/promiser" && NETWORK=devnet PROMISE_KEYPAIR="$KEYS/promiser.json" ROUND_MS=15000 ANCHOR_EVERY_MS=90000 node --import tsx src/main.ts >/tmp/dn-promiser.log 2>&1) &
wait
