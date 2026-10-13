'use client';

// The issuer board from the browser: publishing a wallet-signed record (prepare, sign the message in the wallet, submit) and the
// shapes the board's endpoints return. Integers arrive as decimal strings and stay strings until they are formatted.
import { type Result, apiSend } from './issuer-data';
import { formatAtoms } from './units';
import type { Row } from './issuer-wizard';

/** Signs a UTF-8 message with the connected wallet and returns the 64-byte signature as lowercase hex. */
export type MessageSigner = (message: string) => Promise<string>;

export type Kind = 'draft' | 'softcommit' | 'application' | 'decision' | 'question' | 'answer';

export type StoredRecord = { id: string; kind: Kind; signer: string; subject: string | null; issuedAt: number; body: Record<string, unknown>; signature: string };

/** Prepares a record on the server, has the wallet sign it, and submits it. The wallet is shown the exact message: a domain line and the record's id. */
export async function publishRecord(sign: MessageSigner, signer: string, kind: Kind, body: Record<string, unknown>): Promise<Result<{ duplicate: boolean; record: StoredRecord }>> {
  const prep = await apiSend<{ record: unknown; id: string; message: string }>('/v1/issuer/records/prepare', { kind, signer, body });
  if (!prep.ok) return prep;
  let signature: string;
  try {
    signature = await sign(prep.data.message);
  } catch (e) {
    return { ok: false, error: e instanceof Error && /reject|cancel|denied/i.test(e.message) ? 'You declined in your wallet. Nothing was published.' : `Your wallet could not sign: ${e instanceof Error ? e.message : String(e)}` };
  }
  return apiSend<{ duplicate: boolean; record: StoredRecord }>('/v1/issuer/records', { record: prep.data.record, signature });
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export type DemandMap = {
  id: string;
  status: 'not-verified';
  signer: string;
  issuedAt: number;
  draft: { title: string; summary: string; baseMint: string | null; quoteMint: string | null; baseDecimals: number; quoteDecimals: number; minPrice: string; tick: string; ticks: number; offered: string; supplyMode: 'mint' | 'escrow' };
  grid: { minPrice: string; tick: string; ticks: number; quoteDecimals: number; baseDecimals: number } | null;
  commits: { wallets: number; totalBudget: string; totalTokens: string };
  levels: { index: number; price: string; tokens: string; budget: string; wallets: number }[];
  byTrackRecord: Record<'filled-before' | 'bid-before' | 'no-history', { wallets: number; tokens: string }>;
  notCollected: string[];
  note: string;
};

/** Soft commits as simulator demand rows. Refuses a draft whose decimals differ from the tokens the wizard read, since the prices would not mean the same thing. */
export function demandRows(m: DemandMap, baseDecimals: number | null, quoteDecimals: number | null): Row[] | string {
  if (baseDecimals === null || quoteDecimals === null) return 'Check both tokens first, so the draft’s prices can be compared with yours.';
  if (m.draft.baseDecimals !== baseDecimals || m.draft.quoteDecimals !== quoteDecimals) return `The draft uses ${m.draft.baseDecimals}-decimal tokens priced in ${m.draft.quoteDecimals}-decimal quote, and yours are ${baseDecimals} and ${quoteDecimals}: its prices cannot be used here.`;
  return m.levels.map((l) => ({ price: formatAtoms(BigInt(l.price), quoteDecimals).replace(/,/g, ''), quantity: formatAtoms(BigInt(l.tokens), baseDecimals).replace(/,/g, '') }));
}

export type QaThread = {
  subject: string;
  subjectKind: 'cross' | 'treasury';
  owner: string;
  overdueAfterSecs: number;
  asOf: number;
  questions: (StoredRecord & { state: 'answered' | 'requested' | 'overdue'; answer: StoredRecord | null })[];
};

export type ApplicationView = { application: StoredRecord; decision: StoredRecord | null; status: 'submitted' | 'accepted' | 'changes-requested' | 'declined'; curatorsConfigured: number };
