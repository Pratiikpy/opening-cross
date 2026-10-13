// What the issuer overview computes from the API's reads: the issuer's own crosses, a holder register for one cross, the fees it paid,
// and the tasks that follow from the state of everything. Pure, so every figure and every task can be tested. Nothing here is a
// forecast: each number is an order, a fill or a fee the program recorded, or a plain function of them.
import type { CrossRow, TreasuryRow } from './issuer-data';
import { formatAtoms } from './units';

export type OrderRow = {
  idx: number;
  address: string;
  owner: string;
  side: 'buy' | 'sell';
  escrow: string;
  sealed: boolean;
  price: string | null;
  quantity: string | null;
  status: 'committed' | 'revealed' | 'cancelled' | 'claimed';
  fill: string | null;
  quote_out: string | null;
  base_out: string | null;
  fee: string | null;
};

/** The issuer's crosses, newest window first. */
export const ownCrosses = (rows: readonly CrossRow[], wallet: string): CrossRow[] => rows.filter((c) => c.creator === wallet).sort((a, b) => Number(BigInt(b.openTs) - BigInt(a.openTs)));

export type Holder = { owner: string; orders: number; filled: bigint; escrow: bigint; spent: bigint; status: 'received' | 'refunded' | 'pending' };

/**
 * Who took part in a cross and what each wallet received, from its orders. For a settled cross the filled amount is the tokens a
 * wallet is owed or has been paid (`fill`); before settlement nobody has received anything and wallets are listed as pending.
 * Sell orders are not holders and are left out. This is a register of this cross's fills, not of current holdings: tokens move.
 */
export function holderRegister(orders: readonly OrderRow[], settled: boolean): Holder[] {
  const by = new Map<string, Holder>();
  for (const o of orders) {
    if (o.side !== 'buy') continue;
    const h = by.get(o.owner) ?? { owner: o.owner, orders: 0, filled: 0n, escrow: 0n, spent: 0n, status: 'pending' as Holder['status'] };
    h.orders += 1;
    h.escrow += BigInt(o.escrow);
    if (settled && o.fill !== null) h.filled += BigInt(o.fill);
    if (settled && o.quote_out !== null && o.escrow !== undefined) h.spent += BigInt(o.escrow) - BigInt(o.quote_out);
    by.set(o.owner, h);
  }
  const out = [...by.values()];
  for (const h of out) h.status = !settled ? 'pending' : h.filled > 0n ? 'received' : 'refunded';
  return out.sort((a, b) => (a.filled === b.filled ? (a.owner < b.owner ? -1 : 1) : a.filled > b.filled ? -1 : 1));
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The register as CSV with a header and the units in it, so the file means the same thing outside the page. */
export function registerCsv(holders: readonly Holder[], baseDecimals: number, quoteDecimals: number): string {
  const head = ['wallet', 'orders', 'tokens_received', 'quote_escrowed', 'status'];
  const lines = holders.map((h) => [h.owner, String(h.orders), formatAtoms(h.filled, baseDecimals).replace(/,/g, ''), formatAtoms(h.escrow, quoteDecimals).replace(/,/g, ''), h.status].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

/**
 * The fees a finalized minting or escrow cross took, from cross_core's own formula: filled notional times the cross's snapshotted
 * basis points, split with the protocol getting its share of the total. Null for a cross that did not print.
 */
export function feesPaid(c: { clearing: { price: string; matched: string } | null; fees: { protocolBps: number; integratorBps: number }; grid: { priceScale: string } }): { notional: bigint; total: bigint; protocol: bigint; integrator: bigint } | null {
  if (!c.clearing) return null;
  const scale = BigInt(c.grid.priceScale);
  const notional = (BigInt(c.clearing.matched) * BigInt(c.clearing.price) + scale - 1n) / scale;
  const totalBps = BigInt(Math.min(c.fees.protocolBps + c.fees.integratorBps, 65_535));
  const total = (notional * totalBps) / 10_000n;
  const protocol = totalBps === 0n ? 0n : (total * BigInt(c.fees.protocolBps)) / totalBps;
  return { notional, total, protocol, integrator: total - protocol };
}

export type Task = { id: string; title: string; detail: string; href: string; tone: 'now' | 'soon' | 'info' };

export type TaskInput = {
  wallet: string;
  crosses: readonly CrossRow[];
  treasuries: readonly TreasuryRow[];
  /** Unanswered questions about the issuer's crosses and treasuries, by state. */
  questions: { requested: number; overdue: number };
  nowSecs: number;
};

/** What needs the issuer's attention, most urgent first. A task appears only when the data says it applies. */
export function tasks(i: TaskInput): Task[] {
  const out: Task[] = [];
  const mine = ownCrosses(i.crosses, i.wallet);
  for (const t of i.treasuries.filter((x) => x.authority === i.wallet)) {
    if (t.disclosure.state === 'overdue') out.push({ id: `update-${t.address}`, title: 'Post a disclosure update', detail: `The update for treasury ${t.address.slice(0, 4)}… is overdue. ${t.disclosure.note}`, href: '/issuer/disclosures', tone: 'now' });
    else if (t.disclosure.state === 'requested') out.push({ id: `update-${t.address}`, title: 'A disclosure update is due', detail: `Treasury ${t.address.slice(0, 4)}… is due for its next update.`, href: '/issuer/disclosures', tone: 'soon' });
    if (t.chain === 'read' && t.lapsedSince) out.push({ id: `lapse-${t.address}`, title: 'The attestation behind a treasury has lapsed', detail: 'Spending is stopped until the attester renews it. If the lapse lasts the grace period, anyone can start liquidation.', href: '/issuer/treasury', tone: 'now' });
  }
  if (i.questions.overdue > 0) out.push({ id: 'qa-overdue', title: `Answer ${i.questions.overdue} overdue ${i.questions.overdue === 1 ? 'question' : 'questions'}`, detail: 'Holders asked and have waited more than seven days.', href: '/issuer/disclosures', tone: 'now' });
  if (i.questions.requested > 0) out.push({ id: 'qa-requested', title: `${i.questions.requested} ${i.questions.requested === 1 ? 'question' : 'questions'} waiting`, detail: 'Holders asked about your crosses or treasuries.', href: '/issuer/disclosures', tone: 'soon' });
  const treasuryCoins = new Set(i.treasuries.map((t) => t.coinMint));
  const settled = mine.filter((c) => c.state === 'Finalized' && c.clearingPrice !== null && c.supplyMode === 'mint');
  const seen = new Set<string>();
  for (const c of settled) {
    if (treasuryCoins.has(c.baseMint) || seen.has(c.baseMint)) continue;
    seen.add(c.baseMint);
    out.push({ id: `treasury-${c.baseMint}`, title: 'Set up a treasury for the coin you launched', detail: `${c.baseMint.slice(0, 4)}… has a fixed supply now. A treasury is optional: it holds proceeds under an allowance that needs a live attestation.`, href: `/issuer/treasury/new?coin=${c.baseMint}`, tone: 'info' });
  }
  const live = mine.filter((c) => c.state === 'Live');
  for (const c of live) {
    const open = Number(c.openTs);
    const close = Number(c.revealEndTs);
    if (i.nowSecs < open) out.push({ id: `opens-${c.address}`, title: 'A cross of yours has not opened yet', detail: `Orders open in ${Math.max(1, Math.round((open - i.nowSecs) / 60))} min. Nothing about it can be changed now.`, href: `/crosses/${c.address}`, tone: 'info' });
    else if (i.nowSecs <= close) out.push({ id: `live-${c.address}`, title: 'A cross of yours is taking orders', detail: 'You cannot change its price or end it early. Watch the book on its page.', href: `/crosses/${c.address}`, tone: 'info' });
  }
  const rank = { now: 0, soon: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
