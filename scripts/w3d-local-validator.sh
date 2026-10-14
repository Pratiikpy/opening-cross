#!/bin/sh
# Starts a local validator with the programs a Wave 3D proof needs, loaded from target/deploy at the addresses they declare, plus
# Meteora's DAMM v2 from tests/fixtures (fetch it with tests/fixtures/fetch.sh). The ledger is thrown away on every start.
#
#   sh scripts/w3d-local-validator.sh &          # RPC on http://127.0.0.1:8899
#   RPC_URL=http://127.0.0.1:8899 pnpm --filter @opening-cross/devnet-proofs dp:w3d
#
# Run it inside WSL (or any Linux) with the Solana CLI 4.0.x on the PATH. Nothing here touches devnet or a key.
set -eu
cd "$(dirname "$0")/.."
LEDGER=${LEDGER:-/tmp/oc-w3d-ledger}
DEPLOY_DIR=${DEPLOY_DIR:-target/deploy}
command -v solana-test-validator >/dev/null || { echo "solana-test-validator not found" >&2; exit 2; }

args=""
for name in cross_core cross_gate cross_settle cross_mandate cross_conviction cross_basket cross_listing cross_bounty cross_backing cross_graduate; do
  so=$DEPLOY_DIR/$name.so
  [ -f "$so" ] || { echo "missing $so: build it first (sh scripts/build-programs.sh)" >&2; exit 2; }
  # The address is the one the program declares; Anchor.toml lists only what is deployed.
  id=$(sed -n 's/^declare_id!("\(.*\)");/\1/p' "programs/$name/src/lib.rs" | head -1 | tr -d '\r')
  args="$args --bpf-program $id $so"
done
if [ -f tests/fixtures/cp_amm.so ]; then
  args="$args --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG tests/fixtures/cp_amm.so"
fi
# shellcheck disable=SC2086
exec solana-test-validator --reset --ledger "$LEDGER" --quiet $args
