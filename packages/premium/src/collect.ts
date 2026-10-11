// One measurement round: for each asset, quote a buy and a sell at each size on Jupiter and set the executable price
// per share against an independent reference. Every attempt produces an Observation, including the ones that could
// not be priced, so the summary can say how many were excluded and why.
import { atomsForNotional, multiplierText, perShareE6, premiumBpsX100 } from './math.js';
import type { IssuerState } from './sources/xstocks.js';
import { sessionFor } from './sources/xstocks.js';
import { type QuoteFn, NoRouteError } from './sources/jupiter.js';
import type { Asset, Leg, Observation, ObservationStatus, Reference, ReferenceKind, Session } from './types.js';

/** USDC on Solana: the quote asset every measurement is made in. */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;

export interface RoundInput {
  readonly quote: QuoteFn;
  readonly now: number;
  readonly sizesUsd: readonly number[];
  readonly referenceKind: ReferenceKind;
  /** Reference per upper-case ticker. */
  readonly references: ReadonlyMap<string, Reference>;
  /** Issuer clock per upper-case ticker. */
  readonly issuer: ReadonlyMap<string, IssuerState>;
  /** Pause between quotes, milliseconds, to stay inside the quote API's rate limit. */
  readonly paceMs?: number;
}

export interface MeasuredAsset extends Asset {
  /** Scaled UI Amount multiplier as an integer scaled by 10^12; null when the chain could not be read. */
  readonly multiplierE12: bigint | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function blank(a: MeasuredAsset, input: RoundInput, leg: Leg, sizeUsd: number, session: Session, status: ObservationStatus, ref: Reference | undefined): Observation {
  return {
    at: input.now,
    ticker: a.ticker,
    symbol: a.symbol,
    mint: a.mint,
    leg,
    sizeUsd,
    session,
    referenceKind: input.referenceKind,
    status,
    referenceE6: ref?.priceE6 ?? null,
    perShareE6: null,
    premiumBpsX100: null,
    priceImpactBpsX100: null,
    route: null,
    multiplier: a.multiplierE12 === null ? null : multiplierText(a.multiplierE12),
  };
}

export async function observeAsset(a: MeasuredAsset, input: RoundInput): Promise<Observation[]> {
  const out: Observation[] = [];
  const ref = input.references.get(a.ticker);
  const state = input.issuer.get(a.ticker);
  const session = state ? sessionFor(state, input.now) : null;
  // Without the issuer's clock there is no honest session label, so nothing is measured under a guessed one.
  if (!session) return out;
  for (const sizeUsd of input.sizesUsd) {
    for (const leg of ['buy', 'sell'] as const) {
      const fail = (status: ObservationStatus) => out.push(blank(a, input, leg, sizeUsd, session, status, ref));
      if (state?.halted) {
        fail('issuer_halted');
        continue;
      }
      if (!ref) {
        fail('no_reference');
        continue;
      }
      if (a.multiplierE12 === null) {
        fail('no_multiplier');
        continue;
      }
      let q;
      try {
        if (leg === 'buy') {
          q = await input.quote(USDC_MINT, a.mint, BigInt(sizeUsd) * 10n ** BigInt(USDC_DECIMALS));
        } else {
          const atoms = atomsForNotional(sizeUsd, ref.priceE6, a.decimals, a.multiplierE12);
          if (atoms <= 0n) {
            fail('zero_shares');
            continue;
          }
          q = await input.quote(a.mint, USDC_MINT, atoms);
        }
      } catch (e) {
        fail(e instanceof NoRouteError ? 'no_route' : 'quote_failed');
        if (input.paceMs) await sleep(input.paceMs);
        continue;
      }
      const usd = leg === 'buy' ? q.inAmount : q.outAmount;
      const tokens = leg === 'buy' ? q.outAmount : q.inAmount;
      const price = perShareE6(leg, usd, tokens, a.decimals, a.multiplierE12);
      if (price === null) {
        fail('zero_shares');
      } else {
        out.push({
          ...blank(a, input, leg, sizeUsd, session, 'ok', ref),
          perShareE6: price,
          premiumBpsX100: premiumBpsX100(price, ref.priceE6),
          priceImpactBpsX100: q.priceImpactBpsX100,
          route: q.routeLabels.join('+'),
        });
      }
      if (input.paceMs) await sleep(input.paceMs);
    }
  }
  return out;
}

export async function collectRound(assets: readonly MeasuredAsset[], input: RoundInput): Promise<Observation[]> {
  const all: Observation[] = [];
  for (const a of assets) all.push(...(await observeAsset(a, input)));
  return all;
}
