// /v1/fees/*: the schedule from the protocol account, the three-source ledger, signed referrals and their payouts, the allocation and
// signed statements. The chain is in memory with real encoded accounts; the finalize transaction's token balances are built to be
// exactly what finalize does, and altered to prove the ledger notices.
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Address, generateKeyPair, getAddressFromPublicKey, none } from '@solana/kit';
import { CROSS_CORE_PROGRAM_ADDRESS, CrossState, getProtocolEncoder, protocolAddress } from '@opening-cross/sdk';
import { REFERRAL_SCHEMA, signReferral, verifyStatement } from '@opening-cross/fees';
import type { SignedStatement, TransactionBalances } from '@opening-cross/fees';
import { registerFees } from '../src/routes/fees.js';
import { RequestError } from '../src/tx.js';
import { Chain, databaseUrl, insertCross, insertOrder, newAddress, openSchema } from './helpers/w2a.js';

const NOW = 1_800_000_000;
const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('fees.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

describeDb('fee routes', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  const chain = new Chain();
  const txs = new Map<string, TransactionBalances | null | 'throw'>();
  const keys = { keyPair: undefined as unknown as CryptoKeyPair, address: "" };
  let quote: Address;
  let feeRecipient: Address;
  let integrator: Address;
  let proceedsTo: Address;
  let creator: Address;
  let buyerA: Address;
  let buyerB: Address;

  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as object });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };

  /** What finalize does for an escrow cross: the vault pays the protocol, the integrator and the proceeds recipient. */
  function finalizeBalances(cross: Address, fees: { protocol: bigint; integrator: bigint; proceeds: bigint }): TransactionBalances {
    const bal = (owner: string, amount: bigint, accountIndex: number) => ({ accountIndex, mint: quote as string, owner, uiTokenAmount: { amount: amount.toString() } });
    const total = fees.protocol + fees.integrator + fees.proceeds;
    return {
      err: null,
      preTokenBalances: [bal(cross, total + 10n, 0), bal(feeRecipient, 0n, 1), bal(integrator, 0n, 2), bal(proceedsTo, 0n, 3)],
      postTokenBalances: [bal(cross, 10n, 0), bal(feeRecipient, fees.protocol, 1), bal(integrator, fees.integrator, 2), bal(proceedsTo, fees.proceeds, 3)],
    };
  }

  /** A finalized escrow reopen cross whose sellers paid `gross` and a fee of 25 bps in all. */
  async function finalizedCross(o: { sig: string; slot: number; gross: bigint; recordedProtocol?: bigint; tx?: 'ok' | 'none' | 'throw' | 'altered' }) {
    const total = (o.gross * 25n) / 10_000n;
    const protocol = (total * 5n) / 25n;
    const integratorFee = total - protocol;
    const address = await chain.putCross({ state: CrossState.Finalized, kind: 1, supplyMode: 0, quoteMint: quote, creator, integrator, feeRecipient, proceedsTo, protocolFeeBps: 5, integratorFeeBps: 20, buyerPaid: o.gross, feesAccrued: total });
    await insertCross(db, address, { state: 'Finalized', kind: 1, slot: o.slot });
    await db.query(`UPDATE crosses SET quote_mint = $2, protocol_fee_bps = 5, integrator_fee_bps = 20 WHERE address = $1`, [address, quote]);
    await db.query(`INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ($1,0,$2,to_timestamp($3),'CrossFinalized',$4,$5)`, [o.sig, o.slot, NOW - 1_000 + o.slot, address, JSON.stringify({ cross: address, protocolFee: (o.recordedProtocol ?? protocol).toString(), integratorFee: integratorFee.toString(), proceedsQuote: '3000', dustBase: '0' })]);
    const balances = finalizeBalances(address, { protocol: o.recordedProtocol ?? protocol, integrator: integratorFee, proceeds: 3000n });
    txs.set(o.sig, o.tx === 'none' ? null : o.tx === 'throw' ? 'throw' : o.tx === 'altered' ? { ...balances, postTokenBalances: balances.postTokenBalances.map((b) => (b.owner === integrator ? { ...b, uiTokenAmount: { amount: (BigInt(b.uiTokenAmount.amount) - 1n).toString() } } : b)) } : balances);
    return { address, protocol, integratorFee, total };
  }

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    [quote, feeRecipient, integrator, proceedsTo, creator, buyerA, buyerB] = [await newAddress(), await newAddress(), await newAddress(), await newAddress(), await newAddress(), await newAddress(), await newAddress()];
    const kp = await generateKeyPair();
    keys.keyPair = kp;
    keys.address = await getAddressFromPublicKey(kp.publicKey);
    chain.set(await protocolAddress(), { owner: CROSS_CORE_PROGRAM_ADDRESS as Address, data: new Uint8Array(getProtocolEncoder().encode({ admin: creator, guardian: creator, feeRecipient, feeBps: [30, 5, 15, 30], paused: false, bump: 255, pendingAdmin: none() } as never)) });
    app = Fastify();
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message, ...err.detail }) : reply.code(500).send({ error: String(err) })));
    registerFees(
      app,
      { db, account: chain.read, clock: () => NOW, network: 'devnet' },
      {
        transaction: async (sig) => {
          const t = txs.get(sig);
          if (t === 'throw') throw new Error('HTTP error (429)');
          return t ?? null;
        },
        signer: keys,
      },
    );
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it('reads the schedule from the protocol account and states what the program does and what it does not', async () => {
    const r = await get('/v1/fees/schedule');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ network: 'devnet', status: 'proposed', feeRecipient, paused: false, protocolBps: { launch: 30, reopen: 5, tender: 15, recurring: 30 }, bounds: { maxProtocolBps: 100, maxIntegratorBps: 300 } });
    expect(r.body.offChainOnly.referrerShareBps.value).toBe(1000);
    expect(r.body.offChainOnly.rebateShareBps.value).toBe(2500);
    expect(r.body.inProgram.join(' ')).toContain('snapshot');
  });

  it('builds a ledger that agrees with the finalize transaction, and says MISMATCH or UNVERIFIED instead of guessing', async () => {
    const ok = await finalizedCross({ sig: 'sigOK', slot: 10, gross: 155_000_000n });
    await finalizedCross({ sig: 'sigWrongEvent', slot: 11, gross: 155_000_000n, recordedProtocol: 1n });
    await finalizedCross({ sig: 'sigNoTx', slot: 12, gross: 155_000_000n, tx: 'none' });
    await finalizedCross({ sig: 'sigAltered', slot: 13, gross: 155_000_000n, tx: 'altered' });
    await finalizedCross({ sig: 'sigBusy', slot: 14, gross: 155_000_000n, tx: 'throw' });
    const r = await get('/v1/fees/ledger');
    expect(r.status).toBe(200);
    const bySig = new Map<string, any>(r.body.entries.map((e: { signature: string }) => [e.signature, e]));
    expect(bySig.get('sigOK')).toMatchObject({ cross: ok.address, verdict: 'MATCH', protocolFee: String(ok.protocol), integratorFee: String(ok.integratorFee), kind: 'reopen', supplyMode: 'escrow' });
    expect(bySig.get('sigOK').expected).toEqual({ total: String(ok.total), protocol: String(ok.protocol), integrator: String(ok.integratorFee) });
    expect(bySig.get('sigWrongEvent')).toMatchObject({ verdict: 'MISMATCH' });
    expect(bySig.get('sigWrongEvent').reasons.join(' ')).toContain('protocol fee');
    expect(bySig.get('sigNoTx').verdict).toBe('UNVERIFIED');
    expect(bySig.get('sigAltered').verdict).toBe('MISMATCH');
    expect(bySig.get('sigAltered').reasons.join(' ')).toContain('chain:');
    expect(bySig.get('sigBusy').verdict).toBe('UNVERIFIED');
    // Only the matching line is counted.
    expect(r.body.totals.verified[quote]).toEqual({ protocolFee: String(ok.protocol), integratorFee: String(ok.integratorFee), crosses: 1 });
    expect(r.body.totals).toMatchObject({ unverified: 2, mismatched: 2 });
    // A busy endpoint is retried on the next request instead of being remembered as a verdict.
    txs.set('sigBusy', finalizeBalances((r.body.entries.find((e: { signature: string }) => e.signature === 'sigBusy') as { cross: Address }).cross, { protocol: 77_500n, integrator: 310_000n, proceeds: 3000n }));
    const again = await get('/v1/fees/ledger');
    expect(again.body.entries.find((e: { signature: string }) => e.signature === 'sigBusy').verdict).toBe('MATCH');
    expect((await get('/v1/fees/ledger?limit=0')).status).toBe(400);
    expect((await get('/v1/fees/ledger?limit=1000')).status).toBe(400);
  });

  it('stores a referral only if the referred wallet signed it, and pays 10% of the protocol fee the referred orders generated', async () => {
    const referredKp = await generateKeyPair();
    const referred = (await getAddressFromPublicKey(referredKp.publicKey)) as Address;
    const referrer = await newAddress();
    const other = await generateKeyPair();
    const body = { schema: REFERRAL_SCHEMA as typeof REFERRAL_SCHEMA, owner: referred, referrer, effectiveFrom: 0, nonce: 'a1b2c3d4e5f60718' };
    const signed = await signReferral(body, referredKp);
    const forged = await signReferral(body, other);
    expect((await post('/v1/referrals', forged)).status).toBe(400);
    expect((await post('/v1/referrals', { body: 1 })).status).toBe(400);
    expect((await post('/v1/referrals', signed)).status).toBe(201);
    expect((await post('/v1/referrals', signed)).body.stored).toBe(false); // the same document twice stores once
    expect((await get(`/v1/referrals?owner=${referred}`)).body.referrals).toHaveLength(1);

    // The referred wallet sold 100 base at 1.55 in a matched cross: gross 155,000,000, fee 25 bps = 387,500, protocol share 77,500.
    const f = await finalizedCross({ sig: 'sigRef', slot: 20, gross: 155_000_000n });
    await insertOrder(db, f.address, 0, referred, 'sell', 1_550_000n, 100_000_000n, 'claimed');
    await db.query(`UPDATE orders SET escrow = 100000000, fee = 387500, quote_out = 154612500, fill = 100000000 WHERE cross_address = $1 AND idx = 0`, [f.address]);
    await db.query(`INSERT INTO events (signature, seq, slot, block_time, name, cross_address, payload) VALUES ('sigPlaced', 0, 5, to_timestamp($1), 'OrderCommitted', $2, $3)`, [NOW - 5_000, f.address, JSON.stringify({ cross: f.address, order: `${f.address}-o0` })]);
    const r = await get(`/v1/fees/referrals/${referrer}`);
    expect(r.status).toBe(200);
    // 10% of the protocol's 77,500 share of the 387,500 the order paid.
    expect(r.body.payouts).toEqual([expect.objectContaining({ order: `${f.address}-o0`, owner: referred, referrer, protocolFeeShare: '77500', payout: '7750', quoteMint: quote })]);
    expect(r.body.totals[quote]).toBe('7750');
    expect(r.body.note).toContain('does not record that one was made');
    expect((await get('/v1/fees/referrals/nope')).status).toBe(400);

    const a = await get('/v1/fees/allocation');
    const mint = a.body.allocation[quote];
    // Every MATCH line: reopen crosses give 25% of the protocol fee to the rebate pool; the referral comes off the same fee.
    expect(BigInt(mint.referrals)).toBe(7750n);
    expect(BigInt(mint.gross)).toBe(BigInt(mint.referrals) + BigInt(mint.rebatePool) + BigInt(mint.operating));
    expect(BigInt(mint.rebatePool)).toBe((BigInt(mint.gross) * 2500n) / 10_000n);
  });

  it('signs a statement with the attestation key, and the signature and totals check out', async () => {
    const r = await get(`/v1/fees/statement/integrator/${integrator}`);
    expect(r.status).toBe(200);
    const s = r.body as SignedStatement;
    expect(s.signer).toBe(keys.address);
    expect(s.body).toMatchObject({ role: 'integrator', party: integrator, cluster: 'devnet' });
    expect(s.body.counts.match).toBeGreaterThan(0);
    expect(await verifyStatement(s, keys.address)).toEqual({ ok: true });
    expect(await verifyStatement({ ...s, body: { ...s.body, party: creator } }, keys.address)).not.toEqual({ ok: true });
    expect((await get(`/v1/fees/statement/auditor/${integrator}`)).status).toBe(400);
    expect((await get(`/v1/fees/statement/integrator/${integrator}?from=5&to=2`)).status).toBe(400);
    const none = await get(`/v1/fees/statement/integrator/${await newAddress()}`);
    expect(none.body.body.lines).toEqual([]);
  });
});
