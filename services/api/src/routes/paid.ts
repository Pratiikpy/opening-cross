// Pay-per-call routes (PRODUCT_FEATURES X6 agent order entry, J1 agent-native API, X11 and P1 metered lines, P3 to P5 pay-per-call
// data), on the x402 `exact` scheme and the MPP charge intent from @opening-cross/x402.
//
// What is for sale is a service, never the data itself: everything below also exists free in the public API, and the
// free routes are unchanged. A payment buys
//   /v1/paid/verify/:cross       an independent recomputation of a settled cross, SIGNED by the published attestation key
//                                (the free proof is the same computation, unsigned)                        rate: proof-verification
//   /v1/paid/bundle/:cross       the cross, every order, every event and the proof in one document with their hashes,
//                                signed, for an auditor who needs one artefact                              rate: data-export
//   POST /v1/paid/order-desk     a pre-trade check for an agent: the unsigned order transaction, the cross's phase and
//                                safety verdict, the escrow and fee, and the cluster's own simulation of it  rate: order-desk
// Prices come from the rate card (`PROPOSED_RATE_CARD`, status "proposed": the figures are not a measurement of anyone's
// willingness to pay). A request that cannot be answered (bad address, unknown cross, a cross that has not settled) is a
// 4xx before any price is offered; the work runs before payment settles, so a failure charges nothing.
//
// When no payment gate is configured the routes answer 501 and point at the free route, so the API never pretends.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, CrossState, Disclosure, OrderSide, getCrossDecoder } from '@opening-cross/sdk';
import { type FairnessProof, verifyCross } from '@opening-cross/verifier';
import { type GateLike, type Prepared, registerPaidRoute } from '@opening-cross/x402';
import { type RateCard, PROPOSED_RATE_CARD } from '@opening-cross/fees';
import { type Signed, signDocument } from '@opening-cross/attest';
import type { ApiDeps } from '../server.js';
import { jsonRpcSimulate } from './simulate.js';
import { type Lifetime, RequestError, placeOrderTx } from '../tx.js';

export type PaidOptions = {
  gate: GateLike;
  /** Absolute origin used in `resource.url`. */
  publicOrigin?: string;
  rateCard?: RateCard;
  /** Signs verification receipts and bundles. Without it they are returned unsigned and say so. */
  attestation?: { keyPair: CryptoKeyPair; address: string } | null;
  /** The cluster's own simulation of an unsigned transaction (base64 wire bytes). Defaults to JSON-RPC at `RPC_URL`. */
  simulate?: (wireBase64: string) => Promise<{ err: unknown; logs: string[]; unitsConsumed: number | null }>;
  /** The recomputation; defaults to the verifier package. Tests inject a fixed proof. */
  verifyProof?: (fetch: (a: Address) => Promise<Uint8Array | null>, cross: Address) => Promise<FairnessProof>;
};

export type PaidDeps = Pick<ApiDeps, 'db' | 'account' | 'lifetime' | 'clock' | 'network'>;

const STATE = ['Live', 'Cleared', 'NoPrint', 'Finalized'] as const;
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function rateOf(card: RateCard, product: string): bigint {
  const r = card.usage.find((u) => u.product === product);
  if (!r) throw new Error(`the rate card has no "${product}" product`);
  return r.priceUnits;
}

const sha = (v: unknown) => createHash('sha256').update(json(v)).digest('hex');

function addr(v: unknown, field: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) throw new RequestError(400, `${field} must be a base58 Solana address`);
  return v;
}

function u64(v: unknown, field: string): bigint {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v;
  if (typeof s !== 'string' || !/^\d{1,20}$/.test(s) || BigInt(s) >= 1n << 64n) throw new RequestError(400, `${field} must be an unsigned 64-bit integer (decimal string)`);
  return BigInt(s);
}

export function registerPaid(app: FastifyInstance, d: PaidDeps, paid: PaidOptions | null): void {
  const card = paid?.rateCard ?? PROPOSED_RATE_CARD;
  const now = () => d.clock?.() ?? Math.floor(Date.now() / 1000);
  const signer = paid?.attestation ?? null;

  app.get('/v1/attestations/signer', async (_req, reply) =>
    reply.code(200).type('application/json').send(json({ signer: signer?.address ?? null, note: signer ? 'Receipts and bundles from /v1/paid are signed by this key. Check the key against the one published on the site before trusting a signature.' : 'No attestation key is configured on this deployment; paid documents are returned unsigned.' })),
  );

  if (!paid) {
    const off = async (_req: FastifyRequest, reply: import('fastify').FastifyReply) =>
      reply.code(501).type('application/json').send(json({ error: 'pay-per-call is not enabled on this deployment', free: 'The same facts are free: GET /v1/crosses/:address/proof, /orders and /v1/replay/:address.', enable: 'Set X402_ENABLED=1 and the X402_* variables (docs/CONFIGURATION.md).' }));
    app.get('/v1/paid/verify/:cross', off);
    app.get('/v1/paid/bundle/:cross', off);
    app.post('/v1/paid/order-desk', off);
    return;
  }

  async function settledCross(a: Address) {
    const acct = await d.account(a);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !CROSS_DISCRIMINATOR.every((b, i) => acct.data[i] === b)) throw new RequestError(404, `${a} is not an Opening Cross account`);
    const cross = getCrossDecoder().decode(acct.data);
    return { address: a, data: cross };
  }
  const fetchOwned = async (a: Address) => {
    const acct = await d.account(a);
    return acct && acct.owner === CROSS_CORE_PROGRAM_ADDRESS ? acct.data : null;
  };
  const route = { gate: paid.gate, ...(paid.publicOrigin ? { publicOrigin: paid.publicOrigin } : {}) };
  const price = (product: string) => rateOf(card, product);
  const rateNote = `price from the ${card.status} rate card ${card.version}`;

  // ---------------------------------------------------------------- verify
  registerPaidRoute(app, route.gate, {
    method: 'GET',
    url: '/v1/paid/verify/:cross',
    description: `Independent recomputation of a settled cross, signed by the published attestation key (${rateNote})`,
    ...(paid.publicOrigin ? { publicOrigin: paid.publicOrigin } : {}),
    prepare: async (req): Promise<Prepared> => {
      const a = addr((req.params as { cross: string }).cross, 'cross');
      const c = await settledCross(a);
      if (c.data.state === CrossState.Live) throw new RequestError(409, 'this cross has not settled; there is nothing to verify yet');
      const proof = await (paid.verifyProof ?? verifyCross)(fetchOwned, a);
      const summary = { cross: a, state: proof.state, verified: proof.verified, onchain: proof.onchain, recomputed: proof.recomputed };
      return {
        amount: price('proof-verification'),
        preview: async () => ({ ...summary, note: 'This is the verdict. A payment adds the same verdict as a document signed by the published key, with the hash of the full proof, for keeping or forwarding.' }),
        full: async () => {
          const body = { schema: 'opening-cross/verification-receipt/v1', cluster: d.network ?? 'unknown', cross: a, proofSha256: sha(proof), verified: proof.verified, state: proof.state, onchain: proof.onchain, recomputed: proof.recomputed, issuedAt: now() };
          const signed = signer ? await signDocument(body as never, signer.keyPair) : null;
          return { receipt: signed ?? { body, unsigned: true, reason: 'no attestation key is configured on this deployment' }, proof };
        },
      };
    },
  });

  // ---------------------------------------------------------------- bundle
  registerPaidRoute(app, route.gate, {
    method: 'GET',
    url: '/v1/paid/bundle/:cross',
    description: `One signed document with a settled cross, every order, every event and the proof (${rateNote})`,
    ...(paid.publicOrigin ? { publicOrigin: paid.publicOrigin } : {}),
    prepare: async (req): Promise<Prepared> => {
      const a = addr((req.params as { cross: string }).cross, 'cross');
      const c = await settledCross(a);
      if (c.data.state === CrossState.Live) throw new RequestError(409, 'this cross has not settled; a bundle is for a closed book');
      const counts = (await d.db.query<{ orders: number; events: number }>('SELECT (SELECT count(*)::int FROM orders WHERE cross_address = $1) AS orders, (SELECT count(*)::int FROM events WHERE cross_address = $1) AS events', [a])).rows[0]!;
      return {
        amount: price('data-export'),
        preview: async () => ({ cross: a, state: STATE[c.data.state], orders: counts.orders, events: counts.events, note: 'A payment returns all of them in one signed document.' }),
        full: async () => {
          const [orders, events] = await Promise.all([
            d.db.query('SELECT idx, address, owner, side, escrow::text, sealed, status, price::text, quantity::text, fill::text, quote_out::text, base_out::text, fee::text FROM orders WHERE cross_address = $1 ORDER BY idx', [a]),
            d.db.query('SELECT signature, seq, slot::text, extract(epoch FROM block_time)::bigint::text AS block_time, name, payload FROM events WHERE cross_address = $1 ORDER BY slot, signature, seq', [a]),
          ]);
          const proof = await (paid.verifyProof ?? verifyCross)(fetchOwned, a);
          const data = { proof, orders: orders.rows, events: events.rows };
          const body = {
            schema: 'opening-cross/audit-bundle/v1', cluster: d.network ?? 'unknown', cross: a, generatedAt: now(),
            proofSha256: sha(proof), ordersSha256: sha(orders.rows), eventsSha256: sha(events.rows), orders: orders.rows.length, events: events.rows.length, verified: proof.verified,
          };
          const signed = signer ? await signDocument(body as never, signer.keyPair) : null;
          return { attestation: signed ?? { body, unsigned: true, reason: 'no attestation key is configured on this deployment' }, data, check: 'Hash each member of `data` with sha-256 over its canonical JSON and compare with the attestation body; the index is a projection of the chain, so re-run the proof yourself for evidence.' };
        },
      };
    },
  });

  // ---------------------------------------------------------------- order desk
  registerPaidRoute(app, route.gate, {
    method: 'POST',
    url: '/v1/paid/order-desk',
    description: `Pre-trade check for an order: the unsigned transaction and the cluster's own simulation of it (${rateNote})`,
    ...(paid.publicOrigin ? { publicOrigin: paid.publicOrigin } : {}),
    prepare: async (req): Promise<Prepared> => {
      const b = req.body as Record<string, unknown> | null;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new RequestError(400, 'request body must be a JSON object with cross, owner, nonce, side, price and quantity');
      const crossAddr = addr(b.cross, 'cross');
      const owner = addr(b.owner, 'owner');
      const nonce = u64(b.nonce, 'nonce');
      const price_ = u64(b.price, 'price');
      const quantity = u64(b.quantity, 'quantity');
      if (b.side !== 'buy' && b.side !== 'sell') throw new RequestError(400, 'side must be "buy" or "sell"');
      const side = b.side === 'buy' ? OrderSide.Buy : OrderSide.Sell;
      const salt = b.salt === undefined ? undefined : typeof b.salt === 'string' && /^[0-9a-fA-F]{64}$/.test(b.salt) ? Uint8Array.from(Buffer.from(b.salt, 'hex')) : (() => { throw new RequestError(400, 'salt must be 32 bytes of hex'); })();
      const view = await settledCross(crossAddr);
      const c = view.data;
      const t = BigInt(now());
      if (c.state !== CrossState.Live) throw new RequestError(409, `this cross is ${STATE[c.state]}; it takes no new orders`);
      if (t < c.openTs) throw new RequestError(409, 'this cross has not opened yet');
      if (t >= c.closeTs) throw new RequestError(409, 'this cross has closed; it takes no new orders');
      const tick = c.tick;
      if (price_ < c.minPrice || (price_ - c.minPrice) % tick !== 0n || (price_ - c.minPrice) / tick >= BigInt(c.ticks)) throw new RequestError(400, `price ${price_} is not on the grid (minimum ${c.minPrice}, step ${tick}, ${c.ticks} steps)`);
      if (c.disclosure === Disclosure.Sealed && !salt) throw new RequestError(400, 'sealed cross: provide a 32-byte hex salt and keep it for the reveal');
      const escrow = side === OrderSide.Buy ? (quantity * price_ + c.priceScale - 1n) / c.priceScale : quantity;
      const summary = {
        cross: crossAddr, owner, side: b.side, price: price_, quantity, escrow, escrowAsset: side === OrderSide.Buy ? 'quote' : 'base',
        phase: c.disclosure === Disclosure.Sealed ? 'sealed call open' : 'open call', secondsLeft: c.closeTs - t, feeBps: c.protocolFeeBps + c.integratorFeeBps,
        feeNote: side === OrderSide.Buy ? 'Buyers pay no fee.' : 'Sellers pay the fee on what is filled.',
      };
      return {
        amount: price('order-desk'),
        preview: async () => ({ ...summary, note: 'This is the check. A payment returns the unsigned transaction and the cluster\'s own simulation of it.' }),
        full: async () => {
          const lt: Lifetime = await d.lifetime();
          const tx = await placeOrderTx(fetchOwned, view, { owner, nonce, side, price: price_, quantity, ...(salt ? { salt } : {}) }, lt);
          const sim = await (paid.simulate ?? ((w: string) => jsonRpcSimulate(process.env.RPC_URL ?? '', w)))(tx.transaction);
          return {
            ...summary,
            transaction: tx.transaction,
            signers: tx.signers,
            order: tx.order,
            preflight: { wouldSucceed: sim.err === null, error: sim.err, unitsConsumed: sim.unitsConsumed, logs: sim.logs.slice(-12) },
            note: 'Unsigned: nothing moves until the owner signs and sends it. The simulation ran against the cluster\'s current state without the owner\'s signature.',
          };
        },
      };
    },
  });
}
