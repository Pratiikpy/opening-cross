'use client';

// The issuer's settle path: what GET /v1/crosses/:address/settlement serves about a cross's venue, partner payouts and greenshoe, and the one
// signature the wallet cannot give (the fresh keypair of a greenshoe bid's limit order). The requests themselves are the W3A routes of
// `cross_settle` (POST /v1/tx/claim-partner-fee, ... /finish-greenshoe).
import { type Transaction, generateKeyPair, getAddressFromPublicKey, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from '@solana/kit';
import { apiRead } from './issuer-data';

export type SettlementRead = {
  cross: string;
  venue: { venue: 'dbc' | 'damm_v2' | 'dlmm' | 'raydium_cpmm'; pool: string | null; clearing_price: string | null; detail: Record<string, unknown> | null; slot: string } | null;
  partner: { fee_base: string; fee_quote: string; fee_claims: number; surplus_withdrawn: string; migration_fee: string; pool_creation_lamports: string; pol_token_a: string; pol_token_b: string; pol_claims: number } | null;
  greenshoe: {
    greenshoe: string;
    budget: string;
    start_ts: string;
    expires_ts: string;
    bids: { level: number; binId: number; amount: string; limitOrder: string }[];
    settled_levels: number[];
    finished: boolean;
    burned: string | null;
    returned: string | null;
    expired: boolean;
    onChain: { deployed: string; finished: boolean; levelSettled: boolean[]; bins: number[]; amounts: string[]; orders: string[]; expiresTs: string; periodSecs: string; periodCap: string } | null;
  } | null;
  events: { name: string; slot: string; time: string | null; signature: string }[];
  note?: string;
};

export const loadSettlement = (cross: string) => apiRead<SettlementRead>(`/v1/crosses/${cross}/settlement`);

export const VENUE_NAME: Record<string, string> = { dbc: 'Meteora DBC continuation', damm_v2: 'Meteora DAMM v2 pool', dlmm: 'Meteora DLMM pair', raydium_cpmm: 'Raydium CPMM pool' };

export type FreshKey = { address: string; keyPair: CryptoKeyPair };
/** A new keypair for a limit order account. It lives in memory for the one action; it holds nothing and is never stored. */
export async function freshKey(): Promise<FreshKey> {
  const keyPair = await generateKeyPair();
  return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
}

/** Adds the fresh keypair's signature to an unsigned transaction, leaving the wallet's slot empty for the wallet. */
export async function cosign(wire: Uint8Array, key: FreshKey): Promise<Uint8Array> {
  const tx: Transaction = getTransactionDecoder().decode(wire);
  const signed = await partiallySignTransaction([key.keyPair], tx);
  return new Uint8Array(getTransactionEncoder().encode(signed));
}

/** The levels a greenshoe has (three), numbered as the program numbers them. */
export const GREENSHOE_LEVELS = [0, 1, 2] as const;
