// Turning results into text for people and JSON for scripts.
import { type CrossDetail, formatAtoms, formatDuration, formatPrice, marketOf, phaseOf, shortAddress } from '@opening-cross/client';
import type { Context } from './context.js';

export const jsonText = (v: unknown, space?: number): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x), space);

/** One result: JSON in `--json` mode, otherwise the lines. */
export function emit(ctx: Context, data: unknown, lines: readonly string[]): void {
  if (ctx.json) ctx.io.out(jsonText(data, 2));
  else for (const l of lines) ctx.io.out(l);
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const width = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(width[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function kv(rows: readonly (readonly [string, string])[]): string[] {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`);
}

const utc = (ts: string) => new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

/** What a cross is and where it stands, in words. `now` is the cluster's clock in unix seconds. */
export function describeCross(c: CrossDetail, now: bigint): string[] {
  const m = marketOf(c);
  const phase = phaseOf(c, now);
  const next = phase === 'upcoming' ? c.window.openTs : phase === 'open' ? c.window.closeTs : phase === 'reveal' ? c.window.revealEndTs : null;
  const rows: [string, string][] = [
    ['cross', c.address],
    ['state', `${c.state}${c.state === 'Live' ? ` (${phase.replace('-', ' ')})` : ''}`],
    ['kind', `${c.kind}, ${c.disclosure === 'sealed' ? 'sealed bids' : 'open book'}, ${c.supplyMode} supply`],
    ['creator', c.creator],
    ['base mint', c.baseMint ?? 'minted at settlement'],
    ['quote mint', c.quoteMint],
    ['price grid', `${formatPrice(BigInt(c.grid.minPrice), m)} to ${formatPrice(BigInt(c.grid.minPrice) + BigInt(c.grid.ticks - 1) * BigInt(c.grid.tick), m)} in steps of ${formatPrice(BigInt(c.grid.tick), m)} quote per base token`],
    ['window (UTC)', `opens ${utc(c.window.openTs)}, closes ${utc(c.window.closeTs)}${c.disclosure === 'sealed' ? `, reveals until ${utc(c.window.revealEndTs)}` : ''}`],
    ['orders', `${c.orders.total} placed, ${c.orders.open} still open, at most ${c.orders.max}`],
    ['seller fee', `${(c.fees.protocolBps + c.fees.integratorBps) / 100}% of proceeds (${c.fees.protocolBps / 100}% protocol, ${c.fees.integratorBps / 100}% integrator); none for buyers`],
  ];
  if (next) rows.splice(2, 0, [phase === 'upcoming' ? 'opens in' : phase === 'open' ? 'closes in' : 'reveal closes in', formatDuration(BigInt(next) - now)]);
  if (c.gateMint) rows.push(['gate', `an eligibility pass for ${shortAddress(c.gateMint)} is required`]);
  if (c.oracleGuard) rows.push(['oracle guard', 'the cross does not print if the clearing price strays from the Pyth price']);
  if (c.clearing) rows.push(['cleared', `${formatPrice(BigInt(c.clearing.price), m)} quote per base token, ${formatAtoms(BigInt(c.clearing.matched), m.baseDecimals)} base tokens traded${c.clearing.rationed === 'none' ? '' : `, ${c.clearing.rationed} side rationed`}`]);
  if (c.noPrintReason) rows.push(['did not print', `${c.noPrintReason}; every order is refunded in full`]);
  return kv(rows);
}
