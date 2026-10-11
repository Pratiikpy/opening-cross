#!/bin/sh
# Compares the program a cluster is running with a local build, byte for byte.
#
#   scripts/onchain-hash.sh <program-id> <path-to.so> [rpc-url-or-moniker]
#
# `solana program dump` returns the whole ProgramData account, which is zero-padded to the size the program was
# allocated with. The padding is stripped to the length of the local build before hashing, and the hashes of both
# files are printed. Exit status 0 only when they are identical.
set -eu
[ $# -ge 2 ] || { echo "usage: $0 <program-id> <path-to.so> [rpc-url-or-moniker]" >&2; exit 2; }
id=$1
so=$2
url=${3:-devnet}
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
solana program dump "$id" "$tmp" -u "$url" >/dev/null
size=$(wc -c <"$so")
local_hash=$(sha256sum "$so" | cut -d' ' -f1)
chain_hash=$(head -c "$size" "$tmp" | sha256sum | cut -d' ' -f1)
echo "program   $id ($url)"
echo "local     $local_hash  ($size bytes)"
echo "on chain  $chain_hash  (first $size bytes of $(wc -c <"$tmp"))"
if [ "$local_hash" = "$chain_hash" ]; then echo "MATCH"; else echo "DIFFERENT"; exit 1; fi
