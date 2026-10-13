// Market-maker quote publisher (PRODUCT_FEATURES W9, Z7): a maker that already rests an order in a cross signs a quote pointing at
// it and publishes the quote, so an aggregator can find the liquidity without scanning the chain. The API stores a quote only
// while the order really rests on chain as quoted, and re-checks it on every read; cancelling the order withdraws the quote.
import { randomBytes } from 'node:crypto';
import { QUOTE_SCHEMA, type QuoteBody, signQuote } from '@opening-cross/liquidity';

export type RestingOrder = { cross: string; side: 'buy' | 'sell'; price: bigint; quantity: bigint; nonce: bigint };

export async function publishQuote(api: string, maker: { address: string; keyPair: CryptoKeyPair }, order: RestingOrder, o: { ttlSeconds?: number; now?: number; fetchImpl?: typeof fetch } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const body: QuoteBody = {
    schema: QUOTE_SCHEMA,
    maker: maker.address,
    cross: order.cross,
    side: order.side,
    price: order.price.toString(),
    quantity: order.quantity.toString(),
    orderNonce: order.nonce.toString(),
    expiresAt: now + (o.ttlSeconds ?? 600),
    nonce: randomBytes(8).toString('hex'),
  };
  const signed = await signQuote(body, maker.keyPair);
  const res = await (o.fetchImpl ?? fetch)(`${api}/v1/liquidity/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
