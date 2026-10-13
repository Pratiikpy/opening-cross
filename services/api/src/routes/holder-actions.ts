// Trade from a link (ROADMAP S10; ADR-0404): Solana Actions, so a bid on an open cross can be made from any blink-aware client
// (a wallet, a feed, a chat bot) without opening the app. The spec is https://solana.com/docs/advanced/actions.
//
//   GET  /v1/actions/crosses/:address            the action: title, what the cross is, and the bid form (two parameters)
//   POST /v1/actions/crosses/:address/bid        { account } with ?price=&quantity= : the unsigned transaction that places the bid
//
// The transaction is the one the app builds (`placeOrderTx`), so a bid from a link has exactly the same escrow, limit price and
// refund behaviour as one from the cross page. Only open (unsealed) crosses are offered: a sealed bid needs its salt kept on the
// bidder's device to be revealed, which a link cannot do. Errors use the spec's `{ message }` shape.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, type CrossView, OrderSide } from '@opening-cross/sdk';
import { decodeCross, formatAtoms, formatPrice, marketOf, phaseOf, presentCross, priceOnGrid, quantityOf, buyerPays } from '@opening-cross/client';
import { type Lifetime, RequestError, placeOrderTx } from '../tx.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type HolderActionDeps = {
  account: (a: Address) => Promise<ChainAccount | null>;
  lifetime: () => Promise<Lifetime>;
  /** Unix seconds; defaults to the wall clock. */
  clock?: () => number;
  /** Public address of the web app: the icon is served from it, and an action needs an absolute icon URL. Defaults to WEB_URL. */
  webUrl?: string | null;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const fail = (reply: FastifyReply, message: string, status = 400) => send(reply, { message }, status);

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const utc = (ts: bigint | string) => new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function registerHolderActions(app: FastifyInstance, deps: HolderActionDeps) {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  const web = (deps.webUrl === undefined ? process.env.WEB_URL?.trim().replace(/\/+$/, '') || null : deps.webUrl?.replace(/\/+$/, '')) ?? null;

  async function crossOf(raw: string): Promise<CrossView> {
    if (!isAddress(raw)) throw new RequestError(400, 'the cross address is not a base58 Solana address');
    const acct = await deps.account(raw);
    const data = acct ? decodeCross(acct) : null;
    if (!data) throw new RequestError(404, `${raw} is not an Opening Cross account on this cluster`);
    return { address: raw, data } as CrossView;
  }

  /** Runs a handler and answers errors in the Actions shape. */
  const action = (f: (req: import('fastify').FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (req: import('fastify').FastifyRequest, reply: FastifyReply) => {
    try {
      return await f(req, reply);
    } catch (e) {
      if (e instanceof RequestError) return fail(reply, e.message, e.status);
      throw e;
    }
  };

  app.get(
    '/v1/actions/crosses/:address',
    action(async (req, reply) => {
      if (!web) return fail(reply, 'This deployment has no WEB_URL set, so it cannot give an action an absolute icon address.', 503);
      const cross = await crossOf((req.params as { address: string }).address);
      const c = presentCross(cross.address, cross.data);
      const m = marketOf(c);
      const phase = phaseOf(c, BigInt(clock()));
      const origin = `${req.protocol}://${req.hostname}`;
      const name = `Cross ${shortAddr(cross.address)}`;
      const min = BigInt(c.grid.minPrice);
      const max = min + BigInt(c.grid.ticks - 1) * BigInt(c.grid.tick);
      const body = {
        type: 'action',
        icon: `${web}/icon.svg`,
        title: `Opening Bell: ${name}`,
        description: describe(c, phase, m),
        label: 'Place a bid',
        links: {
          actions: [
            {
              type: 'transaction',
              label: 'Place a bid',
              href: `${origin}/v1/actions/crosses/${cross.address}/bid?price={price}&quantity={quantity}`,
              parameters: [
                { name: 'price', label: `Most you would pay per token (${formatPrice(min, m)} to ${formatPrice(max, m)})`, required: true, type: 'number' },
                { name: 'quantity', label: 'Tokens you want', required: true, type: 'number' },
              ],
            },
          ],
        },
        ...(phase === 'open' && c.disclosure === 'open' ? {} : { disabled: true, error: { message: whyNot(c, phase) } }),
      };
      return send(reply, body);
    }),
  );

  app.post(
    '/v1/actions/crosses/:address/bid',
    action(async (req, reply) => {
      const cross = await crossOf((req.params as { address: string }).address);
      const c = presentCross(cross.address, cross.data);
      const m = marketOf(c);
      const phase = phaseOf(c, BigInt(clock()));
      if (phase !== 'open' || c.disclosure !== 'open') throw new RequestError(409, whyNot(c, phase));
      const account = (req.body as { account?: unknown } | null)?.account;
      if (typeof account !== 'string' || !isAddress(account)) throw new RequestError(400, 'The request must carry { "account": "<the wallet address>" }.');
      const q = req.query as { price?: string; quantity?: string };
      if (!q.price || !q.quantity) throw new RequestError(400, 'Give both a price and a quantity.');
      const price = priceOnGrid(q.price, c, m);
      if (typeof price === 'string') throw new RequestError(400, price);
      const quantity = quantityOf(q.quantity, m);
      if (typeof quantity === 'string') throw new RequestError(400, quantity);
      const nonce = randomBytes(8).readBigUInt64BE();
      const built = await placeOrderTx(async (a) => {
        const acct = await deps.account(a);
        return acct && acct.owner === CROSS_CORE_PROGRAM_ADDRESS ? acct.data : null;
      }, cross, { owner: account, nonce, side: OrderSide.Buy, price, quantity }, await deps.lifetime());
      const escrow = buyerPays(quantity, price, m.priceScale);
      return send(reply, {
        type: 'transaction',
        transaction: built.transaction,
        message: `Bid for ${formatAtoms(quantity, m.baseDecimals)} tokens at up to ${formatPrice(price, m)} each. Up to ${formatAtoms(escrow, m.quoteDecimals)} is held in escrow; you pay the clearing price for what is filled and the rest returns when the cross settles. You can cancel until ${utc(c.window.closeTs)}.`,
      });
    }),
  );
}

function whyNot(c: ReturnType<typeof presentCross>, phase: ReturnType<typeof phaseOf>): string {
  if (c.disclosure === 'sealed') return 'This cross takes sealed bids. A sealed bid has to be revealed later from the device that placed it, so it cannot be placed from a link. Open the cross page to bid.';
  if (phase === 'upcoming') return `This cross opens at ${utc(c.window.openTs)}.`;
  if (phase === 'open') return 'This cross is open.';
  if (c.state === 'Live') return 'The order window has closed and the cross is waiting to be settled.';
  return c.state === 'NoPrint' ? 'This cross closed without a price. Every order is refunded in full.' : 'This cross has settled.';
}

function describe(c: ReturnType<typeof presentCross>, phase: ReturnType<typeof phaseOf>, m: ReturnType<typeof marketOf>): string {
  const how = 'Orders are collected, then everyone who trades pays one clearing price, never worse than your limit. Your escrow comes back if you are not filled.';
  if (phase === 'open') return `Takes orders until ${utc(c.window.closeTs)}. ${how} Prices go from ${formatPrice(BigInt(c.grid.minPrice), m)} in steps of ${formatPrice(BigInt(c.grid.tick), m)}. Devnet: test tokens only.`;
  return `${whyNot(c, phase)} ${how}`;
}
