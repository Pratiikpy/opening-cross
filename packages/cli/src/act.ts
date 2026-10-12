// Runs a built action: simulate it (`--dry-run`) or sign, send and confirm it. One place, so every write command
// behaves the same way and reports the same facts.
import { type BuiltAction, type DryRunResult, ActionError, dryRun, signSendConfirm } from '@opening-cross/client';
import type { Context } from './context.js';
import { EXIT } from './exit.js';
import { progress } from './inputs.js';

export type Executed =
  | { mode: 'sent'; signatures: string[] }
  | { mode: 'dry-run'; simulations: DryRunResult[]; ok: boolean };

/** Sends the action's transactions in order. On a partial failure the error says how many landed. */
export async function execute(ctx: Context, built: BuiltAction): Promise<Executed> {
  if (built.transactions.length === 0) throw new ActionError('Nothing to send: the builder returned no transactions.', 'API_REFUSED');
  if (ctx.dryRun) {
    const simulations = await dryRun(built.transactions, ctx.rpc);
    return { mode: 'dry-run', simulations, ok: simulations.every((s) => s.simulation.err === null) };
  }
  const { sign } = await ctx.signer();
  const onStatus = progress(ctx);
  const signatures = await signSendConfirm(built.transactions, { rpc: ctx.rpc, sign, ...(onStatus ? { onStatus } : {}), ...(ctx.runtime.sleep ? { sleep: ctx.runtime.sleep } : {}) });
  return { mode: 'sent', signatures };
}

export function dryRunLines(r: Extract<Executed, { mode: 'dry-run' }>): string[] {
  const lines = [`Dry run: ${r.simulations.length} transaction${r.simulations.length === 1 ? '' : 's'} simulated against the cluster. Nothing was signed, sent or saved.`];
  for (const s of r.simulations) {
    const status = s.simulation.err === null ? 'would succeed' : `would fail: ${s.simulation.explanation ?? JSON.stringify(s.simulation.err)}`;
    lines.push(`  transaction ${s.index + 1}: ${status}${s.simulation.unitsConsumed !== null ? ` (${s.simulation.unitsConsumed} compute units)` : ''}`);
    if (s.note) lines.push(`    ${s.note}`);
  }
  return lines;
}

export const exitFor = (r: Executed): number => (r.mode === 'dry-run' && !r.ok ? EXIT.FAILED : EXIT.OK);
