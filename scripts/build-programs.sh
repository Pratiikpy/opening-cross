#!/bin/sh
# Builds every on-chain program to target/deploy with cargo build-sbf (Agave 4.0.x).
set -eu
cd "$(dirname "$0")/.."
for p in programs/cross_gate programs/cross_calendar programs/cross_core programs/cross_settle examples/venue; do
  (cd "$p" && cargo build-sbf)
done
