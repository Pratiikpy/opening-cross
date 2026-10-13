// Solana Actions and Blinks for Opening Cross (PRODUCT_FEATURES X6, S10: bid from a link, from X, Telegram or a wallet).
//
// Follows the Solana Actions specification (https://solana.com/docs/advanced/actions): an Action URL answers GET with metadata
// and a list of linked actions (`type`, `icon`, `title`, `description`, `label`, `links.actions[].parameters`) and answers POST
// `{ account }` with `{ transaction, message }`, a base64 transaction whose fee payer is `account`. Every endpoint answers
// OPTIONS and carries the cross-origin headers the specification requires. Errors are `{ message }` with a 4xx or 5xx status.
//
//   GET  /actions.json                          the rules mapping web URLs /crosses/<address> to the Action below
//   GET  /v1/blinks/cross/:address              the cross as an Action: a buy button per preset size and a custom form
//   POST /v1/blinks/cross/:address/order        { account } with ?side=buy|sell&price=<per token>&quantity=<tokens>
//   GET  /v1/blinks/icon.svg                    the icon
//
// The same rules as the app apply, because the same builder is used: the order is placed in a cross that is open, on the
// price grid, with the full escrow shown in the message; the transaction is unsigned and only `account` can sign it; sealed
// and gated crosses are shown as disabled with the reason, because a sealed bid needs a salt that only the signer may keep and
// a gated cross needs a pass.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, Disclosure, OrderSide, getCrossDecoder } from '@opening-cross/sdk';
import { formatAtoms, formatDuration, formatPrice, parseAtoms, parsePrice, randomNonce } from '@opening-cross/client';
import type { ApiDeps } from '../server.js';
import { type Lifetime, RequestError, placeOrderTx } from '../tx.js';

export type BlinksDeps = Pick<ApiDeps, 'account' | 'lifetime' | 'clock' | 'network'>;
export type BlinksOptions = {
  /** Absolute origin of this API as clients reach it; default: taken from the request (X-Forwarded-Proto/Host aware). */
  publicOrigin?: string;
  /** Absolute URL of the icon; default: this API's own `/v1/blinks/icon.svg`. */
  iconUrl?: string;
  /** Preset buy sizes in whole base tokens. */
  presets?: readonly string[];
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding',
} as const;

const STATE = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;
const send = (reply: FastifyReply, body: unknown, status = 200) => {
  for (const [k, v] of Object.entries(CORS)) reply.header(k, v);
  return reply.code(status).type('application/json').send(JSON.stringify(body));
};
/** The Actions error form. The message is shown to the person, so it says what to do. */
const fail = (reply: FastifyReply, status: number, message: string) => send(reply, { message }, status);

function originOf(req: FastifyRequest, o: BlinksOptions): string {
  if (o.publicOrigin) return o.publicOrigin.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="Opening Bell"><rect width="128" height="128" rx="28" fill="#1b1b1f"/><path d="M64 26c-15 0-26 11-26 26v16c0 6-3 11-8 15h68c-5-4-8-9-8-15V52c0-15-11-26-26-26z" fill="#f2a33a"/><circle cx="64" cy="92" r="9" fill="#f2a33a"/><rect x="60" y="16" width="8" height="12" rx="4" fill="#f2a33a"/></svg>`;

export function registerBlinks(app: FastifyInstance, d: BlinksDeps, opts: BlinksOptions = {}): void {
  const now = () => BigInt(d.clock?.() ?? Math.floor(Date.now() / 1000));
  const presets = opts.presets ?? ['1', '10', '100'];

  async function loadCross(a: string) {
    if (!isAddress(a)) throw new RequestError(400, 'That is not a cross address. Open the link from the cross page.');
    const acct = await d.account(a);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !CROSS_DISCRIMINATOR.every((b, i) => acct.data[i] === b)) throw new RequestError(404, 'No Opening Cross call auction lives at this address.');
    return { address: a as Address, data: getCrossDecoder().decode(acct.data) };
  }

  // Every Action endpoint answers OPTIONS with the same headers as its GET (the specification suggests exactly that).
  app.options('/actions.json', async (_req, reply) => reply.code(204).headers(CORS).send());
  app.options('/v1/blinks/*', async (_req, reply) => reply.code(204).headers(CORS).send());

  app.get('/actions.json', async (_req, reply) =>
    send(reply, { rules: [{ pathPattern: '/crosses/*', apiPath: '/v1/blinks/cross/*' }, { pathPattern: '/v1/blinks/**', apiPath: '/v1/blinks/**' }] }),
  );

  app.get('/v1/blinks/icon.svg', async (_req, reply) => {
    for (const [k, v] of Object.entries(CORS)) reply.header(k, v);
    return reply.code(200).type('image/svg+xml').header('cache-control', 'public, max-age=86400').send(ICON);
  });

  app.get('/v1/blinks/cross/:address', async (req, reply) => {
    try {
      const { address, data: c } = await loadCross((req.params as { address: string }).address);
      const origin = originOf(req, opts);
      const icon = opts.iconUrl ?? `${origin}/v1/blinks/icon.svg`;
      const t = now();
      const market = { priceScale: c.priceScale, baseDecimals: c.baseDecimals, quoteDecimals: c.quoteDecimals };
      const base = { type: 'action', icon, title: 'Opening Bell: a call auction' };
      const closed = c.state !== CrossState.Live || t >= c.closeTs;
      const sealed = c.disclosure === Disclosure.Sealed;
      const gated = c.gateMint.__option === 'Some';
      const opens = t < c.openTs;
      const lowest = formatPrice(c.minPrice, market);
      const highest = formatPrice(c.minPrice + BigInt(c.ticks - 1) * c.tick, market);
      const secondsLeft = c.closeTs > t ? c.closeTs - t : 0n;
      const when = closed ? `This call is ${STATE[c.state] === 'Live' ? 'closed and waiting to be settled' : STATE[c.state].toLowerCase()}.` : opens ? `It opens in ${formatDuration(c.openTs - t)}.` : `It closes in ${formatDuration(secondsLeft)}.`;
      const how = 'Every filled order pays the same clearing price, never above your limit; whatever you do not spend comes back. If too little crosses, everyone is refunded in full. Anyone can recompute the result.';
      const reason = closed ? 'This call has closed.' : opens ? 'This call has not opened yet.' : sealed ? 'This call is sealed: a sealed bid needs a secret that only you may keep. Bid in the app.' : gated ? 'This call is for holders of a pass. Claim yours in the app.' : null;
      if (reason) {
        return send(reply, { ...base, description: `${when} ${how}`, label: closed ? 'Closed' : 'Not available here', disabled: true, error: { message: reason } });
      }
      return send(reply, {
        ...base,
        description: `${when} Prices run from ${lowest} to ${highest} per token on a grid. ${how}`,
        label: 'Bid',
        links: {
          actions: [
            ...presets.map((n) => ({ label: `Buy ${n}`, href: `/v1/blinks/cross/${address}/order?side=buy&price={price}&quantity=${n}`, parameters: [priceParam(lowest, highest)] })),
            {
              label: 'Place order',
              href: `/v1/blinks/cross/${address}/order?side={side}&price={price}&quantity={quantity}`,
              parameters: [
                { type: 'radio', name: 'side', label: 'Buy or sell', required: true, options: [{ label: 'Buy', value: 'buy', selected: true }, { label: 'Sell', value: 'sell' }] },
                priceParam(lowest, highest),
                { type: 'number', name: 'quantity', label: `Amount in tokens (up to ${c.baseDecimals} decimal places)`, required: true },
              ],
            },
          ],
        },
      });
    } catch (e) {
      if (e instanceof RequestError) return fail(reply, e.status, e.message);
      throw e;
    }
  });

  app.post('/v1/blinks/cross/:address/order', async (req, reply) => {
    try {
      const body = req.body as { account?: unknown } | null;
      const account = body && typeof body === 'object' ? body.account : undefined;
      if (typeof account !== 'string' || !isAddress(account)) throw new RequestError(400, 'Your wallet did not send an account. Connect a wallet and try again.');
      const { address, data: c } = await loadCross((req.params as { address: string }).address);
      const q = req.query as { side?: string; price?: string; quantity?: string };
      const t = now();
      if (c.state !== CrossState.Live || t >= c.closeTs) throw new RequestError(409, 'This call has closed. Nothing was sent.');
      if (t < c.openTs) throw new RequestError(409, 'This call has not opened yet. Nothing was sent.');
      if (c.disclosure === Disclosure.Sealed) throw new RequestError(409, 'This call is sealed. Bid in the app, where your secret is kept for the reveal.');
      if (c.gateMint.__option === 'Some') throw new RequestError(409, 'This call is for holders of a pass. Claim yours in the app.');
      if (q.side !== 'buy' && q.side !== 'sell') throw new RequestError(400, 'Choose buy or sell.');
      const market = { priceScale: c.priceScale, baseDecimals: c.baseDecimals, quoteDecimals: c.quoteDecimals };
      const price = parsePrice(String(q.price ?? ''), market);
      const lowest = formatPrice(c.minPrice, market);
      const highest = formatPrice(c.minPrice + BigInt(c.ticks - 1) * c.tick, market);
      if (price === null) throw new RequestError(400, `Enter a price per token between ${lowest} and ${highest}.`);
      if (price < c.minPrice || price > c.minPrice + BigInt(c.ticks - 1) * c.tick || (price - c.minPrice) % c.tick !== 0n) {
        throw new RequestError(400, `The price must be between ${lowest} and ${highest}, in steps of ${formatPrice(c.tick, market)}.`);
      }
      const quantity = parseAtoms(String(q.quantity ?? ''), c.baseDecimals);
      if (quantity === null || quantity === 0n) throw new RequestError(400, `Enter an amount of tokens greater than zero, with at most ${c.baseDecimals} decimal places.`);
      if (quantity >= 1n << 64n) throw new RequestError(400, 'That amount is larger than a token account can hold.');
      const side = q.side === 'buy' ? OrderSide.Buy : OrderSide.Sell;
      const lt: Lifetime = await d.lifetime();
      const tx = await placeOrderTx(async (a) => (await d.account(a))?.data ?? null, { address, data: c }, { owner: account, nonce: BigInt(randomNonce()), side, price, quantity }, lt);
      const escrow = side === OrderSide.Buy ? (quantity * price + c.priceScale - 1n) / c.priceScale : quantity;
      const fee = c.protocolFeeBps + c.integratorFeeBps;
      const amount = formatAtoms(quantity, c.baseDecimals);
      const tokens = amount === '1' ? '1 token' : `${amount} tokens`;
      const message =
        side === OrderSide.Buy
          ? `Bid for ${tokens} at up to ${formatPrice(price, market)} each. ${formatAtoms(escrow, c.quoteDecimals)} leaves your wallet now and is held by the cross; you pay the clearing price for what fills and the rest comes back. No fee for buyers.`
          : `Offer ${tokens} at no less than ${formatPrice(price, market)} each. They leave your wallet now and are held by the cross; what does not sell comes back.${fee ? ` The fee is ${fee / 100}% of what you receive.` : ''}`;
      return send(reply, { transaction: tx.transaction, message });
    } catch (e) {
      if (e instanceof RequestError) return fail(reply, e.status, e.message);
      throw e;
    }
  });
}

function priceParam(lowest: string, highest: string) {
  return { type: 'number', name: 'price', label: `Price per token (${lowest} to ${highest})`, required: true };
}
