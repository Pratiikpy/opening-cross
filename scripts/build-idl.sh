#!/bin/sh
# Builds a program's IDL the way `anchor idl build` does (resolution on, so PDA seeds and relations are present),
# without needing the anchor binary: the same cargo test, assembled by scripts/idl-assemble.mjs.
#   sh scripts/build-idl.sh cross_mandate packages/cross-mandate-client/idl/cross_mandate.json
# Checked against the committed IDL of cross_calendar: byte-identical.
set -eu
cd "$(dirname "$0")/.."
program=$1
out=$2
raw=$(mktemp)
(cd "programs/$program" && ANCHOR_IDL_BUILD_RESOLUTION=TRUE ANCHOR_IDL_BUILD_SKIP_LINT=TRUE \
  cargo test --release --features idl-build __anchor_private_print_idl -- --show-output --quiet >"$raw" 2>&1) || { tail -30 "$raw"; rm -f "$raw"; exit 1; }
node scripts/idl-assemble.mjs "$raw" "$out"
rm -f "$raw"
