#!/usr/bin/env sh
# Dumps the third-party programs the LiteSVM tests load, straight from mainnet. They are not
# committed: Meteora's programs are under a non-commercial licence and must not be redistributed.
set -eu
dir=$(dirname "$0")
solana program dump -u "${RPC_URL:-mainnet-beta}" dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$dir/dynamic_bonding_curve.so"
solana program dump -u "${RPC_URL:-mainnet-beta}" cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$dir/cp_amm.so"
solana program dump -u "${RPC_URL:-mainnet-beta}" LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo "$dir/lb_clmm.so"
solana program dump -u "${RPC_URL:-mainnet-beta}" CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C "$dir/raydium_cp_swap.so"
# Raydium-owned accounts CPMM pool creation reads: AMM config index 0 and the pool-fee receiver.
solana account -u "${RPC_URL:-mainnet-beta}" D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2 --output json -o "$dir/raydium_amm_config_0.json"
solana account -u "${RPC_URL:-mainnet-beta}" DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8 --output json -o "$dir/raydium_create_pool_fee.json"
solana program dump -u "${RPC_URL:-mainnet-beta}" 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG "$dir/solana_attestation_service.so"
