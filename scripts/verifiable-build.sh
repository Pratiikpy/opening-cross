#!/bin/sh
# Deterministic builds of the on-chain programs in the pinned Docker image, from a clean git commit, so that anyone can
# rebuild the same bytes and compare them with what is deployed.
#
#   scripts/verifiable-build.sh [--ref <git-ref>] [program ...]
#
# Programs default to all protocol programs: the five deployed ones (cross_core cross_gate cross_settle cross_calendar treasury)
# and the six added in Wave 3D (cross_mandate cross_conviction cross_basket cross_listing cross_bounty cross_backing).
# Requires Docker and `solana-verify` 0.5.2 (`cargo install solana-verify --version 0.5.2 --locked`).
#
# The build runs on a `git archive` of the ref in a temporary directory, never on the working tree, so uncommitted
# changes cannot leak into a "verifiable" binary and `target/deploy` is left alone. Results land in
# `target/verifiable/<program>.so`, and `target/verifiable/hashes.txt` lists the commit and every executable hash.
#
# The image tag is the Agave version pinned in ADR-0001 (Agave 4.0.x, platform-tools v1.53).
set -eu
IMAGE=${VERIFIABLE_IMAGE:-solanafoundation/solana-verifiable-build:4.0.2}
ref=HEAD
if [ "${1:-}" = "--ref" ]; then
  ref=$2
  shift 2
fi
programs=${*:-cross_core cross_gate cross_settle cross_calendar treasury cross_mandate cross_conviction cross_basket cross_listing cross_bounty cross_backing}
root=$(cd "$(dirname "$0")/.." && pwd)
commit=$(git -C "$root" rev-parse "$ref")
work=$(mktemp -d)
# The build container writes as root, so a plain rm cannot always clean up; fall back to removing from inside it.
cleanup() {
  rm -rf "$work" 2>/dev/null || {
    docker run --rm -v "$work":/w --entrypoint rm "$IMAGE" -rf /w/target >/dev/null 2>&1 || true
    rm -rf "$work"
  }
}
trap cleanup EXIT
git -C "$root" archive "$commit" | tar -x -C "$work"
out="$root/target/verifiable"
mkdir -p "$out"
{
  echo "commit $commit"
  echo "image  $IMAGE"
} >"$out/hashes.txt"
for p in $programs; do
  echo "== building $p from $commit"
  solana-verify build --base-image "$IMAGE" --library-name "$p" "$work"
  cp "$work/target/deploy/$p.so" "$out/$p.so"
  echo "$(solana-verify get-executable-hash "$out/$p.so")  $p.so" >>"$out/hashes.txt"
done
cat "$out/hashes.txt"
