// The Alpha Vault routes of the API, run against the real alpha_vault, cp_amm and lb_clmm binaries (ADR-0910, rows X13, R2, V-D). Every transaction is built by the API from what
// it reads off the chain, signed the way a wallet would and landed on LiteSVM; the vault's own accounts and the token balances are read back. Both venues (a DAMM v2 pool and a
// DLMM pair), both modes (pro rata and first come) and the states a careless caller reaches: no escrow, too much, too late, the wrong mode, no vault, no pool.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { type KeyPairSigner, generateKeyPairSigner } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { OrderSide } from '@opening-cross/sdk';
import { ALPHA_VAULT_PROGRAM_ADDRESS, alphaEscrowAddress, buildDlmmConvictionLadder, buildOpenDlmmPair, buildSeedDammV2 } from '@opening-cross/adapters';
import { buildMeteoraTxApp } from '../../../services/api/src/routes/meteora-tx.js';
import { World } from '../src/world.js';
import { DAMM_FIXTURE, DLMM_FIXTURE } from '../src/harness.js';

// The chain runs are many transactions each; the default five seconds is for pure functions.
vi.setConfig({ testTimeout: 180_000 });

const VAULT_FIXTURE = fileURLToPath(new URL('../../fixtures/alpha_vault.so', import.meta.url));
const T22 = TOKEN_2022_PROGRAM_ADDRESS;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const have = existsSync(VAULT_FIXTURE) && existsSync(DAMM_FIXTURE) && existsSync(DLMM_FIXTURE);

async function clearedCross(w: World) {
  const cross = await w.newCross();
  const s = await w.trader(0n, 5_000_000_000n);
  const b = await w.trader(20_000_000_000n);
  const orders = [await w.place(cross, s, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, b, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  return w.view(cross.address);
}

async function harness(w: World) {
  w.h.svm.addProgramFromFile(ALPHA_VAULT_PROGRAM_ADDRESS, VAULT_FIXTURE);
  const app = await buildMeteoraTxApp({
    account: async (a) => {
      const x = w.h.svm.getAccount(a);
      return x.exists ? { data: x.data, owner: x.programAddress } : null;
    },
    lifetime: async () => ({ blockhash: w.h.svm.latestBlockhash() as never, lastValidBlockHeight: 1_000_000n }),
    clock: () => Number(w.h.svm.getClock().unixTimestamp),
  });
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as object });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  /** The API built it, the signer signs it, LiteSVM runs it. Returns the logs of a failure instead of throwing, to read the program's own refusal. */
  const land = async (built: { status: number; body: { transaction?: string; error?: string } }, signers: KeyPairSigner[]) => {
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    return w.h.sendWire(built.body.transaction!, signers);
  };
  return { app, post, get, land };
}

describe.skipIf(!have)('Alpha Vault routes against the real binaries, DAMM v2 pool, pro rata', () => {
  it('runs a vault from creation through deposits, a change of mind, the fill, claims and refunds, and refuses each wrong state in words', async () => {
    const w = await World.create();
    const { post, get, land } = await harness(w);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const start = now + 7200n;
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 300, alphaVault: true, batch: { windowSecs: 3600, activationPoint: start, endingFeeBps: 30, periods: 10, periodSecs: 60 } });
    await w.h.send([cu, seed.instruction], w.creator);
    const X = cross.address;

    // No vault yet: reads say so, deposits and fills are refused with the reason.
    expect((await get(`/v1/crosses/${X}/alpha-vault`)).body).toMatchObject({ state: null });
    expect(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: w.creator.address, amount: '1' })).toMatchObject({ status: 404, body: { reason: 'NO_ALPHA_VAULT' } });
    // A DLMM vault cannot be created while there is no DLMM pair.
    expect(await post('/v1/tx/alpha-vault-init', { cross: X, venue: 'dlmm', mode: 'prorata', maxBuyingCap: '1', startVestingPoint: String(start + 100n), endVestingPoint: String(start + 200n) })).toMatchObject({ status: 409, body: { reason: 'NO_POOL', venue: 'dlmm' } });
    expect((await post('/v1/tx/alpha-vault-init', { cross: X, venue: 'amm', mode: 'prorata', maxBuyingCap: '1', startVestingPoint: '1', endVestingPoint: '2' })).status).toBe(400);

    // Create the pro-rata vault through the route.
    const cap = 8_000_000_000n;
    const init = await post('/v1/tx/alpha-vault-init', { cross: X, mode: 'prorata', maxBuyingCap: String(cap), startVestingPoint: String(start + 100n), endVestingPoint: String(start + 200n) });
    expect(init.body.venue).toBe('damm');
    await land(init, [w.creator]);
    expect((await post('/v1/tx/alpha-vault-init', { cross: X, mode: 'prorata', maxBuyingCap: String(cap), startVestingPoint: String(start + 100n), endVestingPoint: String(start + 200n) })).body.reason).toBe('VAULT_EXISTS');
    const vault = init.body.vault as string;

    // Deposits: Alice 9, Bob 3, Carol 1.
    const alice = await w.trader(20_000_000_000n);
    const bob = await w.trader(20_000_000_000n);
    const carol = await w.trader(20_000_000_000n);
    for (const [who, amount] of [[alice, 9_000_000_000n], [bob, 3_000_000_000n], [carol, 1_000_000_000n]] as const) {
      const r = await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: who.address, amount: String(amount) });
      expect(r.body.opensEscrow).toBe(true);
      await land(r, [who]);
    }
    const read = await get(`/v1/crosses/${X}/alpha-vault?owner=${alice.address}`);
    expect(read.body).toMatchObject({ vault, venue: 'damm', mode: 'prorata', hasEscrow: true, deposited: '9000000000' });
    expect(await w.h.balanceOf(vault as never, w.quoteMint)).toBe(13_000_000_000n);
    // A broke caller and a zero amount are refused before anything is built.
    const broke = await w.trader(0n, 0n);
    expect((await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: broke.address, amount: '5' })).status).toBeGreaterThanOrEqual(409);
    expect((await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: alice.address, amount: '0' })).status).toBe(400);

    // Changing one's mind: Carol takes her 1 back and closes her escrow; Bob names more than he has and is told.
    expect((await post('/v1/tx/alpha-vault-withdraw', { cross: X, owner: broke.address })).body.reason).toBe('NO_ESCROW');
    expect(await post('/v1/tx/alpha-vault-withdraw', { cross: X, owner: bob.address, amount: '3000000001' })).toMatchObject({ status: 422, body: { reason: 'OVER_WITHDRAW' } });
    expect((await post('/v1/tx/alpha-vault-withdraw', { cross: X, owner: bob.address, amount: '0' })).status).toBe(400);
    expect(await post('/v1/tx/alpha-vault-close-escrow', { cross: X, owner: carol.address })).toMatchObject({ status: 409, body: { reason: 'HOLDS_DEPOSIT' } });
    const out = await post('/v1/tx/alpha-vault-withdraw', { cross: X, owner: carol.address });
    expect(out.body).toMatchObject({ amount: '1000000000', leavesInEscrow: '0' });
    await land(out, [carol]);
    expect(await w.h.balanceOf(carol.address, w.quoteMint)).toBe(20_000_000_000n);
    const closing = await post('/v1/tx/alpha-vault-close-escrow', { cross: X, owner: carol.address });
    expect(closing.status).toBe(200);
    await land(closing, [carol]);
    expect(w.h.exists(alphaEscrowAddress(vault as never, carol.address))).toBe(false);
    expect((await post('/v1/tx/alpha-vault-close-escrow', { cross: X, owner: carol.address })).body.reason).toBe('NO_ESCROW');
    const part = await post('/v1/tx/alpha-vault-withdraw', { cross: X, owner: bob.address, amount: '500000000' });
    expect(part.body).toMatchObject({ leavesInEscrow: '2500000000' });
    await land(part, [bob]);

    // The fill. Nothing to claim before it; a fill with too much is refused with the room left; the right one lands; a second finds nothing.
    expect((await post('/v1/tx/alpha-vault-claim', { cross: X, owner: alice.address })).body.reason).toBe('NOTHING_BOUGHT');
    expect((await post('/v1/tx/alpha-vault-withdraw-remaining', { cross: X, owner: alice.address })).body.reason).toBe('NOTHING_TO_WITHDRAW');
    w.h.setTime(start - 1800n);
    const cranker = await w.h.wallet();
    expect(await post('/v1/tx/alpha-vault-fill', { cross: X, cranker: cranker.address, maxAmount: String(cap + 1n) })).toMatchObject({ status: 422, body: { reason: 'OVER_FILL', left: String(cap) } });
    const fill = await post('/v1/tx/alpha-vault-fill', { cross: X, cranker: cranker.address });
    expect(fill.body).toMatchObject({ venue: 'damm', maxAmount: String(cap) });
    await land(fill, [cranker]);
    expect((await post('/v1/tx/alpha-vault-fill', { cross: X, cranker: cranker.address })).body.reason).toBe('NOTHING_TO_FILL');
    // The window for changing one's mind is over.
    expect(await post('/v1/tx/alpha-vault-withdraw', { cross: X, owner: bob.address })).toMatchObject({ status: 409, body: { reason: 'WINDOW_CLOSED' } });

    // Claims open at the vesting start; then everyone claims and takes back what did not fit (9 + 2.5 = 11.5 against a cap of 8).
    expect((await post('/v1/tx/alpha-vault-claim', { cross: X, owner: alice.address })).body.reason).toBe('NOT_VESTING_YET');
    w.h.setTime(start + 250n);
    for (const who of [alice, bob]) {
      await land(await post('/v1/tx/alpha-vault-claim', { cross: X, owner: who.address }), [who]);
      await land(await post('/v1/tx/alpha-vault-withdraw-remaining', { cross: X, owner: who.address }), [who]);
    }
    const a = await w.h.balanceOf(alice.address, w.baseMint);
    const b = await w.h.balanceOf(bob.address, w.baseMint);
    expect(Number((a * 1000n) / b) / 1000).toBeCloseTo(9 / 2.5, 1);
    // Spent 8 of 11.5 deposited: Alice 9 of it, Bob 2.5. Each gets back the share that did not fit.
    const spentShare = (dep: bigint) => (dep * cap) / 11_500_000_000n;
    const aliceQuote = await w.h.balanceOf(alice.address, w.quoteMint);
    const bobQuote = await w.h.balanceOf(bob.address, w.quoteMint);
    expect(aliceQuote >= 20_000_000_000n - spentShare(9_000_000_000n) - 2n && aliceQuote <= 20_000_000_000n - spentShare(9_000_000_000n) + 2n).toBe(true);
    expect(bobQuote >= 20_000_000_000n - spentShare(2_500_000_000n) - 2n && bobQuote <= 20_000_000_000n - spentShare(2_500_000_000n) + 2n).toBe(true);
    // Each share is floored, so the vault keeps a single atom of dust at most per depositor.
    expect((await w.h.balanceOf(vault as never, w.quoteMint)) <= 2n).toBe(true);
  });
});

describe.skipIf(!have)('Alpha Vault routes against the real binaries, DAMM v2 pool, first come', () => {
  it('refuses a deposit over the wallet cap or the vault cap with the room left, and a withdrawal from a first-come vault', async () => {
    const w = await World.create();
    const { post, get, land } = await harness(w);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const start = now + 7200n;
    const seed = await buildSeedDammV2({ cross, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 300, alphaVault: true, batch: { windowSecs: 3600, activationPoint: start, endingFeeBps: 30, periods: 10, periodSecs: 60 } });
    await w.h.send([cu, seed.instruction], w.creator);
    const X = cross.address;
    const init = await post('/v1/tx/alpha-vault-init', { cross: X, mode: 'fcfs', maxDepositingCap: '5000000000', individualDepositingCap: '3000000000', startVestingPoint: String(start + 100n), endVestingPoint: String(start + 200n) });
    await land(init, [w.creator]);
    const alice = await w.trader(20_000_000_000n);
    const bob = await w.trader(20_000_000_000n);
    // Over the wallet cap: refused with the room (the program would have charged 3,000,000,000 and said nothing).
    expect(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: alice.address, amount: '3000000001' })).toMatchObject({ status: 422, body: { reason: 'OVER_WALLET_CAP', room: '3000000000' } });
    await land(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: alice.address, amount: '2000000000' }), [alice]);
    // Alice has 2 in; one more than her remaining 1 is over her cap.
    expect(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: alice.address, amount: '1000000001' })).toMatchObject({ status: 422, body: { reason: 'OVER_WALLET_CAP', room: '1000000000', deposited: '2000000000' } });
    await land(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: alice.address, amount: '1000000000' }), [alice]);
    // Bob asks for more than the vault has left: refused with the room.
    expect(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: bob.address, amount: '2000000001' })).toMatchObject({ status: 422, body: { reason: 'OVER_CAP', room: '2000000000' } });
    await land(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: bob.address, amount: '2000000000' }), [bob]);
    expect((await get(`/v1/crosses/${X}/alpha-vault?owner=${bob.address}`)).body).toMatchObject({ mode: 'fcfs', deposited: '2000000000' });
    // Nobody can take a first-come deposit back.
    expect(await post('/v1/tx/alpha-vault-withdraw', { cross: X, owner: bob.address })).toMatchObject({ status: 422, body: { reason: 'FCFS_NO_WITHDRAW' } });
    // The fill spends everything (nothing is over the cap) and both claim in proportion to their deposits, 3 : 2.
    w.h.setTime(start - 1800n);
    const cranker = await w.h.wallet();
    await land(await post('/v1/tx/alpha-vault-fill', { cross: X, cranker: cranker.address }), [cranker]);
    w.h.setTime(start + 250n);
    for (const who of [alice, bob]) await land(await post('/v1/tx/alpha-vault-claim', { cross: X, owner: who.address }), [who]);
    const a = await w.h.balanceOf(alice.address, w.baseMint);
    const b = await w.h.balanceOf(bob.address, w.baseMint);
    expect(Number((a * 1000n) / b) / 1000).toBeCloseTo(1.5, 2);
    expect((await post('/v1/tx/alpha-vault-withdraw-remaining', { cross: X, owner: alice.address })).body.reason).toBe('NOTHING_TO_WITHDRAW');
  });
});

describe.skipIf(!have)('Alpha Vault routes against the real binaries, DLMM pair', () => {
  it('creates the vault on a batch-opened pair, fills it from the ladder through the route, and everyone claims and is refunded', async () => {
    const w = await World.create();
    const { post, get, land } = await harness(w);
    const cross = await clearedCross(w);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 20_000_000_000n);
    const now = w.h.svm.getClock().unixTimestamp;
    const start = now + 7200n;
    const X = cross.address;

    // No pair yet: the DLMM vault is refused.
    expect(await post('/v1/tx/alpha-vault-init', { cross: X, venue: 'dlmm', mode: 'prorata', maxBuyingCap: '1', startVestingPoint: String(start + 100n), endVestingPoint: String(start + 200n) })).toMatchObject({ status: 409, body: { reason: 'NO_POOL' } });
    const open = await buildOpenDlmmPair({ cross, creator: w.creator, binStep: 10, baseFactor: 10_000, batch: { windowSecs: 300, activationPoint: start, alphaVault: true } });
    await w.h.send([cu, open.instruction], w.creator);

    // The vault exists before any liquidity does; a fill with no ladder says so instead of building a transaction DLMM would refuse.
    const cap = 2_000_000_000n;
    const init = await post('/v1/tx/alpha-vault-init', { cross: X, venue: 'dlmm', mode: 'prorata', maxBuyingCap: String(cap), startVestingPoint: String(start + 100n), endVestingPoint: String(start + 200n) });
    expect(init.body).toMatchObject({ venue: 'dlmm', pool: open.addresses.lbPair });
    await land(init, [w.creator]);
    const vault = init.body.vault as string;
    const alice = await w.trader(20_000_000_000n);
    const bob = await w.trader(20_000_000_000n);
    for (const [who, amount] of [[alice, 3_000_000_000n], [bob, 1_000_000_000n]] as const) await land(await post('/v1/tx/alpha-vault-deposit', { cross: X, owner: who.address, amount: String(amount) }), [who]);
    expect((await get(`/v1/crosses/${X}/alpha-vault`)).body).toMatchObject({ vault, venue: 'dlmm', mode: 'prorata' });
    w.h.setTime(start - 1800n);
    const cranker = await w.h.wallet();
    expect(await post('/v1/tx/alpha-vault-fill', { cross: X, cranker: cranker.address })).toMatchObject({ status: 409, body: { reason: 'NO_LIQUIDITY' } });

    // The issuer lays the ladder the vault will buy from (before the start; the clock is moved back to the deposit window for the ladder, as the vault's own window allows).
    w.h.setTime(now);
    const position = await generateKeyPairSigner();
    const ladder = await buildDlmmConvictionLadder({ cross, creator: w.creator, position, activeId: open.activeId, bins: 30, baseAmount: 3_000_000_000n, shape: 'flat' });
    await w.h.send([cu, ...ladder.instructions], w.creator);
    w.h.setTime(start - 1800n);
    const fill = await post('/v1/tx/alpha-vault-fill', { cross: X, cranker: cranker.address });
    expect(fill.body).toMatchObject({ venue: 'dlmm', maxAmount: String(cap) });
    await land(fill, [cranker]);
    const bought = await w.h.balanceOf(vault as never, w.baseMint);
    expect(bought > 0n).toBe(true);
    w.h.setTime(start + 250n);
    for (const who of [alice, bob]) {
      await land(await post('/v1/tx/alpha-vault-claim', { cross: X, owner: who.address }), [who]);
      await land(await post('/v1/tx/alpha-vault-withdraw-remaining', { cross: X, owner: who.address }), [who]);
    }
    const a = await w.h.balanceOf(alice.address, w.baseMint);
    const b = await w.h.balanceOf(bob.address, w.baseMint);
    expect(a + b <= bought && bought - (a + b) < 4n).toBe(true);
    expect(Number((a * 1000n) / b) / 1000).toBeCloseTo(3, 1);
    expect(await w.h.balanceOf(alice.address, w.quoteMint)).toBe(20_000_000_000n - 3_000_000_000n + 1_500_000_000n);
    expect(await w.h.balanceOf(bob.address, w.quoteMint)).toBe(20_000_000_000n - 1_000_000_000n + 500_000_000n);
  });
});
