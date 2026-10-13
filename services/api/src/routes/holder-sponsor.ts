// Sponsored fees (ROADMAP I6, S14; ADR-0405): an order from a wallet that holds the tokens but no SOL.
//
//   GET  /v1/sponsor                    whether this deployment sponsors, its limits, and what a sponsored order costs the sponsor
//   POST /v1/tx/place-order-sponsored   the body of /v1/tx/place-order; answers a transaction already signed by the sponsor
//
// How it is kept safe. The server builds the whole transaction itself (never a client-supplied one) and signs only that exact
// message, so the sponsor cannot be made to pay for anything else. The transaction carries at most two instructions: a plain
// system transfer that tops the order owner's balance up to the rent of the order account, and the same `commit_order`
// instruction the app builds. The fee payer is the sponsor; the owner signs as the second signer. Only orders on crosses that are
// taking orders are sponsored, an order the program would refuse is refused here first (the sponsor pays the fee even for a
// failed transaction), each wallet is limited per UTC day, and the sponsor stops at a daily total.
// What the sponsor pays is the advance and the network fee. The rent returns to the owner when the order is claimed or cancelled.
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  type Address,
  AccountRole,
  type Instruction,
  type KeyPairSigner,
  address as toAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  isAddress,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { OrderSide, ata, buildPlaceOrder, costCeil, getOrderSize, orderAddress } from '@opening-cross/sdk';
import { decodeCross, phaseOf, presentCross } from '@opening-cross/client';
import { type Lifetime, RequestError } from '../tx.js';
import type { Db } from './holder-alerts-store.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type HolderSponsorDeps = {
  db: Db;
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  clock?: () => number;
  /** The sponsor's signer. Absent: sponsorship is off and says so. Loaded by `loadSponsor` from SPONSOR_KEYPAIR. */
  sponsor?: KeyPairSigner | null;
  /** Lamports of an account (0 for one that does not exist). Defaults to the cluster named by RPC_URL. */
  balance?: (a: Address) => Promise<bigint>;
  /** Lamports the cluster requires to keep an account of this many bytes. Defaults to the cluster named by RPC_URL. */
  rentFor?: (bytes: number) => Promise<bigint>;
  limits?: Partial<SponsorLimits>;
};

export type SponsorLimits = {
  /** Sponsored orders one wallet can have per UTC day. */
  perWalletPerDay: number;
  /** Most the sponsor pays out per UTC day, in lamports (fees and advances together). */
  dailyLamports: bigint;
  /** The network fee allowed for in the arithmetic: a transaction with two signatures costs 10,000 lamports. */
  feeLamports: bigint;
};

export const DEFAULT_LIMITS: SponsorLimits = { perWalletPerDay: 5, dailyLamports: 500_000_000n, feeLamports: 10_000n };

const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;

/** A system-program transfer, built by hand: instruction 2, then the lamports as a little-endian u64. */
export function transferInstruction(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, lamports, true);
  return { programAddress: SYSTEM_PROGRAM, accounts: [{ address: from, role: AccountRole.WRITABLE_SIGNER }, { address: to, role: AccountRole.WRITABLE }], data };
}

/** How much the owner needs added to its balance to pay the order account's rent. The sponsor pays the network fee as fee payer. */
export function advanceNeeded(balance: bigint, rent: bigint): bigint {
  return balance >= rent ? 0n : rent - balance;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

const LEDGER = `CREATE TABLE IF NOT EXISTS sponsor_ledger (
  day      bigint  NOT NULL,
  owner    text    NOT NULL,
  orders   integer NOT NULL DEFAULT 0,
  lamports bigint  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, owner)
)`;

/** Reads the sponsor's key from the file named by SPONSOR_KEYPAIR (a Solana CLI keypair file). Null when it is not set. */
export async function loadSponsor(env: NodeJS.ProcessEnv = process.env): Promise<KeyPairSigner | null> {
  const path = env.SPONSOR_KEYPAIR?.trim();
  if (!path) return null;
  const { readFile } = await import('node:fs/promises');
  const { createKeyPairSignerFromBytes } = await import('@solana/kit');
  const bytes = Uint8Array.from(JSON.parse(await readFile(path, 'utf8')) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}

/** JSON-RPC against the first of the endpoints that answers. */
function rpcCall(urls: string[]) {
  return async <T>(method: string, params: unknown[]): Promise<T> => {
    let last: unknown = new Error('RPC_URL is not set');
    for (const url of urls) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
        const j = (await r.json()) as { result?: T; error?: { message: string } };
        if (j.error) throw new Error(j.error.message);
        return j.result as T;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
}

export function registerHolderSponsor(app: FastifyInstance, deps: HolderSponsorDeps) {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const sponsor = deps.sponsor ?? null;
  const call = rpcCall((process.env.RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const balance = deps.balance ?? (async (a: Address) => BigInt((await call<{ value: number }>('getBalance', [a, { commitment: 'confirmed' }])).value));
  const rentFor = deps.rentFor ?? (async (bytes: number) => BigInt(await call<number>('getMinimumBalanceForRentExemption', [bytes])));
  let ready: Promise<unknown> | null = null;
  const q = async (text: string, params: unknown[] = []) => {
    ready ??= deps.db.query(LEDGER).catch((e) => {
      ready = null;
      throw e;
    });
    await ready;
    return (await deps.db.query(text, params)).rows;
  };
  const dayOf = (now: number) => Math.floor(now / 86_400);
  const spentOn = async (day: number) => BigInt(String((await q('SELECT COALESCE(sum(lamports), 0)::text AS n FROM sponsor_ledger WHERE day = $1', [day]))[0]?.n ?? '0'));

  app.get('/v1/sponsor', async (_req, reply) => {
    if (!sponsor) {
      return send(reply, { enabled: false, reason: 'This deployment has no sponsor key (SPONSOR_KEYPAIR), so every wallet pays its own network fee and the rent of its order account.' });
    }
    return send(reply, {
      enabled: true,
      sponsor: sponsor.address,
      perWalletPerDay: limits.perWalletPerDay,
      dailyLamports: limits.dailyLamports,
      spentTodayLamports: await spentOn(dayOf(clock())),
      covers: 'the network fee and, for a wallet without enough SOL, the rent of the order account (the rent returns to the wallet when the order is claimed or cancelled)',
      doesNotCover: 'the tokens that go into escrow, or any transaction other than placing an order on a cross that is taking orders',
    });
  });

  app.post('/v1/tx/place-order-sponsored', async (req, reply) => {
    if (!sponsor) return send(reply, { error: 'sponsored orders are not enabled on this deployment (no SPONSOR_KEYPAIR)' }, 503);
    const b = req.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new RequestError(400, 'request body must be a JSON object');
    const addr = (v: unknown, f: string): Address => {
      if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${f} must be a base58 Solana address`);
      return toAddress(v);
    };
    const u64 = (v: unknown, f: string): bigint => {
      if (typeof v !== 'string' || !/^\d{1,20}$/.test(v) || BigInt(v) >= 1n << 64n) throw new RequestError(400, `${f} must be an unsigned 64-bit integer (decimal string)`);
      return BigInt(v);
    };
    const crossAddress = addr(b.cross, 'cross');
    const owner = addr(b.owner, 'owner');
    if (owner === sponsor.address) throw new RequestError(400, 'the sponsor cannot sponsor its own orders');
    const acct = await deps.account(crossAddress);
    const data = acct ? decodeCross(acct) : null;
    if (!data) throw new RequestError(404, `${crossAddress} is not an Opening Cross account on this cluster`);
    const cross = { address: crossAddress, data };
    const c = presentCross(crossAddress, data);
    const now = clock();
    if (phaseOf(c, BigInt(now)) !== 'open') throw new RequestError(409, 'this cross is not taking orders, so there is nothing to sponsor');
    const side = b.side === 'buy' ? OrderSide.Buy : b.side === 'sell' ? OrderSide.Sell : null;
    if (side === null) throw new RequestError(400, 'side must be "buy" or "sell"');
    if (side === OrderSide.Sell && c.supplyMode !== 'escrow') throw new RequestError(400, 'this cross takes buy orders only');
    const nonce = u64(b.nonce, 'nonce');
    const price = u64(b.price, 'price');
    const quantity = u64(b.quantity, 'quantity');
    const min = BigInt(c.grid.minPrice);
    const tick = BigInt(c.grid.tick);
    if (quantity === 0n) throw new RequestError(400, 'quantity must be more than zero');
    if (price < min || price > min + BigInt(c.grid.ticks - 1) * tick || (price - min) % tick !== 0n) throw new RequestError(400, "price is not on this cross's price grid");
    const salt = typeof b.salt === 'string' && /^[0-9a-fA-F]{64}$/.test(b.salt) ? Uint8Array.from(Buffer.from(b.salt, 'hex')) : undefined;
    if (c.disclosure === 'sealed' && !salt) throw new RequestError(400, 'sealed cross: provide a 32-byte hex salt and keep it for the reveal');
    if (await deps.account(await orderAddress(crossAddress, owner, nonce))) throw new RequestError(409, `nonce ${nonce} is already used by this owner in this cross`);

    // The sponsor pays the fee even for a failed transaction, so an order the owner cannot fund is refused before anything is signed.
    const escrow = side === OrderSide.Buy ? costCeil(quantity, price, BigInt(c.grid.priceScale)) : quantity;
    const escrowMint = side === OrderSide.Buy ? data.quoteMint : data.baseMint;
    const escrowProgram = side === OrderSide.Buy ? data.quoteTokenProgram : data.baseTokenProgram;
    const held = await deps.account(await ata(owner, escrowMint, escrowProgram));
    const heldAmount = held && held.data.length >= 72 ? new DataView(held.data.buffer, held.data.byteOffset).getBigUint64(64, true) : 0n;
    if (heldAmount < escrow) throw new RequestError(409, `this wallet holds ${heldAmount} of the token that would go into escrow and the order locks ${escrow} (smallest units), so it would fail. Sponsorship pays fees, not escrow.`);

    const day = dayOf(now);
    const used = (await q('SELECT orders FROM sponsor_ledger WHERE day = $1 AND owner = $2', [day, owner]))[0];
    if (used && Number(used.orders) >= limits.perWalletPerDay) throw new RequestError(409, `a wallet can have ${limits.perWalletPerDay} sponsored orders per day and this one has used them. It can still place orders and pay its own fee.`);
    const advance = advanceNeeded(await balance(owner), await rentFor(getOrderSize()));
    const cost = advance + limits.feeLamports;
    if ((await spentOn(day)) + cost > limits.dailyLamports) return send(reply, { error: 'the sponsor has reached its limit for today; place the order from a wallet that holds SOL, or try tomorrow' }, 503);
    if ((await balance(sponsor.address)) < cost + 1_000_000n) return send(reply, { error: 'the sponsor is out of funds for now' }, 503);

    const ix = await buildPlaceOrder({ cross, owner: createNoopSigner(owner), nonce, side, price, quantity, ...(salt && { salt }) });
    const lifetime = await deps.lifetime();
    const instructions: Instruction[] = [...(advance > 0n ? [transferInstruction(sponsor.address, owner, advance)] : []), ix];
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (x) => setTransactionMessageFeePayer(sponsor.address, x),
      (x) => setTransactionMessageLifetimeUsingBlockhash(lifetime, x),
      (x) => appendTransactionMessageInstructions(instructions, x),
    );
    const signed = await partiallySignTransaction([sponsor.keyPair], compileTransaction(message));
    await q(
      `INSERT INTO sponsor_ledger (day, owner, orders, lamports) VALUES ($1, $2, 1, $3)
       ON CONFLICT (day, owner) DO UPDATE SET orders = sponsor_ledger.orders + 1, lamports = sponsor_ledger.lamports + EXCLUDED.lamports`,
      [day, owner, cost.toString()],
    );
    return send(reply, {
      transaction: getBase64EncodedWireTransaction(signed),
      signers: [owner],
      order: await orderAddress(crossAddress, owner, nonce),
      sponsored: { feePayer: sponsor.address, advanceLamports: advance, feeLamports: limits.feeLamports },
    });
  });
}
