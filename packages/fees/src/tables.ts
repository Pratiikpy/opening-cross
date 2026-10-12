// The tables of docs/economics/FEE_MODEL.md, rendered from the model so the document cannot disagree with the code. The
// document marks each generated block with `<!-- generated:NAME -->` and `<!-- /generated -->`; `tools/model.ts` rewrites
// the blocks and a test fails if the committed document differs from what this file renders.
import { PROPOSED_RATE_CARD } from './invoice.js';
import { breakEvenNotional, runModel } from './model.js';
import { KINDS, type CrossKind, type FeeSchedule, PROPOSED_SCHEDULE, protocolFeeBps } from './schedule.js';

const M = 1_000_000n;
const usd = (microUsd: bigint): string => {
  const whole = microUsd / M;
  const cents = ((microUsd % M) * 100n) / M;
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
};
const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
const table = (head: readonly string[], rows: readonly (readonly string[])[]): string => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

const INTEGRATOR_BPS = [0, 20, 60, 120, 300] as const;
const LABEL: Record<CrossKind, string> = { launch: 'Launch', reopen: 'Reopen or halt', tender: 'Tender or block sale', recurring: 'Recurring cross' };

/** Per 1,000,000 USD of filled notional: what the paying side is charged and what the protocol keeps, by kind and integrator fee. */
export function unitEconomics(schedule: FeeSchedule = PROPOSED_SCHEDULE): string {
  const rows: string[][] = [];
  for (const k of KINDS) {
    for (const i of INTEGRATOR_BPS) {
      const flow = { notional: 1_000_000n * M, integratorBps: i, referredBps: 0 };
      const none = { notional: 0n, integratorBps: 0, referredBps: 0 };
      const r = runModel({ name: 'unit', flows: { launch: none, reopen: none, tender: none, recurring: none, [k]: flow }, subscriptions: {}, listings: [], usage: {} }, schedule);
      const kr = r.byKind[k];
      rows.push([LABEL[k], String(i), String(kr.protocolBps), String(kr.protocolBps + i), usd(kr.totalFee), usd(kr.protocolFee), usd(r.protocolNet), usd(kr.integratorFee)]);
    }
  }
  return table(['Kind', 'Integrator bps', 'Protocol bps', 'Total bps', 'Total fee, USD', 'Protocol fee, USD', 'Protocol net of rebate pool, USD', 'Integrator, USD'], rows);
}

/** What the same flow would cost the paying side at doubled and halved protocol schedules: the rates are inputs, and this shows how much they matter. */
export function scheduleSensitivity(): string {
  const variants: [string, FeeSchedule][] = [
    ['Half', [15, 3, 8, 15]],
    ['Proposed', PROPOSED_SCHEDULE],
    ['Double', [60, 10, 30, 60]],
  ];
  const rows = variants.map(([name, s]) => {
    const cells = KINDS.map((k) => `${protocolFeeBps(s, k, 300)} / ${protocolFeeBps(s, k, 120)}`);
    return [name, ...cells];
  });
  return table(['Schedule', ...KINDS.map((k) => `${LABEL[k]} (integrator 300 / 120 bps)`)], rows);
}

/** The monthly notional at which operating revenue equals an assumed monthly cost, for a stated mix. */
export function breakEvenTable(): string {
  const mixes: [string, Record<CrossKind, number>][] = [
    ['All launches', { launch: 10_000, reopen: 0, tender: 0, recurring: 0 }],
    ['Half reopens, half recurring', { launch: 0, reopen: 5_000, tender: 0, recurring: 5_000 }],
    ['Reopens only', { launch: 0, reopen: 10_000, tender: 0, recurring: 0 }],
  ];
  const rows: string[][] = [];
  for (const [name, mix] of mixes) {
    for (const cost of [10_000n, 50_000n, 200_000n]) {
      const cells = [60, 120].map((i) => {
        const n = breakEvenNotional(cost * M, mix, i, 0n);
        return n === null ? 'never' : usd(n);
      });
      rows.push([name, usd(cost * M), ...cells]);
    }
  }
  return table(['Flow mix', 'Assumed monthly cost, USD', 'Break-even notional at 60 integrator bps, USD', 'at 120 bps, USD'], rows);
}

/** Subscription and listing lines of the proposed rate card, as a share of a stated notional. */
export function metered(): string {
  const c = PROPOSED_RATE_CARD;
  const rows = c.plans.map((p) => [p.plan, `${p.periodDays} days`, usd(p.priceUnits), String(p.includedCrosses), usd(p.overagePerCrossUnits)]);
  return table(['Plan', 'Period', 'Price, USD', 'Crosses included', 'Each extra, USD'], rows);
}

export const BLOCKS: Record<string, () => string> = { 'unit-economics': () => unitEconomics(), 'schedule-sensitivity': scheduleSensitivity, 'break-even': breakEvenTable, metered };

const BLOCK = /<!-- generated:([a-z-]+) -->\n([\s\S]*?)<!-- \/generated -->/g;

/** Replaces the content of every generated block in a document with what the model renders now. */
export function renderDocument(doc: string): string {
  return doc.replace(BLOCK, (_m, name: string) => {
    const f = BLOCKS[name];
    if (!f) throw new Error(`the document has a generated block "${name}" that tables.ts does not render`);
    return `<!-- generated:${name} -->\n${f()}\n<!-- /generated -->`;
  });
}
