// Solana clusters in x402 are named by CAIP-2: `solana:` plus the first 32 characters of the genesis hash. The
// well-known values are listed for display and for refusing a payment aimed at the wrong cluster; the one a server uses
// is always read from its own RPC endpoint, so a local validator works without any entry here.
import { type Rpc, type SolanaRpcApi, createSolanaRpc } from '@solana/kit';
import { CAIP2_GENESIS_PREFIX_LENGTH } from './constants.js';

export type SvmRpc = Rpc<SolanaRpcApi>;

export const WELL_KNOWN_NETWORKS = {
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
} as const;

export const caip2FromGenesisHash = (genesisHash: string): string => `solana:${genesisHash.slice(0, CAIP2_GENESIS_PREFIX_LENGTH)}`;

export function createRpc(url: string): SvmRpc {
  return createSolanaRpc(url) as unknown as SvmRpc;
}

/** The CAIP-2 identifier of the cluster behind an RPC endpoint. */
export async function networkOf(rpc: SvmRpc): Promise<string> {
  return caip2FromGenesisHash(await rpc.getGenesisHash().send());
}
