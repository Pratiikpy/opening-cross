// Turns the issuer console's form into the API's create-cross request. Pure and exact: every
// amount a person types is converted with the mint's real decimals, and anything that would round,
// overlap or fall off the price grid is refused with a message naming the field.
import { parseAtoms, parsePrice } from './units';

export type IssuerForm = {
  creator: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseTokenProgram: string;
  quoteTokenProgram: string;
  disclosure: 'sealed' | 'open';
  supplyMode: 'escrow' | 'mint';
  kind: 'launch' | 'reopen' | 'tender' | 'recurring';
  minPrice: string; // per whole token, e.g. "1.00"
  tick: string; // per whole token, e.g. "0.05"
  ticks: number;
  openAt: Date;
  closeAt: Date;
  revealMinutes: number; // sealed only
  minMatched: string; // tokens
  maxImbalancePct: string; // "" = no limit
  integrator: string;
  integratorFeeBps: number;
  maxOrders: number;
  shards: number;
  proceedsTo: string;
  schedule: { price: string; quantity: string }[]; // mint mode only
  crossId: string;
};

export type CreateCrossBody = Record<string, unknown>;
export type Checked = { ok: true; body: CreateCrossBody } | { ok: false; errors: Record<string, string> };

export function checkIssuerForm(f: IssuerForm, now: Date): Checked {
  const errors: Record<string, string> = {};
  // Prices are quote atoms per 10^baseDecimals base atoms, so "per whole token" maps exactly.
  const priceScale = 10n ** BigInt(f.baseDecimals);
  const market = { priceScale, baseDecimals: f.baseDecimals, quoteDecimals: f.quoteDecimals };
  const minPrice = parsePrice(f.minPrice, market);
  const tick = parsePrice(f.tick, market);
  if (minPrice === null || minPrice === 0n) errors.minPrice = `Enter a price above zero with at most ${f.quoteDecimals} decimal places.`;
  if (tick === null || tick === 0n) errors.tick = `Enter a step above zero with at most ${f.quoteDecimals} decimal places.`;
  if (!Number.isInteger(f.ticks) || f.ticks < 2 || f.ticks > 256) errors.ticks = 'Use between 2 and 256 price levels.';
  if (!/^\d{1,20}$/.test(f.crossId)) errors.crossId = 'Cross number must be a whole number.';

  const open = BigInt(Math.floor(f.openAt.getTime() / 1000));
  const close = BigInt(Math.floor(f.closeAt.getTime() / 1000));
  if (Number.isNaN(f.openAt.getTime())) errors.openAt = 'Choose when orders open.';
  else if (f.openAt.getTime() < now.getTime() - 60_000) errors.openAt = 'The call cannot open in the past.';
  if (Number.isNaN(f.closeAt.getTime()) || close <= open) errors.closeAt = 'The call must close after it opens.';
  const revealEnd = f.disclosure === 'sealed' ? close + BigInt(Math.round(f.revealMinutes * 60)) : close;
  if (f.disclosure === 'sealed' && !(f.revealMinutes >= 1)) errors.revealMinutes = 'Give bidders at least a minute to reveal.';

  const minMatched = f.minMatched.trim() === '' ? 0n : parseAtoms(f.minMatched, f.baseDecimals);
  if (minMatched === null) errors.minMatched = `Enter a number of tokens with at most ${f.baseDecimals} decimal places.`;
  let maxImbalanceBps: number | null = null;
  if (f.maxImbalancePct.trim() !== '') {
    const v = Number(f.maxImbalancePct);
    if (!Number.isFinite(v) || v < 0 || v > 100 || Math.round(v * 100) !== v * 100) errors.maxImbalancePct = 'Enter a percentage between 0 and 100 with at most two decimals.';
    else maxImbalanceBps = Math.round(v * 100);
  }
  if (!Number.isInteger(f.integratorFeeBps) || f.integratorFeeBps < 0 || f.integratorFeeBps > 300) errors.integratorFeeBps = 'Integrator fee is 0 to 300 basis points.';
  if (!Number.isInteger(f.maxOrders) || f.maxOrders < 1) errors.maxOrders = 'Allow at least one order.';
  if (!Number.isInteger(f.shards) || f.shards < 1 || f.shards > 32) errors.shards = 'Use 1 to 32 shards.';

  const schedule: { price: string; quantity: string }[] = [];
  if (f.supplyMode === 'mint') {
    if (f.schedule.length === 0) errors.schedule = 'A minting cross needs at least one supply step.';
    let last = -1n;
    f.schedule.forEach((s, i) => {
      const p = parsePrice(s.price, market);
      const q = parseAtoms(s.quantity, f.baseDecimals);
      if (p === null || q === null || q === 0n) {
        errors[`schedule.${i}`] = 'Each step needs a price and a token amount.';
        return;
      }
      if (minPrice !== null && tick !== null && tick > 0n) {
        const max = minPrice + BigInt(f.ticks - 1) * tick;
        if (p < minPrice || p > max || (p - minPrice) % tick !== 0n) errors[`schedule.${i}`] = 'This price is not on the grid.';
      }
      if (p <= last) errors[`schedule.${i}`] = 'Steps must rise in price.';
      last = p;
      schedule.push({ price: p.toString(), quantity: q.toString() });
    });
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    body: {
      creator: f.creator,
      ...(f.supplyMode === 'escrow' || f.baseMint ? { baseMint: f.baseMint } : {}),
      quoteMint: f.quoteMint,
      baseTokenProgram: f.baseTokenProgram,
      quoteTokenProgram: f.quoteTokenProgram,
      crossId: f.crossId,
      kind: f.kind,
      supplyMode: f.supplyMode,
      disclosure: f.disclosure,
      minPrice: minPrice!.toString(),
      tick: tick!.toString(),
      ticks: f.ticks,
      priceScale: priceScale.toString(),
      openTs: open.toString(),
      closeTs: close.toString(),
      revealEndTs: revealEnd.toString(),
      minMatched: minMatched!.toString(),
      maxImbalanceBps,
      integratorFeeBps: f.integratorFeeBps,
      integrator: f.integrator,
      shards: f.shards,
      maxOrders: f.maxOrders,
      proceedsTo: f.proceedsTo,
      schedule,
    },
  };
}
