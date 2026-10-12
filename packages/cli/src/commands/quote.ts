import { formatAtoms, formatPrice, marketOf, parseAtoms, parsePrice } from '@opening-cross/client';
import { type CommandDef, noExtra, positional } from '../command.js';
import { EXIT, UsageError } from '../exit.js';
import { emit, kv } from '../format.js';
import { addressArg, loadCross, sideArg, stringOpt } from '../inputs.js';

const quote: CommandDef = {
  path: ['quote'],
  summary: 'Compare joining a cross with the best DEX route for the same order (best execution), when the deployment offers the router.',
  args: '<cross>',
  options: {
    side: { type: 'string', value: 'buy|sell', description: 'required' },
    quantity: { type: 'string', value: 'decimal', description: 'base tokens (required)' },
    'limit-price': { type: 'string', value: 'decimal', description: 'your limit in quote tokens per base token' },
  },
  async run(ctx, args) {
    noExtra(args, 1);
    const crossAddr = addressArg(positional(args, 0, 'cross'), '<cross>');
    const side = sideArg(stringOpt(args.values.side));
    const c = await loadCross(ctx, crossAddr);
    const m = marketOf(c.detail);
    const qText = stringOpt(args.values.quantity);
    const qty = qText === undefined ? null : parseAtoms(qText, m.baseDecimals);
    if (qty === null || qty === 0n) throw new UsageError(`--quantity must be an amount of base tokens, up to ${m.baseDecimals} decimal places${qText === undefined ? ' (required)' : ` (got "${qText}")`}.`);
    const limitText = stringOpt(args.values['limit-price']);
    let limit: bigint | undefined;
    if (limitText !== undefined) {
      const p = parsePrice(limitText, m);
      if (p === null) throw new UsageError(`--limit-price "${limitText}" is not a price this cross can represent.`);
      limit = p;
    }
    const answer = await ctx.api().routeQuote({ cross: crossAddr, side, quantity: qty.toString(), ...(limit !== undefined ? { limitPrice: limit.toString() } : {}) });
    if (answer.status === 'unavailable') {
      emit(ctx, answer, [answer.reason]);
      return EXIT.UNAVAILABLE;
    }
    const r = answer.report as { recommendation?: string; caveats?: string[]; comparison?: { crossPrice: string | null; dexPrice: string | null; crossBetterByBps: number | null; filledOnCross: string; filledOnDex: string } };
    const cmp = r.comparison;
    emit(ctx, answer.report, [
      ...kv([
        ['order', `${side} ${formatAtoms(qty, m.baseDecimals)} base tokens`],
        ['recommendation', r.recommendation ?? 'none'],
        ...(cmp ? ([['cross price', cmp.crossPrice ? formatPrice(BigInt(cmp.crossPrice), m) : 'none'], ['dex price', cmp.dexPrice ? formatPrice(BigInt(cmp.dexPrice), m) : 'none'], ['cross better by', cmp.crossBetterByBps === null ? 'n/a' : `${cmp.crossBetterByBps} bps`]] as [string, string][]) : []),
      ]),
      ...(r.caveats ?? []).map((cv) => `caveat: ${cv}`),
    ]);
    return EXIT.OK;
  },
};

export const quoteCommands: CommandDef[] = [quote];
