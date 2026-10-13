// Presets for the issuer form. A preset only fills fields the issuer can see and change; it never picks a price or a supply, because
// those belong to the token being issued. It is a starting shape (format, how many price levels, how long the call runs), not advice
// about what a good raise looks like. packages/presets holds no definitions yet, so these are the ones the console ships with.
import { formatAtoms, parseAtoms } from './units';

export type PresetFields = {
  kind: 'launch' | 'reopen' | 'tender' | 'recurring';
  disclosure: 'sealed' | 'open';
  supplyMode: 'escrow' | 'mint';
  ticks: number;
  /** The step between prices as a share of the lowest price, in basis points; applied only where it lands exactly on a quote atom. */
  stepBps: number;
  openInMinutes: number;
  callMinutes: number;
  revealMinutes: number;
  maxOrders: number;
};

export type Preset = { id: string; name: string; summary: string; fields: PresetFields };

export const PRESETS: readonly Preset[] = [
  {
    id: 'sealed-launch',
    name: 'Sealed launch',
    summary: 'A new token minted at settlement. Sealed bids, a 24 hour call and a 30 minute reveal.',
    fields: { kind: 'launch', disclosure: 'sealed', supplyMode: 'mint', ticks: 40, stepBps: 500, openInMinutes: 60, callMinutes: 24 * 60, revealMinutes: 30, maxOrders: 1000 },
  },
  {
    id: 'open-launch',
    name: 'Open-book launch',
    summary: 'A new token minted at settlement. Everyone sees the book as orders arrive; a 6 hour call.',
    fields: { kind: 'launch', disclosure: 'open', supplyMode: 'mint', ticks: 40, stepBps: 500, openInMinutes: 60, callMinutes: 6 * 60, revealMinutes: 30, maxOrders: 1000 },
  },
  {
    id: 'reopen',
    name: 'Reopening auction',
    summary: 'A token that already trades, sold from escrow through an open book over 4 hours.',
    fields: { kind: 'reopen', disclosure: 'open', supplyMode: 'escrow', ticks: 60, stepBps: 100, openInMinutes: 60, callMinutes: 4 * 60, revealMinutes: 30, maxOrders: 1000 },
  },
  {
    id: 'tender',
    name: 'Sealed tender',
    summary: 'Holders offer tokens from escrow to a sealed call over 48 hours.',
    fields: { kind: 'tender', disclosure: 'sealed', supplyMode: 'escrow', ticks: 60, stepBps: 100, openInMinutes: 60, callMinutes: 48 * 60, revealMinutes: 60, maxOrders: 1000 },
  },
  {
    id: 'recurring',
    name: 'Daily recurring call',
    summary: 'A short open-book call for a token with a standing supply schedule, 2 hours long.',
    fields: { kind: 'recurring', disclosure: 'open', supplyMode: 'mint', ticks: 40, stepBps: 200, openInMinutes: 60, callMinutes: 120, revealMinutes: 30, maxOrders: 1000 },
  },
];

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * The form values a preset sets. The step is `stepBps` of the lowest price when that is exact at the quote token's decimals; otherwise
 * the current step stays, and `stepKept` says so. The supply schedule is only kept (never invented) and the lowest price is never touched.
 */
export function applyPreset(p: Preset, current: { minPrice: string; tick: string; quoteDecimals: number | null }, now: Date) {
  const f = p.fields;
  let tick = current.tick;
  let stepKept = true;
  if (current.quoteDecimals !== null) {
    const min = parseAtoms(current.minPrice, current.quoteDecimals);
    if (min !== null && min > 0n && (min * BigInt(f.stepBps)) % 10_000n === 0n) {
      const step = (min * BigInt(f.stepBps)) / 10_000n;
      tick = formatAtoms(step, current.quoteDecimals);
      stepKept = false;
    }
  }
  const open = new Date(now.getTime() + f.openInMinutes * 60_000);
  return {
    fields: {
      kind: f.kind,
      disclosure: f.disclosure,
      supplyMode: f.supplyMode,
      ticks: f.ticks,
      tick,
      openAt: toLocalInput(open),
      closeAt: toLocalInput(new Date(open.getTime() + f.callMinutes * 60_000)),
      revealMinutes: f.revealMinutes,
      maxOrders: f.maxOrders,
    },
    stepKept,
  };
}
