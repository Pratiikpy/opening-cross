#!/bin/sh
# Batch 3: first deployment of the seven programs added in Wave 3D (cross_mandate, cross_conviction, cross_basket,
# cross_listing, cross_bounty, cross_backing, cross_graduate), a byte-for-byte comparison of each with its local build, and the devnet
# proof. Nothing here touches a marketplace listing, a multisig or a mainnet cluster, and it does not touch the five
# programs that are already deployed (scripts/deploy-batch-2.sh upgrades those).
#
#   sh scripts/deploy-batch-3.sh              estimate only: sizes, rent, the balance needed, the balance held
#   sh scripts/deploy-batch-3.sh --execute    do it
#
# Run it inside WSL (or any Linux) at the repository root with the Solana CLI 4.0.x on the PATH and the operations key
# funded (docs/HUMAN_TASKS.md H27). Set RPC_URL to a dedicated devnet endpoint (H26): the public one answers 429 to the
# burst of transactions a 300 KB upload makes. The binaries are the ones in target/deploy, built with
# scripts/build-programs.sh (or scripts/verifiable-build.sh for the release); the script refuses to run if one is missing.
#
# Each program id is the public key of .keys/<name>-program.json (git-ignored) and must equal the `declare_id!` in the program's source.
# Anchor.toml lists only what is deployed (tests/core/test/agent-skill.test.ts and ocip-spec.test.ts hold the docs to it): after a
# successful run, add the seven ids to both of its sections, to docs/agent-skill/opening-cross/SKILL.md and to OCIP-1.
# Why it can be re-run: an upload goes to a buffer account whose keypair is kept under .keys/batch-3/, so an interrupted
# run resumes the same buffer; a program that is already deployed and equal to its local build is skipped.
#
# Cost (printed by the estimate, from the sizes and the cluster's rent rate):
#   - the program data account: permanent rent for the binary plus its 45-byte header, paid once;
#   - the buffer: rent for the whole binary, held during the deploy and returned to the operations key when it lands;
#   - fees: a few thousand lamports per 1 KB upload transaction.
# The largest buffer goes first so the peak is reached once; the script checks the balance against the peak before it starts.
set -eu
cd "$(dirname "$0")/.."

CLUSTER=${RPC_URL:-devnet}
KEY=${OPERATOR_KEY:-.keys/opening-bell-devnet.json}
DEPLOY_DIR=${DEPLOY_DIR:-target/deploy}
STATE=.keys/batch-3
MODE=estimate
[ "${1:-}" = "--execute" ] && MODE=execute

PROGRAMS="cross_mandate cross_conviction cross_basket cross_listing cross_bounty cross_backing cross_graduate"

command -v solana >/dev/null || { echo "solana CLI not found" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 2; }
[ -f "$KEY" ] || { echo "operations key not found at $KEY" >&2; exit 2; }
operator=$(solana-keygen pubkey "$KEY")

rent() { solana rent "$1" --lamports -u "$CLUSTER" | sed -n 's/^Rent-exempt minimum: \([0-9]*\) lamports.*/\1/p'; }
size_of() { wc -c <"$1" | tr -d ' '; }
sol() { python3 -c "print(f'{$1/1e9:.3f}')"; }

plan=""
printf '%-17s %10s %14s %14s  %s\n' program bytes program-SOL buffer-SOL state
for name in $PROGRAMS; do
  keyfile=.keys/$name-program.json
  so=$DEPLOY_DIR/$name.so
  [ -f "$keyfile" ] || { echo "missing program keypair $keyfile" >&2; exit 2; }
  [ -f "$so" ] || { echo "missing $so: build it first (sh scripts/build-programs.sh)" >&2; exit 2; }
  id=$(solana-keygen pubkey "$keyfile")
  declared=$(sed -n 's/^declare_id!("\(.*\)");/\1/p' "programs/$name/src/lib.rs" | head -1 | tr -d '\r')
  [ "$id" = "$declared" ] || { echo "programs/$name/src/lib.rs declares $declared but $keyfile is $id" >&2; exit 2; }
  size=$(size_of "$so")
  state=new
  if solana program show "$id" -u "$CLUSTER" >/dev/null 2>&1; then
    tmp=$(mktemp)
    solana program dump "$id" "$tmp" -u "$CLUSTER" >/dev/null
    if [ "$(head -c "$size" "$tmp" | sha256sum | cut -d' ' -f1)" = "$(sha256sum <"$so" | cut -d' ' -f1)" ]; then state="deployed, equal (skipped)"; else state="deployed, DIFFERENT (this script only creates; upgrade by hand)"; fi
    rm -f "$tmp"
  fi
  program_rent=$(rent $((size + 45)))
  buffer_rent=$(rent $((size + 37)))
  printf '%-17s %10s %14s %14s  %s\n' "$name" "$size" "$(sol "$program_rent")" "$(sol "$buffer_rent")" "$state"
  case "$state" in
    new) plan="$plan $buffer_rent:$program_rent:$name:$id" ;;
    *DIFFERENT*) echo "refusing to continue: $name is deployed with other bytes" >&2; exit 2 ;;
  esac
done
plan=$(for p in $plan; do echo "$p"; done | sort -t: -k1,1 -nr)
total=0
peak=0
for p in $plan; do
  buffer_rent=${p%%:*}
  rest=${p#*:}
  program_rent=${rest%%:*}
  need=$((total + program_rent + buffer_rent))
  [ "$need" -gt "$peak" ] && peak=$need
  total=$((total + program_rent))
done
fees=30000000
proofs=300000000
need_total=$((peak + fees + proofs))
balance=$(solana balance "$operator" -u "$CLUSTER" | sed 's/ SOL//')
balance_lamports=$(python3 -c "print(int(round(float('$balance')*1e9)))")
echo
echo "permanent cost (program accounts): $(sol "$total") SOL"
echo "peak need during the deploys:      $(sol "$peak") SOL (programs so far plus the largest buffer, which is returned)"
echo "fees and the proof (allowance):    $(sol $((fees + proofs))) SOL"
echo "balance needed to start:           $(sol "$need_total") SOL"
echo "balance held:                      $balance SOL ($operator)"
if [ "$balance_lamports" -lt "$need_total" ]; then
  echo "SHORT by $(sol $((need_total - balance_lamports))) SOL: fund $operator (docs/HUMAN_TASKS.md H27)"
  [ "$MODE" = execute ] && exit 1
fi
[ "$MODE" = execute ] || { echo; echo "estimate only; run with --execute to deploy"; exit 0; }

# ---------------------------------------------------------------- deploy, compare, in order
mkdir -p "$STATE"
for p in $plan; do
  rest=${p#*:}
  rest=${rest#*:}
  name=${rest%%:*}
  id=${rest#*:}
  so=$DEPLOY_DIR/$name.so
  echo
  echo "== $name ($id)"
  buffer_key=$STATE/$name-buffer.json
  [ -f "$buffer_key" ] || solana-keygen new --no-bip39-passphrase --silent -o "$buffer_key"
  echo "writing the binary to buffer $(solana-keygen pubkey "$buffer_key")"
  solana program write-buffer "$so" --buffer "$buffer_key" -u "$CLUSTER" -k "$KEY" --max-sign-attempts 20
  echo "deploying $name from the buffer"
  solana program deploy --buffer "$buffer_key" --program-id ".keys/$name-program.json" -u "$CLUSTER" -k "$KEY" --upgrade-authority "$KEY"
  sh scripts/onchain-hash.sh "$id" "$so" "$CLUSTER"
  rm -f "$buffer_key"
done

echo
echo "== every program against its local build"
for name in $PROGRAMS; do
  sh scripts/onchain-hash.sh "$(solana-keygen pubkey ".keys/$name-program.json")" "$DEPLOY_DIR/$name.so" "$CLUSTER"
done

# ---------------------------------------------------------------- proof (writes docs/evidence/W3D-programs-devnet.md; a failure stops the run)
echo
echo "== devnet proof"
PROOFS=${PROOFS:-"dp:w3d"}
for proof in $PROOFS; do
  echo "-- $proof"
  pnpm --filter @opening-cross/devnet-proofs "$proof"
done
echo "batch 3 done"
