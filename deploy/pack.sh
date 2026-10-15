#!/bin/sh
# Packs the files the backend images need (tracked and untracked-but-not-ignored, current working-tree contents) into a
# tarball. Secrets are ignored by .gitignore and therefore never included.
#   sh deploy/pack.sh /tmp/opening-bell.tar.gz
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:?usage: pack.sh <output.tar.gz>}
cd "$ROOT"
# The files of the last commit, not of the working tree: what is deployed is what the repository holds. Besides the code, the docs service gets the Markdown documents
# (the evidence folders hold far more in screenshots and data than the service reads) and a .git/HEAD naming the commit, so every answer it gives says what it was read at.
git archive --format=tar --add-virtual-file=".git/HEAD:$(git rev-parse HEAD)" HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages services tests examples apps/web/package.json deploy README.md ':(glob)docs/**/*.md' \
  | gzip > "$OUT"
echo "packed $(tar -tzf "$OUT" | wc -l) files into $OUT"
