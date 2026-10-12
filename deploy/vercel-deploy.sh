#!/bin/sh
# Deploys apps/web to the Vercel project "opening-bell". The repository is not uploaded whole (it holds research clones and
# program builds, far over Vercel's 15 000-file limit): this stages the pnpm workspace files the web build needs, links
# the staging directory to the project, and runs `vercel deploy` there. The project's Root Directory is apps/web.
#   NEXT_PUBLIC_* values come from the Vercel project's environment (vercel env ls); pass --prod for production.
#   sh deploy/vercel-deploy.sh --prod
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/.vercel/project.json" ] || { echo "run 'vercel link --project opening-bell' in $ROOT first" >&2; exit 2; }
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cd "$ROOT"
git ls-files -co --exclude-standard -z -- package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json packages services tests apps/web | tar --null -cf - -T - | tar -xf - -C "$STAGE"
mkdir -p "$STAGE/.vercel" && cp .vercel/project.json "$STAGE/.vercel/project.json"
cd "$STAGE"
vercel deploy --yes "$@"
