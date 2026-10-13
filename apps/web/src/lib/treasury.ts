// Types and formatting for the treasury pages. Every field comes from GET /v1/treasuries (services/api/src/routes/treasury.ts):
// 64-bit integers arrive as decimal strings and stay strings until they are formatted, so nothing is rounded on the way.
import { RPC_URL } from './config';
import { formatAtoms } from './units';

export type DisclosureState = 'current' | 'requested' | 'overdue' | 'closed' | 'unknown';

export type Disclosure = {
  state: DisclosureState;
  basis: 'last-update' | 'creation' | null;
  basisAt: number | null;
  requestedAt: number | null;
  overdueAt: number | null;
  updateCount: number;
  note: string;
};

export type SpendWindow = { periodStart: string; periodEnd: string; spentInPeriod: string; allowanceRemaining: string; periodElapsed: boolean };

export type TreasuryListItem = {
  address: string;
  coinMint: string;
  authority: string;
  indexedState: string;
  chain: 'read' | 'unavailable' | 'not-a-treasury';
  state?: 'Active' | 'Liquidating';
  quoteMint?: string;
  quoteDecimals?: number;
  allowance?: string;
  periodSecs?: string;
  graceSecs?: string;
  spend?: SpendWindow;
  lapsedSince?: string | null;
  vaultBalance?: string | null;
  createdAt: number | null;
  spentTotal: string;
  spendCount: number;
  redemptionCount: number;
  disclosure: Disclosure;
};

export type TreasuryList = { network: string; program: string; asOf: number; treasuries: TreasuryListItem[] };

export type CardKind = 'protects' | 'entitles' | 'not-provided' | 'caveat';
export type RightsCard = {
  id: string;
  kind: CardKind;
  title: string;
  statement: string;
  now: string | null;
  enforcedBy: { instruction: string; error: string | null; rule: string }[];
  absence: string | null;
};

export type ProgramEvent = { signature: string; slot: string; time: number | null; name: string; details: Record<string, string> };

export type UpdateView = {
  id: string;
  sequence: number;
  previousId: string | null;
  signer: string;
  signature: string;
  body: { title: string; summary: string; coveredFrom: number; coveredTo: number; issuedAt: number; declaredSpentAtoms: string | null; cluster: string };
  anchor: { signature: string; slot: string; blockTime: number; memo: string };
  spendCheck: { declaredSpentAtoms: string; spentOnChainAtoms: string; matches: boolean } | null;
};

export type TreasuryDetail = {
  network: string;
  program: string;
  asOf: number;
  address: string;
  indexed: boolean;
  state: 'Active' | 'Liquidating';
  terms: { authority: string; coinMint: string; quoteMint: string; quoteDecimals: number; allowance: string; periodSecs: string; graceSecs: string; credential: string; schema: string };
  spend: SpendWindow;
  lapse: { lapsedSince: string | null; graceEndsAt: string | null };
  snapshot: { vault: string; supply: string } | null;
  balances: { vaultAddress: string; vault: string | null; coinSupply: string | null; coinMintAuthority: string | null };
  attestation: { address: string; exists: boolean; live: boolean | null; expiry: string | null } | null;
  programUpgradeAuthority: string | null;
  history: { createdSignature: string; createdAt: number | null; spentTotal: string; spendCount: number; lapseCount: number; redeemedPaid: string; redemptionCount: number } | null;
  events: ProgramEvent[];
  rights: RightsCard[];
  disclosure: Disclosure;
};

export type UpdatesResponse = { treasury: string; network: string; updates: UpdateView[] };

/** `1,000 quote`: the quote token's symbol is not on chain in this program, so amounts are in "quote". */
export const quote = (atoms: string | null | undefined, decimals: number): string => (atoms === null || atoms === undefined ? 'unavailable' : `${formatAtoms(BigInt(atoms), decimals)} quote`);

const UNITS: [string, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

/** `2592000` is `30 days`; otherwise the two largest units it needs. */
export function duration(secsText: string): string {
  let rest = Number(secsText);
  if (!Number.isFinite(rest) || rest <= 0) return '0 seconds';
  const parts: string[] = [];
  for (const [name, size] of UNITS) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** `2026-10-13 09:05 UTC`, from unix seconds. */
export const utc = (secs: number | string): string => `${new Date(Number(secs) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

export const DISCLOSURE_LABEL: Record<DisclosureState, string> = {
  current: 'Update current',
  requested: 'Update requested',
  overdue: 'Update overdue',
  closed: 'Closed',
  unknown: 'Clock unknown',
};

export const KIND_LABEL: Record<CardKind, string> = {
  protects: 'Protects holders',
  entitles: 'Holders and anyone can',
  'not-provided': 'Not provided',
  caveat: 'Caveat',
};

const cluster = /devnet/i.test(RPC_URL) ? '?cluster=devnet' : /testnet/i.test(RPC_URL) ? '?cluster=testnet' : '';
export const explorerAddress = (a: string): string => `https://explorer.solana.com/address/${a}${cluster}`;
export const explorerTx = (s: string): string => `https://explorer.solana.com/tx/${s}${cluster}`;

/** What an event row says, in words, from the program's own event fields. */
export function eventSummary(e: ProgramEvent, decimals: number): string {
  const d = e.details;
  switch (e.name) {
    case 'TreasuryCreated':
      return `Created with an allowance of ${quote(d.allowance, decimals)} per ${duration(d.periodSecs ?? '0')}.`;
    case 'Spent':
      return `Team spent ${quote(d.amount, decimals)}; ${quote(d.spentInPeriod, decimals)} spent this period.`;
    case 'AttestationLapsed':
      return `Attestation lapse recorded at ${utc(d.at ?? 0)}.`;
    case 'LiquidationStarted':
      return `Liquidation started. Snapshot: ${quote(d.vault, decimals)} over ${d.supply} coin atoms.`;
    case 'Redeemed':
      return `A holder burned ${d.burned} coin atoms for ${quote(d.paid, decimals)}.`;
    default:
      return e.name;
  }
}
