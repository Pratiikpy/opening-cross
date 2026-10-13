#!/usr/bin/env sh
# Mainnet accounts and programs the cross_settle adapter tests (fork S, ADR-0480 to 0499) load. Not committed: Meteora's programs
# are under a non-commercial licence and must not be redistributed (see fetch.sh).
set -eu
dir=$(dirname "$0")
rpc=${RPC_URL:-mainnet-beta}
# DAMM v2 pool configs that DBC migrates into, one per migration fee option (SDK constant DAMM_V2_MIGRATION_FEE_ADDRESS).
i=0
for a in 7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd 2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp 2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck; do
  solana account -u "$rpc" "$a" --output json -o "$dir/damm_v2_migration_config_$i.json" >/dev/null
  i=$((i + 1))
done
