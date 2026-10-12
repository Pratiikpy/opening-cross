import { address as toAddress } from '@solana/kit';
import { ORDER_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, getOrderDecoder, orderAddress } from '@opening-cross/sdk';
import {
  ActionError,
  bytesOfHex,
  marketOf,
  phaseOf,
  previewOrder,
  randomSalt,
  validateOrderInput,
} from '@opening-cross/client';
import { type CommandDef, noExtra, positional } from '../command.js';
import type { Context } from '../context.js';
import { EXIT, UsageError } from '../exit.js';
import { dryRunLines, execute, exitFor } from '../act.js';
import { emit, kv, table } from '../format.js';
import { actingAddress, addressArg, freshNonce, loadCross, sideArg, stringOpt, u64Arg } from '../inputs.js';

const NONCE = { type: 'string', value: 'n', description: 'the order’s nonce (printed when it was placed)' } as const;

/** What the order looks like on chain now: open orders exist as accounts; claimed and cancelled ones are closed. */
async function orderStatus(ctx: Context, cross: string, owner: string, nonce: bigint): Promise<string> {
  const addr = await orderAddress(toAddress(cross), toAddress(owner), nonce);
  const acct = await ctx.rpc.getAccount(addr);
  const disc = ORDER_DISCRIMINATOR as Uint8Array;
  if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !disc.every((b, i) => acct.data[i] === b)) return 'closed (claimed or cancelled)';
  return getOrderDecoder().decode(acct.data).state === 1 ? 'open, revealed' : 'open, committed';
}

const place: CommandDef = {
  path: ['order', 'place'],
  summary: 'Place a buy or sell order in a live cross. Sealed crosses keep your salt in the vault file before anything is sent.',
  args: '<cross>',
  signs: true,
  options: {
    side: { type: 'string', value: 'buy|sell', description: 'required' },
    price: { type: 'string', value: 'decimal', description: 'your limit, in quote tokens per base token, on the cross’s grid' },
    quantity: { type: 'string', value: 'decimal', description: 'base tokens' },
    nonce: { type: 'string', value: 'n', description: 'default: random' },
    escrow: { type: 'string', value: 'atoms', description: 'sealed buyers only: escrow more than the exact cost to hide the price' },
    owner: { type: 'string', value: 'address', description: 'with --dry-run and no key: simulate for this wallet' },
  },
  examples: ['opening-cross order place F5k8...QPnZ --side buy --price 1.25 --quantity 100 --keypair ~/.config/solana/id.json --cluster devnet'],
  async run(ctx, args) {
    noExtra(args, 1);
    const crossAddr = addressArg(positional(args, 0, 'cross'), '<cross>');
    const side = sideArg(stringOpt(args.values.side));
    const owner = await actingAddress(ctx, stringOpt(args.values.owner));
    const c = await loadCross(ctx, crossAddr);
    const market = marketOf(c.detail);
    const v = validateOrderInput(c.detail, market, { side, priceText: stringOpt(args.values.price) ?? '', quantityText: stringOpt(args.values.quantity) ?? '' });
    if (!v.ok) {
      throw new UsageError(v.priceError ?? v.quantityError ?? `${stringOpt(args.values.price) === undefined ? '--price' : '--quantity'} is required.`);
    }
    const phase = phaseOf(c.detail, c.now);
    if (phase !== 'open') throw new ActionError(`This cross is not accepting orders: it is ${phase === 'upcoming' ? 'not open yet' : phase === 'settled' ? `already ${c.detail.state}` : 'past its closing time'}.`, 'CONFLICT');
    const nonceText = stringOpt(args.values.nonce);
    const nonce = nonceText === undefined ? freshNonce() : u64Arg(nonceText, '--nonce');
    const escrowText = stringOpt(args.values.escrow);
    const escrow = escrowText === undefined ? undefined : u64Arg(escrowText, '--escrow');
    const preview = previewOrder(c.detail, market, side, v.price, v.quantity);
    if (escrow !== undefined && (side !== 'buy' || !preview.sealed)) throw new UsageError('--escrow is for sealed buy orders only.');
    if (escrow !== undefined && escrow < preview.escrow) throw new UsageError(`--escrow must be at least the exact cost, ${preview.escrow} quote atoms.`);

    const sealed = c.detail.disclosure === 'sealed';
    const salt = sealed ? bytesOfHex(randomSalt()) : undefined;
    const store = ctx.store();
    // A sealed bid is useless without its salt: it is stored before anything is built or signed, and never in a dry run.
    if (sealed && !ctx.dryRun) await store.save({ cross: crossAddr, owner, nonce: nonce.toString(), side, price: v.price.toString(), quantity: v.quantity.toString(), salt: Buffer.from(salt!).toString('hex'), placedAt: new Date().toISOString() });

    const built = await ctx.builder().placeOrder({ cross: crossAddr, owner, nonce, side, price: v.price, quantity: v.quantity, ...(escrow !== undefined ? { escrow } : {}), ...(salt ? { salt } : {}) });
    const orderAddr = String(built.extra.order ?? (await orderAddress(toAddress(crossAddr), toAddress(owner), nonce)));
    const r = await execute(ctx, built);
    const data = { cross: crossAddr, owner, nonce: nonce.toString(), order: orderAddr, side, price: v.price.toString(), quantity: v.quantity.toString(), escrow: (escrow ?? preview.escrow).toString(), sealed };
    if (r.mode === 'dry-run') {
      emit(ctx, { ...data, dryRun: true, simulations: r.simulations }, [...previewLines(preview), '', ...dryRunLines(r)]);
      return exitFor(r);
    }
    await store.remember(crossAddr, owner, orderAddr);
    const status = await orderStatus(ctx, crossAddr, owner, nonce);
    const after = await loadCross(ctx, crossAddr);
    emit(ctx, { ...data, signatures: r.signatures, status, crossOrders: after.detail.orders, ...(sealed ? { vault: 'saved' } : {}) }, [
      ...previewLines(preview),
      '',
      `Order placed. Nonce ${nonce}, order account ${orderAddr}`,
      ...r.signatures.map((s) => `signature ${s}`),
      `order status: ${status}; the cross now has ${after.detail.orders.total} orders`,
      ...(sealed ? ['Your price and amount are sealed. The salt is in the vault file; keep it, you need it to reveal after the cross closes.'] : []),
    ]);
    return EXIT.OK;
  },
};

function previewLines(p: ReturnType<typeof previewOrder>): string[] {
  return kv(p.lines.map((l) => [l.label, l.text] as const));
}

const need = (args: { values: Record<string, string | boolean | undefined> }, key: string): bigint => u64Arg(stringOpt(args.values[key]), `--${key}`);

const cancel: CommandDef = {
  path: ['order', 'cancel'],
  summary: 'Withdraw an order while the cross is open. Full refund, no fee.',
  args: '<cross>',
  signs: true,
  options: { nonce: NONCE },
  async run(ctx, args) {
    noExtra(args, 1);
    const crossAddr = addressArg(positional(args, 0, 'cross'), '<cross>');
    const nonce = need(args, 'nonce');
    const owner = await actingAddress(ctx, undefined);
    const built = await ctx.builder().cancel({ cross: crossAddr, owner, nonce });
    const r = await execute(ctx, built);
    if (r.mode === 'dry-run') {
      emit(ctx, { cross: crossAddr, owner, nonce: nonce.toString(), dryRun: true, simulations: r.simulations }, dryRunLines(r));
      return exitFor(r);
    }
    const status = await orderStatus(ctx, crossAddr, owner, nonce);
    emit(ctx, { cross: crossAddr, owner, nonce: nonce.toString(), signatures: r.signatures, status }, ['Order cancelled; the escrow is back in your wallet.', ...r.signatures.map((s) => `signature ${s}`), `order status: ${status}`]);
    return EXIT.OK;
  },
};

const reveal: CommandDef = {
  path: ['order', 'reveal'],
  summary: 'Reveal a sealed order after the cross closes, using the salt kept in the vault file.',
  args: '<cross>',
  signs: true,
  options: { nonce: NONCE, owner: { type: 'string', value: 'address', description: 'with --dry-run and no key: simulate for this wallet' } },
  async run(ctx, args) {
    noExtra(args, 1);
    const crossAddr = addressArg(positional(args, 0, 'cross'), '<cross>');
    const nonce = need(args, 'nonce');
    const owner = await actingAddress(ctx, stringOpt(args.values.owner));
    const bids = await ctx.store().list(crossAddr, owner);
    const bid = bids.find((b) => b.nonce === nonce.toString());
    if (!bid) {
      throw new UsageError(`No sealed bid with nonce ${nonce} for ${owner} in this cross is in the vault file. If you placed it elsewhere, point --vault at the backup file you downloaded (the web app's backup works too).`);
    }
    const built = await ctx.builder().reveal({ cross: crossAddr, owner, nonce, price: BigInt(bid.price), quantity: BigInt(bid.quantity), salt: bytesOfHex(bid.salt) });
    const r = await execute(ctx, built);
    if (r.mode === 'dry-run') {
      emit(ctx, { cross: crossAddr, owner, nonce: nonce.toString(), dryRun: true, simulations: r.simulations }, dryRunLines(r));
      return exitFor(r);
    }
    const status = await orderStatus(ctx, crossAddr, owner, nonce);
    emit(ctx, { cross: crossAddr, owner, nonce: nonce.toString(), signatures: r.signatures, status }, ['Order revealed.', ...r.signatures.map((s) => `signature ${s}`), `order status: ${status}`]);
    return EXIT.OK;
  },
};

const claim: CommandDef = {
  path: ['order', 'claim'],
  summary: 'Collect an order’s fill and refund after the cross settles. Anyone may claim for anyone: proceeds always go to the order’s owner.',
  args: '<cross>',
  signs: true,
  options: {
    nonce: NONCE,
    owner: { type: 'string', value: 'address', description: 'whose order (default: the signing wallet)' },
    payer: { type: 'string', value: 'address', description: 'with --dry-run and no key: the wallet that would send the claim' },
  },
  async run(ctx, args) {
    noExtra(args, 1);
    const crossAddr = addressArg(positional(args, 0, 'cross'), '<cross>');
    const nonce = need(args, 'nonce');
    const payer = await actingAddress(ctx, stringOpt(args.values.payer), '--payer');
    const ownerFlag = stringOpt(args.values.owner);
    const owner = ownerFlag === undefined ? payer : addressArg(ownerFlag, '--owner');
    const built = await ctx.builder().claim({ cross: crossAddr, owner, nonce, payer });
    const r = await execute(ctx, built);
    if (r.mode === 'dry-run') {
      emit(ctx, { cross: crossAddr, owner, payer, nonce: nonce.toString(), dryRun: true, simulations: r.simulations }, dryRunLines(r));
      return exitFor(r);
    }
    const status = await orderStatus(ctx, crossAddr, owner, nonce);
    emit(ctx, { cross: crossAddr, owner, payer, nonce: nonce.toString(), signatures: r.signatures, status }, ['Claimed. The fill and any refund are in the owner’s token accounts.', ...r.signatures.map((s) => `signature ${s}`), `order status: ${status}`]);
    return EXIT.OK;
  },
};

const list: CommandDef = {
  path: ['order', 'list'],
  summary: 'List a wallet’s orders as the indexer recorded them.',
  args: '',
  options: { owner: { type: 'string', value: 'address', description: 'default: the signing wallet (needs --keypair)' }, keypair: { type: 'string', value: 'file', description: 'only used to learn the owner address' } },
  async run(ctx, args) {
    noExtra(args, 0);
    const ownerFlag = stringOpt(args.values.owner);
    const owner = ownerFlag === undefined ? (await ctx.signer()).address : addressArg(ownerFlag, '--owner');
    const orders = await ctx.api().ownerOrders(owner);
    const rows = orders.map((o) => [o.cross_address, o.address, o.side, o.status, o.price ?? '-', o.quantity ?? '-', o.fill ?? '-']);
    emit(ctx, { owner, orders }, orders.length === 0 ? [`${owner} has no orders.`] : table(['CROSS', 'ORDER', 'SIDE', 'STATUS', 'PRICE', 'QUANTITY', 'FILL'], rows));
    return EXIT.OK;
  },
};

export const orderCommands: CommandDef[] = [place, cancel, reveal, claim, list];
