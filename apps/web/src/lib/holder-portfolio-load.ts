'use client';

// Everything the portfolio page needs for one wallet: what it holds now (from chain), what it paid and received through crosses (from
// the index), the last price each token cleared at, the next cross of each token, and the treasury behind a token that has one. A part
// that cannot be read is reported and left out, never replaced with a zero or a guess.
import { API_URL } from './api';
import { readBalances } from './holder-chain';
import { type HoldingValue, type Mark, latestPrints, markOf, nextCrossFor, redemptionPayout, valueHolding } from './holder-value';
import { buildPortfolio } from './portfolio';
import { loadPortfolio } from './portfolio-load';
import type { RightsCard, TreasuryDetail, TreasuryList } from './treasury';
import type { CrossDetail } from './types';
import type { CrossSummary } from './api';

export type Received = { signature: string; time: number | null; paid: string; burned: string };

export type TreasuryLink = {
  address: string;
  state: 'Active' | 'Liquidating';
  quoteDecimals: number;
  rights: RightsCard[];
  /** The snapshot a liquidating treasury redeems against; null while it is active. */
  snapshot: { vault: string; supply: string } | null;
  /** What `held` coins would redeem for now; null unless liquidating. */
  entitlement: bigint | null;
  /** Redemptions this wallet already received from this treasury. */
  received: Received[];
};

export type HoldingRow = HoldingValue & {
  next: CrossSummary | null;
  treasury: TreasuryLink | null;
  /** The cross whose clearing price is the mark, with its state, so the page can link it. */
  markCross: string | null;
};

export type HoldingsData = {
  rows: HoldingRow[];
  /** How many orders the wallet has in the index, and in how many crosses. */
  orders: number;
  crosses: number;
  /** Parts that could not be read, in words. */
  unread: string[];
  asOf: number;
};

async function getJson<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
      if (r.status === 429) {
        await new Promise((res) => setTimeout(res, Math.min(8, Number(r.headers.get('retry-after') ?? 2)) * 1000));
        continue;
      }
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function loadHoldings(owner: string, step?: (text: string) => void): Promise<HoldingsData | null> {
  step?.('Reading your orders…');
  const loaded = await loadPortfolio(owner);
  if (!loaded) return null;
  const portfolio = buildPortfolio(loaded.orders, loaded.crosses, new Map());
  const unread: string[] = [];
  if (loaded.missing.length) unread.push(`${loaded.missing.length} crosses could not be loaded, so what you bought in them is left out.`);
  if (loaded.truncated) unread.push('Only the most recent 60 crosses of your history are included.');

  // What was bought and sold, per base token and quote token.
  type Agg = { decimals: number; bought: Map<string, { tokens: bigint; paid: bigint }>; sold: bigint };
  const perMint = new Map<string, Agg>();
  for (const p of portfolio.positions) {
    const mint = p.cross.baseMint;
    if (!mint) continue;
    let a = perMint.get(mint);
    if (!a) {
      a = { decimals: p.cross.decimals.base, bought: new Map(), sold: 0n };
      perMint.set(mint, a);
    }
    a.sold += p.tokensSold;
    if (p.tokensReceived > 0n) {
      const b = a.bought.get(p.cross.quoteMint) ?? { tokens: 0n, paid: 0n };
      a.bought.set(p.cross.quoteMint, { tokens: b.tokens + p.tokensReceived, paid: b.paid + p.quotePaid });
    }
  }
  const mints = [...perMint.keys()].filter((m) => perMint.get(m)!.bought.size > 0 || perMint.get(m)!.sold > 0n);

  step?.('Reading your balances…');
  const balances = (await readBalances(owner, mints)) ?? new Map<string, null>();
  if (mints.some((m) => !balances.get(m))) unread.push('Some balances could not be read from the network just now; those holdings show no value.');

  step?.('Finding the last price of each token…');
  const list = await getJson<{ crosses: CrossSummary[] }>('/v1/crosses?limit=200');
  if (!list) unread.push('The list of crosses could not be read, so no token has a last price or a next cross.');
  const all = list?.crosses ?? [];
  const prints = latestPrints(all);
  const detailOf = async (address: string): Promise<CrossDetail | null> => loaded.details.get(address) ?? (await getJson<CrossDetail>(`/v1/crosses/${address}`));

  step?.('Checking treasuries…');
  const treasuries = await getJson<TreasuryList>('/v1/treasuries');
  const now = Math.floor(Date.now() / 1000);

  const rows: HoldingRow[] = [];
  for (const mint of mints) {
    const agg = perMint.get(mint)!;
    const bal = balances.get(mint) ?? null;
    const print = prints.get(mint);
    let mark: Mark | null = null;
    if (print) {
      const d = await detailOf(print.address);
      mark = d ? markOf(d) : null;
      if (!d) unread.push(`The cross behind the last price of ${mint.slice(0, 4)}… could not be read.`);
    }
    const v = valueHolding({
      mint,
      decimals: bal?.decimals ?? agg.decimals,
      held: bal ? bal.amount : null,
      bought: [...agg.bought].map(([quoteMint, b]) => ({ quoteMint, tokens: b.tokens, paid: b.paid })),
      sold: agg.sold,
      mark,
    });
    let treasury: TreasuryLink | null = null;
    const t = treasuries?.treasuries.find((x) => x.coinMint === mint);
    if (t) {
      const d = await getJson<TreasuryDetail>(`/v1/treasuries/${t.address}`);
      if (d) {
        const held = bal?.amount ?? 0n;
        treasury = {
          address: t.address,
          state: d.state,
          quoteDecimals: d.terms.quoteDecimals,
          rights: d.rights,
          snapshot: d.snapshot,
          entitlement: d.state === 'Liquidating' ? redemptionPayout(held, d.snapshot) : null,
          received: d.events.filter((e) => e.name === 'Redeemed' && e.details.holder === owner).map((e) => ({ signature: e.signature, time: e.time, paid: e.details.paid ?? '0', burned: e.details.burned ?? '0' })),
        };
      } else unread.push(`The treasury of ${mint.slice(0, 4)}… could not be read.`);
    }
    rows.push({ ...v, next: nextCrossFor(mint, all, now), treasury, markCross: mark?.cross ?? null });
  }
  return { rows, orders: portfolio.orders, crosses: portfolio.crosses, unread, asOf: now };
}
