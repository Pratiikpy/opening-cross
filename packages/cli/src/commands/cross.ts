import { CROSS_CORE_PROGRAM_ADDRESS } from '@opening-cross/sdk';
import { type CrossStateName, compareCross, formatAtoms, formatPrice, marketOf, readBookFromChain, shortAddress } from '@opening-cross/client';
import { verifyCross } from '@opening-cross/verifier';
import { address as toAddress } from '@solana/kit';
import { type CommandDef, noExtra, positional } from '../command.js';
import type { Context } from '../context.js';
import { EXIT, UsageError } from '../exit.js';
import { describeCross, emit, kv, table } from '../format.js';
import { addressArg, loadCross, stringOpt } from '../inputs.js';

const STATES = ['Live', 'Cleared', 'NoPrint', 'Finalized'];

const list: CommandDef = {
  path: ['cross', 'list'],
  summary: 'List crosses the API has indexed, newest first.',
  args: '',
  options: {
    state: { type: 'string', value: 'state', description: `only crosses in this state (${STATES.join(', ')})` },
    limit: { type: 'string', value: 'n', description: 'how many, 1 to 200 (default 50)' },
  },
  examples: ['opening-cross cross list --api http://localhost:8080 --state Live'],
  async run(ctx, args) {
    noExtra(args, 0);
    const state = stringOpt(args.values.state);
    if (state !== undefined && !STATES.includes(state)) throw new UsageError(`--state must be one of ${STATES.join(', ')} (got "${state}").`);
    const limitText = stringOpt(args.values.limit);
    if (limitText !== undefined && !/^\d+$/.test(limitText)) throw new UsageError(`--limit must be a whole number (got "${limitText}").`);
    const limit = limitText === undefined ? undefined : Number(limitText);
    if (limit !== undefined && (limit < 1 || limit > 200)) throw new UsageError('--limit must be from 1 to 200.');
    const crosses = await ctx.api().listCrosses({ ...(state ? { state: state as CrossStateName } : {}), ...(limit !== undefined ? { limit } : {}) });
    emit(ctx, { crosses }, crosses.length === 0 ? ['No crosses.'] : table(['CROSS', 'STATE', 'BASE', 'QUOTE', 'PRICE', 'ORDERS'], crosses.map((c) => [c.address, c.state, shortAddress(c.base_mint), shortAddress(c.quote_mint), c.clearing_price ?? '-', String(c.orders_committed)])));
    return EXIT.OK;
  },
};

const get: CommandDef = {
  path: ['cross', 'get'],
  summary: 'Show one cross, read from the cluster itself.',
  args: '<cross>',
  options: { verify: { type: 'boolean', description: 'also ask the API and report every field on which it differs from the chain (needs --api)' } },
  examples: ['opening-cross cross get F5k8...QPnZ --cluster devnet'],
  async run(ctx, args) {
    noExtra(args, 1);
    const c = await loadCross(ctx, addressArg(positional(args, 0, 'cross'), '<cross>'));
    const verification = args.values.verify === true ? await verifyAgainstApi(ctx, c.detail) : null;
    emit(ctx, { ...c.detail, now: c.now.toString(), ...(verification ? { verification } : {}) }, [...describeCross(c.detail, c.now), ...(verification ? ['', ...verificationLines(verification)] : [])]);
    return verification && !verification.matches && verification.differences.some((d) => !d.volatile) ? EXIT.FAILED : EXIT.OK;
  },
};

async function verifyAgainstApi(ctx: Context, chain: Awaited<ReturnType<typeof loadCross>>['detail']) {
  const api = await ctx.api().getCross(chain.address);
  return compareCross(api, chain);
}

function verificationLines(v: ReturnType<typeof compareCross>): string[] {
  if (v.matches) return ['API and cluster agree on every field.'];
  return ['API and cluster differ:', ...v.differences.map((d) => `  ${d.path}: API says ${JSON.stringify(d.api)}, cluster says ${JSON.stringify(d.chain)}${d.volatile ? ' (can change between two reads)' : ''}`)];
}

const book: CommandDef = {
  path: ['cross', 'book'],
  summary: 'Show the resting book and the price the cross would clear at now.',
  args: '<cross>',
  options: {},
  async run(ctx, args) {
    noExtra(args, 1);
    const c = await loadCross(ctx, addressArg(positional(args, 0, 'cross'), '<cross>'));
    const b = await readBookFromChain(ctx.rpc, c.detail.address, c.data);
    const m = marketOf(c.detail);
    const lines =
      b.levels.length === 0
        ? [b.disclosure === 'sealed' ? 'Nothing is visible: sealed bids carry no price until they are revealed.' : 'The book is empty.']
        : table(['PRICE', 'BUY', 'BUY ORDERS', 'SELL', 'SELL ORDERS'], b.levels.map((l) => [formatPrice(BigInt(l.price), m), formatAtoms(BigInt(l.buy), m.baseDecimals), String(l.buyOrders), formatAtoms(BigInt(l.sell), m.baseDecimals), String(l.sellOrders)]));
    if (b.indicative) lines.push('', `Would clear at ${formatPrice(BigInt(b.indicative.price), m)} quote per base token, ${formatAtoms(BigInt(b.indicative.matched), m.baseDecimals)} base tokens.`);
    lines.push('', b.note);
    emit(ctx, b, lines);
    return EXIT.OK;
  },
};

async function proofOf(ctx: Context, addr: string) {
  const fetcher = async (a: string) => {
    const acct = await ctx.rpc.getAccount(a);
    return acct && acct.owner === CROSS_CORE_PROGRAM_ADDRESS ? acct.data : null;
  };
  try {
    return await verifyCross(fetcher as Parameters<typeof verifyCross>[0], toAddress(addr));
  } catch (e) {
    throw new UsageError(`Could not verify ${addr}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

function proofLines(p: Awaited<ReturnType<typeof proofOf>>): string[] {
  return [
    ...kv([
      ['cross', p.cross],
      ['state', p.state],
      ['recorded on chain', p.onchain.printed ? `printed at ${p.onchain.price} (${p.onchain.matched} matched)` : p.state === 'Live' ? 'not settled yet' : 'did not print'],
      ['recomputed', p.recomputed.printed ? `printed at ${p.recomputed.price} (${p.recomputed.matched} matched)` : `did not print${p.recomputed.noPrintReason ? ` (${p.recomputed.noPrintReason})` : ''}`],
      ['verdict', p.verified ? 'VERIFIED: a second implementation of the clearing rule reproduces the on-chain result exactly' : 'NOT VERIFIED'],
    ]),
    ...p.notes.map((n) => `note: ${n}`),
  ];
}

const proof: CommandDef = {
  path: ['cross', 'proof'],
  summary: 'Recompute a cleared cross from its on-chain book and compare it with the recorded result.',
  args: '<cross>',
  options: {},
  async run(ctx, args) {
    noExtra(args, 1);
    const p = await proofOf(ctx, addressArg(positional(args, 0, 'cross'), '<cross>'));
    emit(ctx, p, proofLines(p));
    return p.verified ? EXIT.OK : EXIT.FAILED;
  },
};

const verify: CommandDef = {
  path: ['verify'],
  summary: 'Same as `cross proof`: exit 0 only if the recomputed clearing equals the on-chain record.',
  args: '<cross>',
  options: {},
  examples: ['opening-cross verify F5k8...QPnZ --cluster devnet'],
  async run(ctx, args) {
    noExtra(args, 1);
    const p = await proofOf(ctx, addressArg(positional(args, 0, 'cross'), '<cross>'));
    emit(ctx, p, proofLines(p));
    return p.verified ? EXIT.OK : EXIT.FAILED;
  },
};

export const crossCommands: CommandDef[] = [list, get, book, proof, verify];
