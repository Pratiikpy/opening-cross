#!/bin/sh
# Packs the publishable packages, installs ONLY those tarballs into a fresh copy of this project
# outside the workspace, typechecks against their published types and runs the quickstart.
# Usage, from the repository root after building the programs: sh examples/ts-quickstart/run.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/target/packages"
WORK=$(mktemp -d)
rm -rf "$OUT" && mkdir -p "$OUT"
for p in cross-core-client cross-gate-client verifier sdk; do
  (cd "$ROOT/packages/$p" && pnpm run build >/dev/null && pnpm pack --pack-destination "$OUT" >/dev/null)
done
cp "$ROOT/examples/ts-quickstart/package.json" "$ROOT/examples/ts-quickstart/tsconfig.json" "$ROOT/examples/ts-quickstart/quickstart.ts" "$WORK/"
cd "$WORK"
npm install --no-audit --no-fund --silent
npm install --no-audit --no-fund --silent "$OUT"/*.tgz
npx tsc --noEmit
CROSS_CORE_SO="$ROOT/target/deploy/cross_core.so" npx tsx quickstart.ts
