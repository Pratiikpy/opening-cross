// cross_settle over HTTP with accounts injected in memory: the refusals that come before a transaction, and the transactions built for the partner
// payouts and the greenshoe (decoded back to instructions). The program itself is not run here; its LiteSVM suites run against the real binaries.
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address, type Instruction, decompileTransactionMessage, generateKeyPairSigner, getCompiledTransactionMessageDecoder, getTransactionDecoder, none } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CROSS_BODY_LEN, CROSS_CORE_PROGRAM_ADDRESS, CrossKind, CrossState, Disclosure, SupplyMode, crossAddress, getCrossEncoder } from '@opening-cross/sdk';
import { CROSS_SETTLE_PROGRAM_ADDRESS, CLAIM_PARTNER_FEE_DISCRIMINATOR, CREATE_GREENSHOE_DISCRIMINATOR, DEPLOY_GREENSHOE_BID_DISCRIMINATOR, FINISH_GREENSHOE_DISCRIMINATOR, SETTLE_GREENSHOE_LEVEL_DISCRIMINATOR, getGreenshoeEncoder } from '@opening-cross/cross-settle-client';
import { dlmmAddresses, greenshoeAddresses, greenshoeBinFor, greenshoeMinBudget } from '@opening-cross/adapters';
import { RequestError } from '../src/tx.js';
import { registerSettleTx } from '../src/routes/settle-tx.js';

const NOW = 1_800_000_000;
const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never;
const ZERO = '11111111111111111111111111111111' as Address;
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' as Address;
const key = async () => (await generateKeyPairSigner()).address;
type Account = { data: Uint8Array; owner: Address };

describe('cross_settle over HTTP', () => {
  const accounts = new Map<string, Account>();
  let app: ReturnType<typeof Fastify>;
  let creator: Address, base: Address, quote: Address, integrator: Address, fees: Address, payer: Address, limitOrder: Address;
  let finalized: Address, live: Address, withShoe: Address;

  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const instructionsOf = (tx: string): Instruction[] => {
    const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
    return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
  };
  const is = (ix: Instruction, disc: Uint8Array) => ix.programAddress === CROSS_SETTLE_PROGRAM_ADDRESS && disc.every((b, i) => ix.data![i] === b);

  async function putCross(id: bigint, o: { state: CrossState; buyerPaid?: bigint }): Promise<Address> {
    const address = await crossAddress(creator, id);
    const body = getCrossEncoder().encode({
      creator, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.DeferredMint, disclosure: Disclosure.Open, state: o.state,
      baseMint: base, quoteMint: quote, baseTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, baseDecimals: 6, quoteDecimals: 6, proceedsTo: creator,
      minPrice: 1_000_000n, tick: 100_000n, ticks: 20, priceScale: 1_000_000n, openTs: 1n, closeTs: 2n, revealEndTs: 3n, referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(),
      protocolFeeBps: 30, integratorFeeBps: 20, integrator, feeRecipient: fees, gateMint: none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: 0, ordersOpen: 0, mergedMask: 3,
      clearing: none(), noPrintReason: none(), buyerPaid: o.buyerPaid ?? 2_600_000_000n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(),
      settleDeadlineTs: 0n, baseBound: true, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN);
    data.set(body);
    accounts.set(address, { owner: CROSS_CORE_PROGRAM_ADDRESS, data });
    return address;
  }
  /** A DLMM pair account with the bin step and active bin at the offsets the API reads. */
  const putPair = (cross: Address, active: number, step: number) => {
    const data = new Uint8Array(904);
    const v = new DataView(data.buffer);
    v.setInt32(76, active, true);
    v.setUint16(80, step, true);
    accounts.set(dlmmAddresses(base, quote).lbPair, { owner: DLMM, data });
    void cross;
  };

  beforeAll(async () => {
    [creator, base, quote, integrator, fees, payer, limitOrder] = await Promise.all(Array.from({ length: 7 }, key));
    finalized = await putCross(1n, { state: CrossState.Finalized });
    live = await putCross(2n, { state: CrossState.Live });
    app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
      return reply.code(500).send({ error: String(err) });
    });
    registerSettleTx(app, { account: async (a) => accounts.get(a) ?? null, lifetime: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }), clock: () => NOW });
    void withShoe;
  }, 60_000);

  it('partner payouts need a settled cross, and build the claim for one', async () => {
    expect((await post('/v1/tx/claim-partner-fee', { cross: live, payer })).body.reason).toBe('LIVE');
    const r = await post('/v1/tx/claim-partner-fee', { cross: finalized, payer, maxQuote: '1000' });
    expect(r.status).toBe(200);
    const [ix] = instructionsOf(r.body.transaction);
    expect(is(ix!, CLAIM_PARTNER_FEE_DISCRIMINATOR)).toBe(true);
    expect(r.body.recipient).toBe(fees);
    expect((await post('/v1/tx/claim-partner-fee', { cross: finalized, payer: 'x' })).status).toBe(400);
    expect((await post('/v1/tx/withdraw-partner-surplus', { cross: finalized, payer })).status).toBe(200);
    expect((await post('/v1/tx/withdraw-partner-migration-fee', { cross: finalized, payer })).status).toBe(200);
    expect((await post('/v1/tx/claim-partner-pool-creation-fee', { cross: finalized, payer })).status).toBe(200);
  });

  describe('greenshoe', () => {
    const g = (over: Record<string, unknown> = {}) => ({ cross: finalized, creator, budget: '300000000', startTs: String(NOW + 60), periodSecs: '3600', periodCap: '300000000', ...over });
    it('create: only the creator, after finalization, with at least 10% of what buyers paid, a window that starts now or later, and a pair to bid in', async () => {
      expect((await post('/v1/tx/create-greenshoe', g({ cross: live }))).body.reason).toBe('NOT_FINALIZED');
      expect((await post('/v1/tx/create-greenshoe', g({ creator: payer }))).body.reason).toBe('NOT_THE_CREATOR');
      const min = greenshoeMinBudget(2_600_000_000n);
      const thin = await post('/v1/tx/create-greenshoe', g({ budget: String(min - 1n) }));
      expect(thin.body.reason).toBe('BUDGET_TOO_SMALL');
      expect(thin.body.minBudget).toBe(String(min));
      expect((await post('/v1/tx/create-greenshoe', g({ startTs: String(NOW - 5) }))).body.reason).toBe('START_IN_PAST');
      expect((await post('/v1/tx/create-greenshoe', g())).body.reason).toBe('NO_DLMM_PAIR');
      putPair(finalized, 262, 10);
      const ok = await post('/v1/tx/create-greenshoe', g());
      expect(ok.status).toBe(200);
      expect(is(instructionsOf(ok.body.transaction)[0]!, CREATE_GREENSHOE_DISCRIMINATOR)).toBe(true);
    });

    it('bids, level settlement and finish are refused when the greenshoe is not in the state they need, and built when it is', async () => {
      expect((await post('/v1/tx/deploy-greenshoe-bid', { cross: finalized, payer, limitOrder, level: 0, amount: '1' })).body.reason).toBe('NO_GREENSHOE');
      const a = await greenshoeAddresses(finalized);
      const shoe = (over: Record<string, unknown> = {}) =>
        accounts.set(a.greenshoe, {
          owner: CROSS_SETTLE_PROGRAM_ADDRESS,
          data: new Uint8Array(getGreenshoeEncoder().encode({
            cross: finalized, creator, lbPair: dlmmAddresses(base, quote).lbPair, baseMint: base, quoteMint: quote, referencePrice: 1_300_000n, priceScale: 1_000_000n, startTs: BigInt(NOW - 10), expiresTs: BigInt(NOW + 7 * 86_400),
            budget: 300_000_000n, deployed: 0n, periodSecs: 3_600n, periodCap: 300_000_000n, periodStart: 0n, periodDeployed: 0n, orders: [ZERO, ZERO, ZERO], bins: [0, 0, 0], amounts: [0n, 0n, 0n], levelSettled: [false, false, false], finished: false, bump: 1, vaultBump: 1, baseBump: 1, ...over,
          } as never)),
        });
      shoe();
      const bin = greenshoeBinFor(1_300_000n, 1_000_000n, 10, 0);
      const ok = await post('/v1/tx/deploy-greenshoe-bid', { cross: finalized, payer, limitOrder, level: 0, amount: '100000000' });
      expect(ok.status).toBe(200);
      expect(ok.body.binId).toBe(bin);
      expect(is(instructionsOf(ok.body.transaction)[0]!, DEPLOY_GREENSHOE_BID_DISCRIMINATOR)).toBe(true);
      // the limit order is a fresh keypair that signs next to the payer
      expect(ok.body.signers).toEqual(expect.arrayContaining([payer, limitOrder]));
      expect((await post('/v1/tx/deploy-greenshoe-bid', { cross: finalized, payer, limitOrder, level: 0, amount: '200000000' })).body.reason).toBe('OVER_LEVEL_CAP');
      expect((await post('/v1/tx/deploy-greenshoe-bid', { cross: finalized, payer, limitOrder, level: 3, amount: '1' })).status).toBe(400);
      expect((await post('/v1/tx/deploy-greenshoe-bid', { cross: finalized, payer, limitOrder, level: 0, amount: '1', binId: 262 })).body.reason).toBe('BIN_NOT_BELOW_ACTIVE');
      expect((await post('/v1/tx/settle-greenshoe-level', { cross: finalized, payer, level: 0 })).body.reason).toBe('NOT_EXPIRED');
      expect((await post('/v1/tx/finish-greenshoe', { cross: finalized, payer })).body.reason).toBe('NOT_EXPIRED');
      shoe({ expiresTs: BigInt(NOW - 1), orders: [limitOrder, ZERO, ZERO], bins: [bin, 0, 0], levelSettled: [false, false, false], deployed: 100_000_000n });
      expect((await post('/v1/tx/deploy-greenshoe-bid', { cross: finalized, payer, limitOrder, level: 1, amount: '1' })).body.reason).toBe('EXPIRED');
      expect((await post('/v1/tx/settle-greenshoe-level', { cross: finalized, payer, level: 1 })).body.reason).toBe('LEVEL_NOT_PLACED');
      expect((await post('/v1/tx/finish-greenshoe', { cross: finalized, payer })).body.reason).toBe('LEVELS_OPEN');
      const settle = await post('/v1/tx/settle-greenshoe-level', { cross: finalized, payer, level: 0, hook: false });
      expect(settle.status).toBe(200);
      expect(is(instructionsOf(settle.body.transaction)[0]!, SETTLE_GREENSHOE_LEVEL_DISCRIMINATOR)).toBe(true);
      shoe({ expiresTs: BigInt(NOW - 1), orders: [limitOrder, ZERO, ZERO], bins: [bin, 0, 0], levelSettled: [true, false, false] });
      expect((await post('/v1/tx/settle-greenshoe-level', { cross: finalized, payer, level: 0 })).body.reason).toBe('ALREADY_SETTLED');
      const done = await post('/v1/tx/finish-greenshoe', { cross: finalized, payer });
      expect(done.status).toBe(200);
      expect(is(instructionsOf(done.body.transaction)[0]!, FINISH_GREENSHOE_DISCRIMINATOR)).toBe(true);
      shoe({ finished: true });
      expect((await post('/v1/tx/finish-greenshoe', { cross: finalized, payer })).body.reason).toBe('FINISHED');
    });
  });
});
