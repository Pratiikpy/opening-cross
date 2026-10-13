'use client';

// Reads for the issuer pages, all from the Opening Cross API. A read that fails returns the reason; no page shows a number it did not read.
import { PROPOSED_FEES } from './issuer-fees';
import { API_URL, type Result } from './api';
import type { Disclosure } from './treasury';

export type { Result };

async function read<T>(path: string): Promise<Result<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `The API answered HTTP ${res.status}.` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'The Opening Cross API could not be reached.' };
  }
}

async function send<T>(path: string, payload: unknown): Promise<Result<T>> {
  try {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `The API answered HTTP ${res.status}.` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, error: 'The Opening Cross API could not be reached.' };
  }
}

export { read as apiRead, send as apiSend };

export type CrossRow = {
  address: string;
  state: 'Live' | 'Cleared' | 'NoPrint' | 'Finalized';
  disclosure: 'sealed' | 'open';
  supplyMode: 'escrow' | 'mint' | 'deferred-mint';
  orders: number;
  openTs: string;
  closeTs: string;
  revealEndTs: string;
  creator: string;
  baseMint: string;
  quoteMint: string;
  clearingPrice: string | null;
  matched: string | null;
};

export const crossSummary = (limit = 1000) => read<{ count: number; crosses: CrossRow[] }>(`/v1/crosses/summary?limit=${limit}`);

export type FeeSchedule = { source: 'chain' | 'proposed'; launch: number; reopen: number; tender: number; recurring: number };

/** The protocol fee per cross kind. From the chain through the API when it serves it; otherwise the schedule proposed in ADR-0010, named as such. */
export async function protocolFees(): Promise<FeeSchedule> {
  const r = await read<{ feeBps: Record<'launch' | 'reopen' | 'tender' | 'recurring', number> }>('/v1/issuer/protocol');
  if (r.ok && r.data.feeBps) return { source: 'chain', ...r.data.feeBps };
  return { source: 'proposed', ...PROPOSED_FEES };
}

export type TreasuryRow = {
  address: string;
  coinMint: string;
  authority: string;
  chain: 'read' | 'unavailable' | 'not-a-treasury';
  state?: 'Active' | 'Liquidating';
  quoteMint?: string;
  quoteDecimals?: number;
  allowance?: string;
  periodSecs?: string;
  graceSecs?: string;
  vaultBalance?: string | null;
  spend?: { allowanceRemaining: string; periodEnd: string };
  lapsedSince?: string | null;
  disclosure: Disclosure;
};

export const treasuries = () => read<{ treasuries: TreasuryRow[] }>('/v1/treasuries?limit=200');
