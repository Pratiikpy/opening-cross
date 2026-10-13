// The limit price of an open order read from the chain's own record of the transaction that placed it (S1).
import { beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { type Address, generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { COMMIT_ORDER_DISCRIMINATOR, CROSS_CORE_PROGRAM_ADDRESS, ORDER_DISCRIMINATOR, getCommitOrderInstructionDataEncoder } from '@opening-cross/sdk';
import type { TxBody } from '@opening-cross/indexer';
import { RequestError } from '../src/tx.js';
import { registerHolderTerms } from '../src/routes/holder-terms.js';

const keys = async (n: number) => Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));

function commitTx(accountKeys: string[], order: string, price: bigint, quantity: bigint, sealed = false): TxBody {
  const data = getCommitOrderInstructionDataEncoder().encode({ nonce: 1n, side: 0, escrow: 5n, commitment: new Uint8Array(sealed ? 32 : 32).fill(sealed ? 7 : 0), price, quantity, orderBump: 254 });
  const accounts = [0, 1, 2, accountKeys.indexOf(order)];
  return { transaction: { message: { accountKeys, instructions: [{ programIdIndex: accountKeys.indexOf(CROSS_CORE_PROGRAM_ADDRESS), accounts, data: getBase58Decoder().decode(data) }] } }, meta: null };
}

describe('GET /v1/orders/:address/terms', () => {
  let order: Address, sealedOrder: Address, notOrder: Address;
  const accounts = new Map<string, { data: Uint8Array; owner: Address }>();
  const txs = new Map<string, TxBody | null>();
  let reads = 0;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    const [owner, protocol, cross] = await keys(3);
    [order, sealedOrder, notOrder] = await keys(3);
    const orderAcct = () => ({ owner: CROSS_CORE_PROGRAM_ADDRESS, data: Uint8Array.from([...(ORDER_DISCRIMINATOR as Uint8Array), 0, 0, 0]) });
    accounts.set(order, orderAcct());
    accounts.set(sealedOrder, orderAcct());
    accounts.set(notOrder, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: new Uint8Array(40) });
    const k = (o: Address) => [owner, protocol, cross, o, CROSS_CORE_PROGRAM_ADDRESS];
    txs.set(order, commitTx(k(order), order, 1_500_000n, 300_000_000n));
    txs.set(sealedOrder, commitTx(k(sealedOrder), sealedOrder, 0n, 0n, true));
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message }) : reply.code(500).send({ error: String(err) })));
    registerHolderTerms(app, {
      account: async (a) => accounts.get(a) ?? null,
      firstTransaction: async (a) => {
        reads += 1;
        return txs.get(a) ?? null;
      },
    });
    await app.ready();
  });

  it('reads the price and quantity from the commit_order instruction and keeps the answer', async () => {
    const r = (await app.inject(`/v1/orders/${order}/terms`)).json();
    expect(r).toEqual({ address: order, terms: { price: '1500000', quantity: '300000000' } });
    const before = reads;
    expect((await app.inject(`/v1/orders/${order}/terms`)).json().terms).toEqual({ price: '1500000', quantity: '300000000' });
    expect(reads).toBe(before);
    expect(COMMIT_ORDER_DISCRIMINATOR.length).toBe(8);
  });

  it('says a sealed order has no terms on chain, and an unreadable transaction is not a final answer', async () => {
    const s = (await app.inject(`/v1/orders/${sealedOrder}/terms`)).json();
    expect(s.terms).toBeNull();
    expect(s.reason).toContain('sealed');
    const [lost] = await keys(1);
    accounts.set(lost, { owner: CROSS_CORE_PROGRAM_ADDRESS, data: Uint8Array.from([...(ORDER_DISCRIMINATOR as Uint8Array), 0]) });
    const a = (await app.inject(`/v1/orders/${lost}/terms`)).json();
    expect(a.terms).toBeNull();
    expect(a.reason).toContain('could not be read');
    txs.set(lost, commitTx([lost, CROSS_CORE_PROGRAM_ADDRESS, lost, lost], lost, 2_000_000n, 1n));
    expect((await app.inject(`/v1/orders/${lost}/terms`)).json().terms).toEqual({ price: '2000000', quantity: '1' });
  });

  it('refuses an address that is not an order, and junk', async () => {
    expect((await app.inject(`/v1/orders/${notOrder}/terms`)).statusCode).toBe(404);
    const [nothing] = await keys(1);
    expect((await app.inject(`/v1/orders/${nothing}/terms`)).statusCode).toBe(404);
    expect((await app.inject('/v1/orders/not-an-address/terms')).statusCode).toBe(400);
  });
});
