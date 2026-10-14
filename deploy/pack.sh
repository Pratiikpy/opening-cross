#!/bin/sh
# Packs the files the backend images need (tracked and untracked-but-not-ignored, current working-tree contents) into a
# tarball. Secrets are ignored by .gitignore and therefore never included.
#   sh deploy/pack.sh /tmp/opening-bell.tar.gz
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:?usage: pack.sh <output.tar.gz>}
cd "$ROOT"
# The files of the last commit, not of the working tree: what is deployed is what the repository holds.
git archive --format=tar HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages services tests examples apps/web/package.json deploy \
  | gzip > "$OUT"
echo "packed $(tar -tzf "$OUT" | wc -l) files into $OUT"
