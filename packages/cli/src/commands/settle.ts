import { type CommandDef, noExtra, positional } from '../command.js';
import { EXIT } from '../exit.js';
import { dryRunLines, execute, exitFor } from '../act.js';
import { describeCross, emit } from '../format.js';
import { actingAddress, addressArg, loadCross, stringOpt } from '../inputs.js';
import type { Context } from '../context.js';

async function finish(ctx: Context, cross: string, r: Awaited<ReturnType<typeof execute>>, what: string): Promise<number> {
  if (r.mode === 'dry-run') {
    emit(ctx, { cross, dryRun: true, simulations: r.simulations }, dryRunLines(r));
    return exitFor(r);
  }
  const after = await loadCross(ctx, cross);
  emit(ctx, { cross, signatures: r.signatures, state: after.detail.state, clearing: after.detail.clearing, noPrintReason: after.detail.noPrintReason }, [what, ...r.signatures.map((s) => `signature ${s}`), '', ...describeCross(after.detail, after.now)]);
  return EXIT.OK;
}

const settle: CommandDef = {
  path: ['settle'],
  summary: 'Settle a cross after its call (and reveal window) ends: merge every book shard, then clear. Anyone may settle.',
  args: '<cross>',
  signs: true,
  options: { payer: { type: 'string', value: 'address', description: 'with --dry-run and no key: simulate for this wallet' }, 'oracle-price': { type: 'string', value: 'address', description: 'the Pyth price update account, for crosses with an oracle guard' } },
  async run(ctx, args) {
    noExtra(args, 1);
    const cross = addressArg(positional(args, 0, 'cross'), '<cross>');
    const oracle = stringOpt(args.values['oracle-price']);
    const built = await ctx.builder().settle({ cross, payer: await actingAddress(ctx, stringOpt(args.values.payer), '--payer'), ...(oracle ? { oraclePrice: addressArg(oracle, '--oracle-price') } : {}) });
    return finish(ctx, cross, await execute(ctx, built), 'Settled.');
  },
};

const finalize: CommandDef = {
  path: ['finalize'],
  summary: 'Pay the protocol and integrator fees and the issuer’s proceeds once every order has been claimed.',
  args: '<cross>',
  signs: true,
  options: { payer: { type: 'string', value: 'address', description: 'with --dry-run and no key: simulate for this wallet' } },
  async run(ctx, args) {
    noExtra(args, 1);
    const cross = addressArg(positional(args, 0, 'cross'), '<cross>');
    const built = await ctx.builder().finalize({ cross, payer: await actingAddress(ctx, stringOpt(args.values.payer), '--payer') });
    return finish(ctx, cross, await execute(ctx, built), 'Finalized.');
  },
};

const initShards: CommandDef = {
  path: ['init-shards'],
  summary: 'Finish a cross whose create stopped before every book shard existed. Anyone may pay for the missing shards.',
  args: '<cross>',
  signs: true,
  options: { payer: { type: 'string', value: 'address', description: 'with --dry-run and no key: simulate for this wallet' } },
  async run(ctx, args) {
    noExtra(args, 1);
    const cross = addressArg(positional(args, 0, 'cross'), '<cross>');
    const built = await ctx.builder().initShards({ cross, payer: await actingAddress(ctx, stringOpt(args.values.payer), '--payer') });
    return finish(ctx, cross, await execute(ctx, built), 'Shards created.');
  },
};

export const settleCommands: CommandDef[] = [settle, finalize, initShards];
