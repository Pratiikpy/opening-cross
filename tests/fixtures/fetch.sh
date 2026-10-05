#!/usr/bin/env sh
# Dumps the third-party programs the LiteSVM tests load, straight from mainnet. They are not
# committed: Meteora's programs are under a non-commercial licence and must not be redistributed.
set -eu
dir=$(dirname "$0")
solana program dump -u "${RPC_URL:-mainnet-beta}" dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$dir/dynamic_bonding_curve.so"
solana program dump -u "${RPC_URL:-mainnet-beta}" cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$dir/cp_amm.so"
