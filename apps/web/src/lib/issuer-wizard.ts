// Everything the wizard derives from the form and from what the chain says about the two mints: exact numbers (grid, supply on offer),
// the rules the issuer committed to (float, value ceiling) turned into the parameters the program enforces, and the extra readiness
// items those rules and the guards add. Pure, so every verdict can be tested.
import { type Draft } from './issuer-draft';
import { checkOracle } from './issuer-guards';
import { fdvAt, guardNotes, maxTopPriceForFdv, minMatchedForFloat, ticksUnder } from './issuer-guards';
import { type Check, type MintRead } from './issuer-readiness';
import { type Market, formatAtoms, parseAtoms, parsePrice } from './units';

type OkMint = Extract<MintRead, { ok: true }>;
export const okMint = (m: MintRead | null | undefined): OkMint | null => (m && m.ok ? m : null);

export type Derived = {
  baseDecimals: number | null;
  quoteDecimals: number | null;
  market: Market | null;
  minPrice: bigint | null;
  tick: bigint | null;
  /** The highest price on the grid, in price units. */
  topPrice: bigint | null;
  /** Valid supply steps (price units, base atoms). */
  steps: { price: bigint; quantity: bigint }[];
  /** Total tokens listed in a minting cross; null in escrow mode, where sellers decide. */
  offered: bigint | null;
  /** The tokens already minted before the cross, when the base mint was read. */
  existingSupply: bigint | null;
  /** The minimum volume as typed: null when not a number, 0n when empty. */
  typedMinMatched: bigint | null;
  /** The float the issuer asks for in basis points, 0 for none, null when not a valid percentage. */
  floatBps: number | null;
  /** Tokens that must trade for that float; null when none is asked or it cannot be computed. */
  floatMinMatched: bigint | null;
  /** The minimum volume the program will be told: the larger of the typed one and the float rule's. */
  effectiveMinMatched: bigint | null;
  /** The value ceiling in quote atoms: 0n for none, null when not a number. */
  fdvCap: bigint | null;
  /** The highest top-of-grid price that keeps value under the ceiling, and how many levels fit under it. */
  fdvTop: bigint | null;
  fitTicks: number | null;
  maxImbalanceBps: number | null | 'invalid';
};

export function derive(d: Draft, base: MintRead | null | undefined, quote: MintRead | null | undefined): Derived {
  const b = okMint(base);
  const q = okMint(quote);
  const baseDecimals = b ? b.decimals : null;
  const quoteDecimals = q ? q.decimals : null;
  const market: Market | null = b && q ? { priceScale: 10n ** BigInt(b.decimals), baseDecimals: b.decimals, quoteDecimals: q.decimals } : null;
  const minPrice = market ? parsePrice(d.minPrice, market) : null;
  const tick = market ? parsePrice(d.tick, market) : null;
  const gridOk = minPrice !== null && minPrice > 0n && tick !== null && tick > 0n && Number.isInteger(d.ticks) && d.ticks >= 2 && d.ticks <= 256;
  const topPrice = gridOk ? minPrice + BigInt(d.ticks - 1) * tick : null;
  const steps: { price: bigint; quantity: bigint }[] = [];
  if (market && d.supplyMode === 'mint') {
    for (const s of d.schedule) {
      const p = parsePrice(s.price, market);
      const qn = baseDecimals === null ? null : parseAtoms(s.quantity, baseDecimals);
      if (p !== null && qn !== null && qn > 0n) steps.push({ price: p, quantity: qn });
    }
  }
  const offered = d.supplyMode === 'mint' ? (steps.length ? steps.reduce((a, s) => a + s.quantity, 0n) : null) : null;
  const existingSupply = b?.supply ?? null;

  const typedMinMatched = d.minMatched.trim() === '' ? 0n : baseDecimals === null ? null : parseAtoms(d.minMatched, baseDecimals);

  let floatBps: number | null = 0;
  if (d.minFloatPct.trim() !== '') {
    const v = Number(d.minFloatPct);
    floatBps = Number.isFinite(v) && v > 0 && v <= 100 && Math.round(v * 100) === v * 100 ? Math.round(v * 100) : null;
  }
  const floatMinMatched = floatBps && floatBps > 0 && existingSupply !== null ? minMatchedForFloat(floatBps, existingSupply, d.supplyMode) : null;
  const effectiveMinMatched = typedMinMatched === null ? null : floatMinMatched !== null && floatMinMatched > typedMinMatched ? floatMinMatched : typedMinMatched;

  let fdvCap: bigint | null = 0n;
  if (d.maxFdv.trim() !== '') fdvCap = quoteDecimals === null ? null : parseAtoms(d.maxFdv, quoteDecimals);
  let fdvTop: bigint | null = null;
  let fitTicks: number | null = null;
  if (fdvCap !== null && fdvCap > 0n && existingSupply !== null && market) {
    const maxSold = d.supplyMode === 'mint' ? (offered ?? 0n) : 0n;
    fdvTop = maxTopPriceForFdv(fdvCap, existingSupply, maxSold, d.supplyMode, market.priceScale);
    if (fdvTop !== null && minPrice !== null && tick !== null) fitTicks = ticksUnder(minPrice, tick, fdvTop);
  }

  let maxImbalanceBps: number | null | 'invalid' = null;
  if (d.maxImbalancePct.trim() !== '') {
    const v = Number(d.maxImbalancePct);
    maxImbalanceBps = Number.isFinite(v) && v >= 0 && v <= 100 && Math.round(v * 100) === v * 100 ? Math.round(v * 100) : 'invalid';
  }
  return { baseDecimals, quoteDecimals, market, minPrice, tick, topPrice, steps, offered, existingSupply, typedMinMatched, floatBps, floatMinMatched, effectiveMinMatched, fdvCap, fdvTop, fitTicks, maxImbalanceBps };
}

const tok = (atoms: bigint, d: number | null) => (d === null ? `${atoms} atoms` : `${formatAtoms(atoms, d)} tokens`);
const quo = (atoms: bigint, d: number | null) => (d === null ? `${atoms} atoms` : `${formatAtoms(atoms, d)} quote`);

/** The readiness items the guards and rules add to the chain-read checklist. Nothing here reads the chain; it judges the form. */
export function ruleChecks(d: Draft, v: Derived): Check[] {
  const checks: Check[] = [];
  const notes = guardNotes({ supplyMode: d.supplyMode, baseDecimals: v.baseDecimals, offered: v.offered, minMatched: v.effectiveMinMatched, maxImbalanceBps: v.maxImbalanceBps === 'invalid' ? null : v.maxImbalanceBps, oracleEnabled: d.oracle.enabled });
  const vol = notes.find((n) => n.id === 'min-volume')!;
  checks.push({ id: 'guard-volume', label: 'Minimum volume', status: vol.severity === 'block' ? 'fail' : vol.severity === 'warn' ? 'warn' : 'pass', detail: vol.title + (vol.severity === 'block' ? `. ${vol.text}` : '') });
  if (v.maxImbalanceBps === 'invalid') checks.push({ id: 'guard-imbalance', label: 'Maximum imbalance', status: 'fail', detail: 'Enter a percentage between 0 and 100 with at most two decimals, or leave it empty.' });

  if (d.minFloatPct.trim() !== '') {
    if (v.floatBps === null) checks.push({ id: 'rule-float', label: 'Minimum float', status: 'fail', detail: 'Enter a percentage above 0 and up to 100 with at most two decimals, or leave it empty.' });
    else if (v.existingSupply === null) checks.push({ id: 'rule-float', label: 'Minimum float', status: 'wait', detail: 'The float needs the token’s current supply. Check the token to read it.' });
    else if (v.floatMinMatched === null) checks.push({ id: 'rule-float', label: 'Minimum float', status: 'fail', detail: 'A minting cross can never reach a float of 100%, because the tokens already minted stay outside it.' });
    else if (v.offered !== null && v.floatMinMatched > v.offered) checks.push({ id: 'rule-float', label: 'Minimum float', status: 'fail', detail: `A float of ${d.minFloatPct}% needs ${tok(v.floatMinMatched, v.baseDecimals)} to trade, but you list ${tok(v.offered, v.baseDecimals)}. List more or ask for less.` });
    else checks.push({ id: 'rule-float', label: 'Minimum float', status: 'pass', detail: `The program will refuse to print below ${tok(v.floatMinMatched, v.baseDecimals)} traded, which is a float of at least ${d.minFloatPct}% of the ${tok(d.supplyMode === 'mint' ? v.existingSupply + v.floatMinMatched : v.existingSupply, v.baseDecimals)} in existence afterwards.` });
  }

  if (d.maxFdv.trim() !== '') {
    if (v.quoteDecimals === null) checks.push({ id: 'rule-fdv', label: 'Value ceiling', status: 'wait', detail: 'The ceiling is in quote tokens. Check the quote token to read its decimals.' });
    else if (v.fdvCap === null) checks.push({ id: 'rule-fdv', label: 'Value ceiling', status: 'fail', detail: 'Enter an amount of quote tokens, or leave it empty.' });
    else if (v.existingSupply === null || !v.market) checks.push({ id: 'rule-fdv', label: 'Value ceiling', status: 'wait', detail: 'The ceiling needs the token’s current supply and both mints. Check the tokens to read them.' });
    else if (v.fdvTop === null) checks.push({ id: 'rule-fdv', label: 'Value ceiling', status: 'fail', detail: 'No price satisfies this ceiling: check the amount and that the token has a supply.' });
    else if (v.topPrice !== null && v.topPrice > v.fdvTop) {
      const fit = v.fitTicks === null ? 'Even the lowest two levels are above it, so lower the lowest price or raise the ceiling.' : `Shorten the grid to ${v.fitTicks} levels to fit.`;
      checks.push({ id: 'rule-fdv', label: 'Value ceiling', status: 'fail', detail: `The top of your grid would value the token at ${quo(fdvAt(v.topPrice, d.supplyMode === 'mint' ? (v.existingSupply + (v.offered ?? 0n)) : v.existingSupply, v.market.priceScale), v.quoteDecimals)}, above your ceiling of ${quo(v.fdvCap, v.quoteDecimals)}. ${fit}` });
    } else if (v.topPrice !== null) checks.push({ id: 'rule-fdv', label: 'Value ceiling', status: 'pass', detail: `Even at the top of your grid, with everything you list sold, the token is worth at most ${quo(fdvAt(v.topPrice, d.supplyMode === 'mint' ? (v.existingSupply + (v.offered ?? 0n)) : v.existingSupply, v.market.priceScale), v.quoteDecimals)}, under your ceiling. The program cannot clear above the top of the grid.` });
  }

  const o = checkOracle(d.oracle);
  if (d.oracle.enabled) {
    if (!o.ok) checks.push({ id: 'guard-oracle', label: 'Oracle guard', status: 'fail', detail: Object.values(o.errors)[0]! });
    else checks.push({ id: 'guard-oracle', label: 'Oracle guard', status: 'warn', detail: 'On. A Pyth price update must be supplied in the transaction that clears the cross, or it cannot clear. Make sure a keeper you control does this.' });
  }
  return checks;
}

/** The suggested next move for a failing rule check, when there is exactly one. */
export function fitGridAction(v: Derived): { ticks: number } | null {
  return v.fitTicks !== null && v.topPrice !== null && v.fdvTop !== null && v.topPrice > v.fdvTop ? { ticks: v.fitTicks } : null;
}

// ---------------------------------------------------------------------------------------------------------------- simulator input

import { type SimInput, type Step } from './issuer-sim';
import { type FeeSchedule } from './issuer-data';
import { protocolFeeBps } from './issuer-fees';

export type Row = { price: string; quantity: string };

/** Rows of (limit price, tokens) typed by a person, as exact steps; a row that does not parse is named, never dropped silently. */
export function parseRows(rows: readonly Row[], market: Market | null): { steps: Step[]; errors: Record<number, string> } {
  const steps: Step[] = [];
  const errors: Record<number, string> = {};
  rows.forEach((r, i) => {
    if (r.price.trim() === '' && r.quantity.trim() === '') return;
    if (!market) {
      errors[i] = 'Check both tokens first, so prices can be read exactly.';
      return;
    }
    const p = parsePrice(r.price, market);
    const q = parseAtoms(r.quantity, market.baseDecimals);
    if (p === null || p === 0n) errors[i] = `Enter a price above zero with at most ${market.quoteDecimals} decimal places.`;
    else if (q === null || q === 0n) errors[i] = `Enter a number of tokens above zero with at most ${market.baseDecimals} decimal places.`;
    else steps.push({ price: p, quantity: q });
  });
  return { steps, errors };
}

/**
 * The simulator's input from the draft: the grid, the supply (the schedule, or the escrow rows the issuer typed), the demand rows,
 * the guards as the program will receive them and the fees the cross would snapshot. Null until the grid and the mints are known.
 */
export function simInputFrom(d: Draft, v: Derived, demand: readonly Step[], escrowSupply: readonly Step[], fees: FeeSchedule): SimInput | null {
  if (!v.market || v.minPrice === null || v.tick === null || v.typedMinMatched === null || v.maxImbalanceBps === 'invalid') return null;
  if (!Number.isInteger(d.ticks) || d.ticks < 2 || d.ticks > 256) return null;
  const supply = d.supplyMode === 'mint' ? v.steps : [...escrowSupply];
  const protocolBps = protocolFeeBps(fees, d.kind, d.integratorFeeBps);
  return {
    grid: { minPrice: v.minPrice, tick: v.tick, ticks: d.ticks, priceScale: v.market.priceScale, baseDecimals: v.market.baseDecimals, quoteDecimals: v.market.quoteDecimals },
    supply,
    demand: [...demand],
    supplyMode: d.supplyMode,
    existingSupply: v.existingSupply ?? 0n,
    minMatched: v.effectiveMinMatched ?? 0n,
    maxImbalanceBps: v.maxImbalanceBps,
    protocolBps,
    integratorBps: Number.isInteger(d.integratorFeeBps) ? d.integratorFeeBps : 0,
  };
}
