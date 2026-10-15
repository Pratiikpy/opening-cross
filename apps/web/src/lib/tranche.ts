// The two batch 2 steps of the settle page that open a market without a pool of the usual kind: a fixed-price tranche at the clearing price through Meteora's
// Presale Vault (B4, ADR-0663) and a MetaDAO futarchy DAO whose spot pool starts at the clearing price (X3, ADR-0657). Forms turned into the bodies of
// POST /v1/tx/open-fixed-price-presale and POST /v1/tx/seed-futarchy-dao (docs/api/W4A-new-programs.md). Pure and free of React.
//
// What the program and Meteora decide is theirs and is not repeated: the caps against the price and the sale's times against the clock are Meteora's. What this
// decides is what a person is told before the wallet is asked.
import { isAddress } from '@solana/kit';
import { formatAtoms, parseAtoms } from './units';

export const LEGACY_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
type Built<K extends string> = { body: Record<string, unknown> | null; errors: Partial<Record<K, string>> };
type Decimals = { base: number | null; quote: number | null };

const seconds = (s: string): number | null => {
  const t = s.trim() === '' ? NaN : new Date(s).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};
const whole = (s: string, max: number): number | null => {
  const t = s.trim();
  if (!/^\d{1,15}$/.test(t)) return null;
  const n = Number(t);
  return n <= max ? n : null;
};

/** What selling the whole tranche at the clearing price brings in, in quote atoms: a maximum cap above this can never be reached. Null when the figures are not all known. */
export function fullSaleProceeds(supplyAtoms: bigint, price: bigint, priceScale: bigint): bigint {
  return (supplyAtoms * price) / priceScale;
}

// ---------------------------------------------------------------------------------------------------- the fixed-price tranche

export type PresaleForm = {
  supply: string;
  maxCap: string;
  minCap: string;
  buyerMin: string;
  buyerMax: string;
  startAt: string;
  endAt: string;
  depositFeePct: string;
  releaseNowPct: string;
  lockDays: string;
  vestDays: string;
  unsold: 'refund' | 'burn';
};
export const EMPTY_PRESALE: PresaleForm = { supply: '', maxCap: '', minCap: '', buyerMin: '', buyerMax: '', startAt: '', endAt: '', depositFeePct: '', releaseNowPct: '100', lockDays: '0', vestDays: '0', unsold: 'refund' };
export type PresaleErrors = Partial<Record<keyof PresaleForm, string>>;

/**
 * The body of POST /v1/tx/open-fixed-price-presale. `base` is the address of a fresh keypair that also signs: Meteora derives the presale's address from it.
 * Amounts are decimal strings in atoms; the unsold-token action is 0 (refund to the creator) or 1 (burn).
 */
export function buildPresale(f: PresaleForm, cross: string, creator: string | null, base: string | null, d: Decimals): Built<keyof PresaleForm> {
  const errors: PresaleErrors = {};
  const amount = (k: 'supply' | 'maxCap' | 'minCap' | 'buyerMin' | 'buyerMax', dec: number | null, what: string, allowZero = false): bigint | null => {
    if (f[k].trim() === '') {
      if (k === 'minCap' || k === 'buyerMin') return 0n;
      errors[k] = `Enter ${what}.`;
      return null;
    }
    if (dec === null) {
      errors[k] = 'The token’s decimals have not been read yet.';
      return null;
    }
    const v = parseAtoms(f[k], dec);
    if (v === null || (!allowZero && v === 0n)) {
      errors[k] = `${what[0]!.toUpperCase()}${what.slice(1)} must be a number above zero with at most ${dec} decimals.`;
      return null;
    }
    return v;
  };
  const supply = amount('supply', d.base, 'how many tokens the tranche sells');
  const maxCap = amount('maxCap', d.quote, 'the most the tranche may raise');
  const minCap = amount('minCap', d.quote, 'the least it needs to count as sold', true);
  const buyerMin = amount('buyerMin', d.quote, 'the smallest deposit', true);
  const buyerMax = amount('buyerMax', d.quote, 'the largest deposit one buyer may make');
  if (maxCap !== null && minCap !== null && minCap > maxCap) errors.minCap = 'The minimum raise cannot be above the maximum.';
  if (buyerMin !== null && buyerMax !== null && buyerMin > buyerMax) errors.buyerMax = 'A buyer’s largest deposit is at least their smallest.';
  const start = seconds(f.startAt);
  const end = seconds(f.endAt);
  if (start === null) errors.startAt = 'Choose when the sale opens.';
  if (end === null) errors.endAt = 'Choose when the sale closes.';
  if (start !== null && end !== null && end <= start) errors.endAt = 'The sale must close after it opens.';
  let feeBps: number | null = 0;
  if (f.depositFeePct.trim() !== '') {
    feeBps = /^\d{1,3}(\.\d{1,2})?$/.test(f.depositFeePct.trim()) ? Math.round(Number(f.depositFeePct.trim()) * 100) : null;
    if (feeBps === null || feeBps > 10_000) errors.depositFeePct = 'A percentage from 0 to 100 with at most two decimals.';
  }
  const releaseBps = /^\d{1,3}(\.\d{1,2})?$/.test(f.releaseNowPct.trim()) ? Math.round(Number(f.releaseNowPct.trim()) * 100) : null;
  if (releaseBps === null || releaseBps > 10_000) errors.releaseNowPct = 'A percentage from 0 to 100 with at most two decimals.';
  const lockDays = whole(f.lockDays, 3650);
  const vestDays = whole(f.vestDays, 3650);
  if (lockDays === null) errors.lockDays = 'A whole number of days.';
  if (vestDays === null) errors.vestDays = 'A whole number of days.';
  if (releaseBps !== null && releaseBps < 10_000 && vestDays === 0 && lockDays === 0) errors.releaseNowPct = 'Tokens not released at once need a lock or a vesting period; otherwise they would never be released.';
  if (!base) errors.supply ??= 'A fresh account for the sale is still being made.';
  if (Object.keys(errors).length > 0 || !creator || !base || supply === null || maxCap === null || minCap === null || buyerMin === null || buyerMax === null || start === null || end === null || lockDays === null || vestDays === null || releaseBps === null || feeBps === null) {
    return { body: null, errors };
  }
  return {
    body: {
      cross,
      creator,
      base,
      terms: {
        maxCap: maxCap.toString(),
        minCap: minCap.toString(),
        start,
        end,
        supply: supply.toString(),
        buyerMinDeposit: buyerMin.toString(),
        buyerMaxDeposit: buyerMax.toString(),
        depositFeeBps: feeBps,
        immediatelyReleaseBps: releaseBps,
        lockDuration: String(lockDays * 86_400),
        vestDuration: String(vestDays * 86_400),
        unsoldTokenAction: f.unsold === 'burn' ? 1 : 0,
      },
    },
    errors,
  };
}

// ---------------------------------------------------------------------------------------------------- the MetaDAO futarchy DAO

export type FutarchyForm = {
  baseAmount: string;
  nonce: string;
  passPct: string;
  proposalDays: string;
  twapDelayMins: string;
  minQuote: string;
  minBase: string;
  baseToStake: string;
  maxChange: string;
  teamPassPct: string;
};
export const EMPTY_FUTARCHY: FutarchyForm = { baseAmount: '', nonce: '', passPct: '', proposalDays: '', twapDelayMins: '', minQuote: '', minBase: '', baseToStake: '', maxChange: '', teamPassPct: '' };
export type FutarchyErrors = Partial<Record<keyof FutarchyForm, string>>;

/** The quote a MetaDAO deposit must carry for `baseAtoms` at the clearing price, rounded up (the same rule as the Raydium adapter: the starting price is P* to within one quote atom). */
export function quoteForBase(baseAtoms: bigint, price: bigint, priceScale: bigint): bigint {
  return (baseAtoms * price + priceScale - 1n) / priceScale;
}

/** Why MetaDAO cannot take this cross, in the terms of the adapter: it accepts legacy SPL Token mints only and a six-decimal quote. Null when it can. */
export function futarchyBlocker(base: { program: string } | null, quote: { program: string; decimals: number } | null): string | null {
  if (!base || !quote) return null;
  if (base.program !== LEGACY_TOKEN_PROGRAM || quote.program !== LEGACY_TOKEN_PROGRAM) return 'MetaDAO accepts legacy SPL Token mints only, and one of this cross’s tokens is a Token-2022 token. The adapter refuses it before MetaDAO can fail on it.';
  if (quote.decimals !== 6) return `MetaDAO requires a quote token with 6 decimals; this one has ${quote.decimals}.`;
  return null;
}

/** The body of POST /v1/tx/seed-futarchy-dao. The quote deposit is not typed: it is the exact ratio at the clearing price, rounded up, as the adapter requires. */
export function buildFutarchy(f: FutarchyForm, cross: string, creator: string | null, d: Decimals): Built<keyof FutarchyForm> {
  const errors: FutarchyErrors = {};
  const base = d.base === null ? null : parseAtoms(f.baseAmount, d.base);
  if (f.baseAmount.trim() === '' || base === null || base === 0n) errors.baseAmount = d.base === null ? 'The token’s decimals have not been read yet.' : `A number of tokens above zero with at most ${d.base} decimals.`;
  let nonce: string | undefined;
  if (f.nonce.trim() !== '') {
    if (!/^\d{1,18}$/.test(f.nonce.trim())) errors.nonce = 'A whole number, or leave it empty to use the first free one.';
    else nonce = f.nonce.trim();
  }
  const settings: Record<string, unknown> = {};
  const pct = (k: 'passPct' | 'teamPassPct', field: string, signed: boolean) => {
    const t = f[k].trim();
    if (t === '') return;
    if (!new RegExp(`^${signed ? '-?' : ''}\\d{1,3}(\\.\\d{1,2})?$`).test(t)) {
      errors[k] = signed ? 'A percentage from -100 to 100 with at most two decimals.' : 'A percentage from 0 to 100 with at most two decimals.';
      return;
    }
    const bps = Math.round(Number(t) * 100);
    if (bps > 10_000 || bps < (signed ? -10_000 : 0)) errors[k] = signed ? 'A percentage from -100 to 100.' : 'A percentage from 0 to 100.';
    else settings[field] = bps;
  };
  pct('passPct', 'passThresholdBps', false);
  pct('teamPassPct', 'teamSponsoredPassThresholdBps', true);
  if (f.proposalDays.trim() !== '') {
    const days = whole(f.proposalDays, 3650);
    if (days === null || days === 0) errors.proposalDays = 'A whole number of days above zero.';
    else settings.secondsPerProposal = days * 86_400;
  }
  if (f.twapDelayMins.trim() !== '') {
    const m = whole(f.twapDelayMins, 1_000_000);
    if (m === null) errors.twapDelayMins = 'A whole number of minutes.';
    else settings.twapStartDelaySeconds = m * 60;
  }
  const atoms = (k: 'minQuote' | 'minBase' | 'baseToStake' | 'maxChange', field: string, dec: number | null) => {
    const t = f[k].trim();
    if (t === '') return;
    const v = dec === null ? null : parseAtoms(t, dec);
    if (v === null) errors[k] = dec === null ? 'The token’s decimals have not been read yet.' : `A number with at most ${dec} decimals.`;
    else settings[field] = v.toString();
  };
  atoms('minQuote', 'minQuoteFutarchicLiquidity', d.quote);
  atoms('minBase', 'minBaseFutarchicLiquidity', d.base);
  atoms('baseToStake', 'baseToStake', d.base);
  if (f.maxChange.trim() !== '') {
    if (!/^\d{1,18}$/.test(f.maxChange.trim())) errors.maxChange = 'A whole number in MetaDAO’s own price units (10^12 per quote atom per base atom).';
    else settings.twapMaxObservationChangePerUpdate = f.maxChange.trim();
  }
  if (Object.keys(errors).length > 0 || !creator || base === null) return { body: null, errors };
  return { body: { cross, creator, baseAmount: base.toString(), ...(nonce !== undefined ? { nonce } : {}), ...(Object.keys(settings).length > 0 ? { settings } : {}) }, errors };
}

/** "300 tokens at 1.3 is 390 quote", in the units a person reads; null when a figure is missing. */
export function depositLine(base: string, d: Decimals, price: bigint | null, priceScale: bigint | null): string | null {
  if (price === null || priceScale === null || d.base === null || d.quote === null) return null;
  const b = parseAtoms(base, d.base);
  if (b === null || b === 0n) return null;
  return `${formatAtoms(b, d.base)} base tokens go in with ${formatAtoms(quoteForBase(b, price, priceScale), d.quote)} quote tokens, so the DAO’s pool starts at the clearing price.`;
}

export const looksLikeAddress = (a: string): boolean => isAddress(a);
