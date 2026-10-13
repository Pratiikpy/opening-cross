#!/bin/sh
# Batch 2: upgrade the devnet programs that changed (cross_core, treasury, cross_settle), compare each deployed program with
# its local build byte for byte, and run the devnet proofs, in this order. Nothing here touches a marketplace listing, a
# multisig or a mainnet cluster.
#
#   sh scripts/deploy-batch-2.sh              estimate only: sizes, extension and buffer rent, the balance needed, the balance held
#   sh scripts/deploy-batch-2.sh --execute    do it
#
# Run it inside WSL (or any Linux) at the repository root with the Solana CLI 4.0.x on the PATH (`solana --version`) and the
# operations key funded. Set RPC_URL to a dedicated devnet endpoint (docs/HUMAN_TASKS.md H26): the public one answers 429 to
# the burst of transactions a 1 MB upload makes. The binaries are the ones in target/deploy, built with
# `cargo build-sbf` (or scripts/verifiable-build.sh for the release); the script refuses to run if a binary is missing.
#
# Why it can be re-run: an upload goes to a buffer account whose keypair is kept under .keys/batch-2/, so an interrupted run
# resumes the same buffer. A program that already equals its local build is skipped. `solana program extend` is only called
# for the bytes the program account lacks.
#
# Cost (the numbers printed by the estimate, computed from the sizes and the cluster's rent rate):
#   - extension of the program account: permanent, paid once, rent for the extra bytes;
#   - the buffer: rent for the whole new binary, held during the upgrade and returned to the operations key when it lands;
#   - fees: a few thousand lamports per 1 KB upload transaction.
# The largest buffer goes first so the peak is reached once; the script checks the balance against the peak before it starts.
set -eu
cd "$(dirname "$0")/.."

CLUSTER=${RPC_URL:-devnet}
KEY=${OPERATOR_KEY:-.keys/opening-bell-devnet.json}
DEPLOY_DIR=${DEPLOY_DIR:-target/deploy}
STATE=.keys/batch-2
MODE=estimate
[ "${1:-}" = "--execute" ] && MODE=execute

# name:program id (the ids are the ones in Anchor.toml; the script checks them against it)
PROGRAMS="cross_core:F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ treasury:HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd cross_settle:2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ"

command -v solana >/dev/null || { echo "solana CLI not found" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 2; }
[ -f "$KEY" ] || { echo "operations key not found at $KEY" >&2; exit 2; }
operator=$(solana-keygen pubkey "$KEY")

for entry in $PROGRAMS; do
  name=${entry%%:*}
  id=${entry#*:}
  grep -q "^$name = \"$id\"" Anchor.toml || { echo "Anchor.toml does not list $name = $id" >&2; exit 2; }
  [ -f "$DEPLOY_DIR/$name.so" ] || { echo "missing $DEPLOY_DIR/$name.so: build it first (cargo build-sbf in programs/$name)" >&2; exit 2; }
done

rent() { solana rent "$1" --lamports -u "$CLUSTER" | sed -n 's/^Rent-exempt minimum: \([0-9]*\) lamports.*/\1/p'; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
size_of() { wc -c <"$1" | tr -d ' '; }
sol() { python3 -c "print(f'{$1/1e9:.3f}')"; }

# ---------------------------------------------------------------- estimate
echo "operations key: $operator"
echo "cluster:        $CLUSTER"
echo
printf '%-13s %10s %10s %10s %14s %14s  %s\n' program local on-chain extend extend-SOL buffer-SOL state
total_extend=0
peak=0
order=""
plan=""
for entry in $PROGRAMS; do
  name=${entry%%:*}
  id=${entry#*:}
  so=$DEPLOY_DIR/$name.so
  local_size=$(size_of "$so")
  info=$(solana program show "$id" -u "$CLUSTER" --output json)
  deployed_len=$(printf '%s' "$info" | field dataLen)
  authority=$(printf '%s' "$info" | field authority)
  [ "$authority" = "$operator" ] || { echo "upgrade authority of $name is $authority, not the operations key" >&2; exit 2; }
  tmp=$(mktemp)
  solana program dump "$id" "$tmp" -u "$CLUSTER" >/dev/null
  same=no
  if [ "$(head -c "$local_size" "$tmp" | sha256sum | cut -d' ' -f1)" = "$(sha256sum <"$so" | cut -d' ' -f1)" ]; then same=yes; fi
  rm -f "$tmp"
  extend=0
  [ "$local_size" -gt "$deployed_len" ] && extend=$((local_size - deployed_len))
  extend_rent=0
  [ "$extend" -gt 0 ] && extend_rent=$(rent "$extend")
  buffer_rent=$(rent $((local_size + 37)))
  state=upgrade
  [ "$same" = yes ] && state="current (skipped)"
  printf '%-13s %10s %10s %10s %14s %14s  %s\n' "$name" "$local_size" "$deployed_len" "$extend" "$(sol "$extend_rent")" "$(sol "$buffer_rent")" "$state"
  if [ "$same" = no ]; then
    # Largest buffer first: the peak need is then (its extension + its buffer) once.
    plan="$plan $buffer_rent:$name:$id:$extend"
    total_extend=$((total_extend + extend_rent))
  fi
done
plan=$(for p in $plan; do echo "$p"; done | sort -t: -k1,1 -nr)
cumulative=0
for p in $plan; do
  buffer_rent=${p%%:*}
  rest=${p#*:}
  name=${rest%%:*}
  rest=${rest#*:}
  extend=${rest#*:}
  extend_rent=0
  [ "$extend" -gt 0 ] && extend_rent=$(rent "$extend")
  need=$((cumulative + extend_rent + buffer_rent))
  [ "$need" -gt "$peak" ] && peak=$need
  cumulative=$((cumulative + extend_rent))
done
fees=20000000
proofs=500000000
need_total=$((peak + fees + proofs))
balance=$(solana balance "$operator" -u "$CLUSTER" | sed 's/ SOL//')
balance_lamports=$(python3 -c "print(int(round(float('$balance')*1e9)))")
echo
echo "permanent cost (extensions):      $(sol "$total_extend") SOL"
echo "peak need during the upgrades:    $(sol "$peak") SOL (extensions so far plus the largest buffer, which is returned)"
echo "fees and the proofs (allowance):  $(sol $((fees + proofs))) SOL"
echo "balance needed to start:          $(sol "$need_total") SOL"
echo "balance held:                     $balance SOL"
if [ "$balance_lamports" -lt "$need_total" ]; then
  echo "SHORT by $(sol $((need_total - balance_lamports))) SOL: fund $operator (docs/HUMAN_TASKS.md H27)"
  [ "$MODE" = execute ] && exit 1
fi
[ "$MODE" = execute ] || { echo; echo "estimate only; run with --execute to upgrade"; exit 0; }

# ---------------------------------------------------------------- upgrade, compare, in order
mkdir -p "$STATE"
for p in $plan; do
  rest=${p#*:}
  name=${rest%%:*}
  rest=${rest#*:}
  id=${rest%%:*}
  extend=${rest#*:}
  so=$DEPLOY_DIR/$name.so
  echo
  echo "== $name"
  if [ "$extend" -gt 0 ]; then
    echo "extending the program account by $extend bytes"
    solana program extend "$id" "$extend" -u "$CLUSTER" -k "$KEY"
  fi
  buffer_key=$STATE/$name-buffer.json
  [ -f "$buffer_key" ] || solana-keygen new --no-bip39-passphrase --silent -o "$buffer_key"
  buffer=$(solana-keygen pubkey "$buffer_key")
  echo "writing the binary to buffer $buffer"
  solana program write-buffer "$so" --buffer "$buffer_key" -u "$CLUSTER" -k "$KEY" --max-sign-attempts 20
  echo "upgrading $name"
  solana program upgrade "$buffer" "$id" -u "$CLUSTER" -k "$KEY" --upgrade-authority "$KEY"
  sh scripts/onchain-hash.sh "$id" "$so" "$CLUSTER"
  rm -f "$buffer_key"
done

echo
echo "== every program against its local build"
for entry in $PROGRAMS; do
  name=${entry%%:*}
  id=${entry#*:}
  sh scripts/onchain-hash.sh "$id" "$DEPLOY_DIR/$name.so" "$CLUSTER"
done

# ---------------------------------------------------------------- proofs (each writes docs/evidence/*.md; a failure stops the run)
echo
echo "== devnet proofs"
PROOFS=${PROOFS:-"dp:core dp:w2d-core dp:treasury-ext dp:dbc dp:damm dp:dlmm"}
for proof in $PROOFS; do
  echo "-- $proof"
  pnpm --filter @opening-cross/devnet-proofs "$proof"
done
echo
echo "The accounts that existed before the upgrade must still decode and verify: run the sweep."
pnpm --filter @opening-cross/devnet-proofs exec tsx src/verifier-sweep.ts
echo "batch 2 done"
