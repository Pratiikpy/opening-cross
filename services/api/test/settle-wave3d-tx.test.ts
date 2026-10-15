// The batch 2 instructions of cross_settle over HTTP (the fixed-price tranche and the MetaDAO DAO), and the governed-graduation gate on every seeding route: the release check
// against fabricated program bytes, the refusals that come before a transaction, and each built transaction decoded back to its instruction. The programs run in
// tests/core (presale-tranche, futarchy, graduate) against the real Meteora, MetaDAO and Squads binaries.
import { describe, expect, it } from 'vitest';
import { type Address, getAddressDecoder, getAddressEncoder } from '@solana/kit';
import {
  CROSS_SETTLE_PROGRAM_ADDRESS,
  OPEN_DBC_POOL_DISCRIMINATOR,
  OPEN_FIXED_PRICE_PRESALE_DISCRIMINATOR,
  SEED_DAMM_V2_DISCRIMINATOR,
  SEED_FUTARCHY_DAO_DISCRIMINATOR,
  SEED_RAYDIUM_CPMM_DISCRIMINATOR,
  OPEN_DLMM_PAIR_DISCRIMINATOR,
  getOpenFixedPricePresaleInstructionDataDecoder,
  getSeedFutarchyDaoInstructionDataDecoder,
} from '@opening-cross/cross-settle-client';
import { getOutcomeEncoder } from '@opening-cross/cross-graduate-client';
import { CROSS_GRADUATE_PROGRAM_ADDRESS, CrossState, FLAG_GOVERNED_GRADUATION, ata, outcomeAddress } from '@opening-cross/sdk';
import { FUTARCHY_PROGRAM_ADDRESS, PRESALE_PROGRAM_ADDRESS, SQUADS_PROGRAM_ADDRESS, encodePresaleArgs, fixedPriceQ64, futarchyAddresses, presaleAddresses, squadsProgramConfigAddress } from '@opening-cross/adapters';
import { registerSettleWave3dTx } from '../src/routes/settle-wave3d-tx.js';
import { registerSettleOpenTx } from '../src/routes/settle-open-tx.js';
import { releaseGate } from '../src/routes/program-gate.js';
import { readCross, requireGraduationApproval } from '../src/routes/programs-support.js';
import { Chain, LOADER, NOW, SPL, T22, caller, decode, elf, key, server, startsWith } from './helpers/wave3d.js';

const dataAddress = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_SETTLE_PROGRAM_ADDRESS);
const TREASURY = '11111111111111111111111111111117' as Address;

/** Puts cross_settle on the chain with the given instructions in its bytes. */
function deploySettle(chain: Chain, discs: Uint8Array[]) {
  const data = dataAddress(240);
  const body = elf([OPEN_DBC_POOL_DISCRIMINATOR as Uint8Array, ...discs]);
  const bytes = new Uint8Array(45 + body.length);
  new DataView(bytes.buffer).setUint32(0, 3, true);
  bytes.set(body, 45);
  const program = new Uint8Array(36);
  new DataView(program.buffer).setUint32(0, 2, true);
  program.set(getAddressEncoder().encode(data), 4);
  chain.put(CROSS_SETTLE_PROGRAM_ADDRESS, LOADER, program);
  chain.put(data, LOADER, bytes);
}
const programAccount = (chain: Chain, program: Address) => chain.put(program, LOADER, new Uint8Array(36));

async function fixture(o: { governed?: boolean; state?: CrossState; tokenProgram?: Address; quoteDecimals?: number; deploy?: Uint8Array[] } = {}) {
  const chain = new Chain();
  const [creator, quote, base, stranger, presaleBase] = await Promise.all([key(), key(), key(), key(), key()]);
  const program = o.tokenProgram ?? SPL;
  chain.mint(quote, { decimals: o.quoteDecimals ?? 6, program });
  chain.mint(base, { decimals: 6, supply: 10_000_000_000n, program });
  deploySettle(chain, o.deploy ?? [OPEN_FIXED_PRICE_PRESALE_DISCRIMINATOR as Uint8Array, SEED_FUTARCHY_DAO_DISCRIMINATOR as Uint8Array, SEED_DAMM_V2_DISCRIMINATOR as Uint8Array, OPEN_DLMM_PAIR_DISCRIMINATOR as Uint8Array, SEED_RAYDIUM_CPMM_DISCRIMINATOR as Uint8Array]);
  programAccount(chain, PRESALE_PROGRAM_ADDRESS);
  programAccount(chain, FUTARCHY_PROGRAM_ADDRESS);
  programAccount(chain, SQUADS_PROGRAM_ADDRESS);
  const config = new Uint8Array(8 + 32 + 8 + 32 + 16);
  config.set(getAddressEncoder().encode(TREASURY) as Uint8Array, 8 + 32 + 8);
  chain.put(squadsProgramConfigAddress(), SQUADS_PROGRAM_ADDRESS, config);
  const cross = await chain.cross({ creator, quoteMint: quote, baseMint: base, state: o.state ?? CrossState.Finalized, baseProgram: program, quoteProgram: program, ...(o.governed ? { ext: { flags: FLAG_GOVERNED_GRADUATION, totalSupply: 1_000_000n } } : {}) });
  await chain.token(creator, base, 5_000_000_000n, program);
  await chain.token(creator, quote, 9_000_000_000n, program);
  const app = server();
  registerSettleWave3dTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW });
  return { chain, creator, quote, base, stranger, presaleBase, cross, app, ...caller(app) };
}

const TERMS = { maxCap: '650000000', minCap: '1000000', start: String(NOW + 600), end: String(NOW + 4_200), supply: '500000000', buyerMinDeposit: '1000', buyerMaxDeposit: '650000000' };

describe('open-fixed-price-presale (B4)', () => {
  it('builds the instruction with q_price = P*, the presale\'s own addresses, and the fresh keypair among the signers', async () => {
    const f = await fixture();
    const r = await f.post('/v1/tx/open-fixed-price-presale', { cross: f.cross, creator: f.creator, base: f.presaleBase, terms: TERMS });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = await presaleAddresses(f.presaleBase, f.base, f.quote);
    expect(r.body).toMatchObject({ cross: f.cross, presale: a.presale, clearingPrice: '1300000', qPrice: fixedPriceQ64(1_300_000n, 1_000_000n).toString(), supply: '500000000', release: { deployed: true } });
    expect(r.body.signers.sort()).toEqual([f.creator, f.presaleBase].sort());
    const ix = programIxs(r.body.transaction)[0]!;
    expect(startsWith(ix, OPEN_FIXED_PRICE_PRESALE_DISCRIMINATOR)).toBe(true);
    const data = getOpenFixedPricePresaleInstructionDataDecoder().decode(ix.data!);
    expect(data.qPrice).toBe(fixedPriceQ64(1_300_000n, 1_000_000n));
    expect(Buffer.from(data.args).toString('hex')).toBe(Buffer.from(encodePresaleArgs({ maxCap: 650_000_000n, minCap: 1_000_000n, start: BigInt(NOW + 600), end: BigInt(NOW + 4_200), supply: 500_000_000n, buyerMinDeposit: 1_000n, buyerMaxDeposit: 650_000_000n })).toString('hex'));
    expect(ix.accounts!.map((x) => x.address)).toEqual(expect.arrayContaining([f.creator, f.cross, f.presaleBase, a.presale, a.presaleVault, a.quoteTokenVault, await ata(f.creator, f.base, SPL)]));
    // compute budget first, as every heavy cross_settle route does
    expect(decode(r.body.transaction)[0]!.programAddress).toBe('ComputeBudget111111111111111111111111111111');
  });

  it('refuses everyone but the creator, a cross that has not printed, a missing base mint, incoherent terms, a short balance and a presale that exists', async () => {
    const f = await fixture();
    const post = (patch: Record<string, unknown> = {}) => f.post('/v1/tx/open-fixed-price-presale', { cross: f.cross, creator: f.creator, base: f.presaleBase, terms: TERMS, ...patch });
    expect((await post({ creator: f.stranger })).body.reason).toBe('NOT_THE_CREATOR');
    expect((await post({ terms: { ...TERMS, supply: '0' } })).body.reason).toBe('NOTHING_TO_DO');
    expect((await post({ terms: { ...TERMS, end: TERMS.start } })).body.reason).toBe('BAD_TERMS');
    expect((await post({ terms: { ...TERMS, supply: '5000000001' } })).body).toMatchObject({ reason: 'INSUFFICIENT_BASE', have: '5000000000' });
    expect((await post({ terms: { ...TERMS, bogus: 1 } })).status).toBe(400);
    expect((await post({ terms: { ...TERMS, maxCap: 'a lot' } })).status).toBe(400);
    expect((await post({ base: 'nope' })).status).toBe(400);
    const a = await presaleAddresses(f.presaleBase, f.base, f.quote);
    f.chain.put(a.presale, PRESALE_PROGRAM_ADDRESS, new Uint8Array(10));
    expect((await post()).body.reason).toBe('PRESALE_EXISTS');
    const live = await fixture({ state: CrossState.Live });
    expect((await live.post('/v1/tx/open-fixed-price-presale', { cross: live.cross, creator: live.creator, base: live.presaleBase, terms: TERMS })).body.reason).toBe('LIVE');
    const noPrint = await fixture({ state: CrossState.NoPrint });
    expect((await noPrint.post('/v1/tx/open-fixed-price-presale', { cross: noPrint.cross, creator: noPrint.creator, base: noPrint.presaleBase, terms: TERMS })).body.reason).toBe('NOT_CLEARED');
    f.chain.del(PRESALE_PROGRAM_ADDRESS);
    f.chain.del(a.presale);
    expect((await post()).body.reason).toBe('EXTERNAL_PROGRAM_MISSING');
  });

  it('refuses with PROGRAM_NOT_DEPLOYED while cross_settle lacks the instruction, and builds when the release cannot be read', async () => {
    const old = await fixture({ deploy: [] });
    const r = await old.post('/v1/tx/open-fixed-price-presale', { cross: old.cross, creator: old.creator, base: old.presaleBase, terms: TERMS });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: 'PROGRAM_NOT_DEPLOYED', instruction: 'open_fixed_price_presale' });
    const s = server();
    registerSettleWave3dTx(s, { account: old.chain.account, lifetime: old.chain.lifetime, gate: async () => 'unknown' });
    const built = await caller(s).post('/v1/tx/open-fixed-price-presale', { cross: old.cross, creator: old.creator, base: old.presaleBase, terms: TERMS });
    expect(built.status).toBe(200);
    expect(built.body.release.deployed).toBeNull();
  });
});

describe('seed-futarchy-dao (X3)', () => {
  const body = (f: Awaited<ReturnType<typeof fixture>>, patch: Record<string, unknown> = {}) => ({ cross: f.cross, creator: f.creator, baseAmount: '1000000000', ...patch });

  it('builds seed_futarchy_dao with the pinned TWAP, the deposit that prices the base at P*, the treasury Squads checks, and the first free nonce', async () => {
    const f = await fixture();
    const r = await f.post('/v1/tx/seed-futarchy-dao', body(f));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = await futarchyAddresses(f.creator, 0n, f.base, f.quote);
    expect(r.body).toMatchObject({ dao: a.dao, nonce: '0', baseAmount: '1000000000', quoteAmount: '1300000000', twapInitialObservation: '1300000000000', release: { deployed: true } });
    expect(r.body.signers).toEqual([f.creator]);
    const ix = programIxs(r.body.transaction)[0]!;
    expect(startsWith(ix, SEED_FUTARCHY_DAO_DISCRIMINATOR)).toBe(true);
    const data = getSeedFutarchyDaoInstructionDataDecoder().decode(ix.data!);
    expect(data).toMatchObject({ baseAmount: 1_000_000_000n, quoteAmount: 1_300_000_000n });
    const first16 = new DataView(data.params.buffer, data.params.byteOffset);
    expect(first16.getBigUint64(0, true) + (first16.getBigUint64(8, true) << 64n)).toBe(1_300_000_000_000n);
    expect(ix.accounts!.map((x) => x.address)).toEqual(expect.arrayContaining([f.creator, f.cross, a.dao, a.squadsMultisig, a.squadsMultisigVault, a.spendingLimit, a.ammBaseVault, a.ammQuoteVault, a.ammPosition, TREASURY, SQUADS_PROGRAM_ADDRESS]));
    f.chain.put(a.dao, FUTARCHY_PROGRAM_ADDRESS, new Uint8Array(10));
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f))).body.nonce).toBe('1');
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { nonce: '0' }))).body.reason).toBe('DAO_EXISTS');
  });

  it('accepts the quote rounded down or up and no other, and refuses what MetaDAO and the adapter refuse', async () => {
    const f = await fixture();
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { baseAmount: '10', quoteAmount: '13' }))).status).toBe(200); // 10 x 1.3 = 13 exactly
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { baseAmount: '1000000000', quoteAmount: '1300000001' }))).body.reason).toBe('START_PRICE_NOT_CLEARING_PRICE');
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { baseAmount: '1000000000', quoteAmount: '1299999999' }))).body).toMatchObject({ reason: 'START_PRICE_NOT_CLEARING_PRICE', quoteAmount: '1300000000' });
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { baseAmount: '0' }))).status).toBe(400);
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { creator: f.stranger }))).body.reason).toBe('NOT_THE_CREATOR');
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { baseAmount: '5000000001' }))).body).toMatchObject({ reason: 'INSUFFICIENT_BASE' });
    await f.chain.token(f.creator, f.quote, 100n);
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f, { baseAmount: '5000000000', quoteAmount: '6500000000' }))).body).toMatchObject({ reason: 'INSUFFICIENT_QUOTE', have: '100' });
    await f.chain.token(f.creator, f.quote, 9_000_000_000n);
    const t22 = await fixture({ tokenProgram: T22 });
    expect((await t22.post('/v1/tx/seed-futarchy-dao', body(t22))).body.reason).toBe('FUTARCHY_NEEDS_LEGACY_TOKENS');
    const nine = await fixture({ quoteDecimals: 9 });
    // the fixture's cross records 6 decimals; MetaDAO checks the quote mint's own: the cross field is what this route can see
    expect((await nine.post('/v1/tx/seed-futarchy-dao', body(nine))).status).toBe(200);
    f.chain.del(SQUADS_PROGRAM_ADDRESS);
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f))).body).toMatchObject({ reason: 'EXTERNAL_PROGRAM_MISSING', name: 'Squads v4' });
    f.chain.del(squadsProgramConfigAddress());
    f.chain.put(SQUADS_PROGRAM_ADDRESS, LOADER, new Uint8Array(36));
    expect((await f.post('/v1/tx/seed-futarchy-dao', body(f))).body.reason).toBe('EXTERNAL_PROGRAM_MISSING');
    const old = await fixture({ deploy: [] });
    expect((await old.post('/v1/tx/seed-futarchy-dao', body(old))).body).toMatchObject({ reason: 'PROGRAM_NOT_DEPLOYED', instruction: 'seed_futarchy_dao' });
  });

  it('needs a passed vote that chose MetaDAO when the cross is governed', async () => {
    const f = await fixture({ governed: true });
    const none_ = await f.post('/v1/tx/seed-futarchy-dao', body(f));
    expect(none_.status).toBe(409);
    expect(none_.body).toMatchObject({ reason: 'GRADUATION_NOT_APPROVED', why: 'NO_OUTCOME', venue: 'metadao_futarchy' });
    const outcome = await outcomeAddress(f.cross);
    f.chain.put(outcome, CROSS_GRADUATE_PROGRAM_ADDRESS, getOutcomeEncoder().encode({ cross: f.cross, venue: 0, round: 0, publishedTs: BigInt(NOW), bump: 1 }) as Uint8Array);
    const wrong = await f.post('/v1/tx/seed-futarchy-dao', body(f));
    expect(wrong.body).toMatchObject({ reason: 'GRADUATION_NOT_APPROVED', why: 'WRONG_VENUE', chosen: 'damm_v2', route: '/v1/tx/seed-damm-v2' });
    f.chain.put(outcome, CROSS_GRADUATE_PROGRAM_ADDRESS, getOutcomeEncoder().encode({ cross: f.cross, venue: 3, round: 0, publishedTs: BigInt(NOW), bump: 1 }) as Uint8Array);
    const ok = await f.post('/v1/tx/seed-futarchy-dao', body(f));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.graduation).toMatchObject({ governed: true, outcome, venue: 'metadao_futarchy' });
    expect(programIxs(ok.body.transaction)[0]!.accounts!.at(-1)!.address).toBe(outcome);
  });
});

describe('the governed-graduation gate on the seeding routes', () => {
  it('refuses seed-damm-v2, open-dlmm-pair and seed-raydium-cpmm of a governed cross without a vote, names the venue the holders chose, and leaves an ungoverned cross alone', async () => {
    const f = await fixture({ governed: true });
    const app = server();
    registerSettleOpenTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: releaseGate({ account: f.chain.account, clock: () => NOW }) });
    const c = caller(app);
    const routes: [string, Record<string, unknown>, string, number][] = [
      ['seed-damm-v2', { baseAmount: '1000000', quoteAmount: '1300000', feeBps: 100 }, 'damm_v2', 0],
      ['open-dlmm-pair', { binStep: 10, baseFactor: 10_000 }, 'dlmm', 1],
      ['seed-raydium-cpmm', { baseAmount: '1000000' }, 'raydium_cpmm', 2],
    ];
    for (const [route, extra, venue] of routes) {
      const r = await c.post(`/v1/tx/${route}`, { cross: f.cross, creator: f.creator, ...extra });
      expect(r.status, route).toBe(409);
      expect(r.body, route).toMatchObject({ reason: 'GRADUATION_NOT_APPROVED', why: 'NO_OUTCOME', venue });
      expect(r.body.error).toMatch(/voted/);
    }
    const outcome = await outcomeAddress(f.cross);
    f.chain.put(outcome, CROSS_GRADUATE_PROGRAM_ADDRESS, getOutcomeEncoder().encode({ cross: f.cross, venue: 1, round: 0, publishedTs: BigInt(NOW), bump: 1 }) as Uint8Array);
    // the vote chose DLMM: the other two venues are refused and say where to go
    const damm = await c.post('/v1/tx/seed-damm-v2', { cross: f.cross, creator: f.creator, baseAmount: '1000000', quoteAmount: '1300000', feeBps: 100 });
    expect(damm.body).toMatchObject({ reason: 'GRADUATION_NOT_APPROVED', why: 'WRONG_VENUE', chosen: 'dlmm', route: '/v1/tx/open-dlmm-pair' });
    const ray = await c.post('/v1/tx/seed-raydium-cpmm', { cross: f.cross, creator: f.creator, baseAmount: '1000000' });
    expect(ray.body.why).toBe('WRONG_VENUE');
    // DLMM gets past the gate (it then stops at the next check this fixture does not satisfy: the DLMM program is not on the chain)
    const dlmm = await c.post('/v1/tx/open-dlmm-pair', { cross: f.cross, creator: f.creator, binStep: 10, baseFactor: 10_000 });
    expect(dlmm.body.reason).not.toBe('GRADUATION_NOT_APPROVED');
    // an outcome copied to another address, owned by another program, or for another cross is not an approval
    const ungoverned = await fixture();
    const u = await c.post('/v1/tx/seed-damm-v2', { cross: ungoverned.cross, creator: ungoverned.creator, baseAmount: '1000000', quoteAmount: '1300000', feeBps: 100 });
    expect(u.body.reason).not.toBe('GRADUATION_NOT_APPROVED');
  });

  it('requireGraduationApproval rejects an outcome that is not the cross\'s: another owner, another cross, a different layout', async () => {
    const f = await fixture({ governed: true });
    const cross = await readCross(f.chain.account, f.cross);
    const outcome = await outcomeAddress(f.cross);
    const good = getOutcomeEncoder().encode({ cross: f.cross, venue: 2, round: 0, publishedTs: BigInt(NOW), bump: 1 }) as Uint8Array;
    f.chain.put(outcome, SPL, good);
    await expect(requireGraduationApproval(f.chain.account, cross, 2)).rejects.toMatchObject({ detail: { reason: 'GRADUATION_NOT_APPROVED', why: 'NO_OUTCOME' } });
    f.chain.put(outcome, CROSS_GRADUATE_PROGRAM_ADDRESS, getOutcomeEncoder().encode({ cross: f.stranger, venue: 2, round: 0, publishedTs: BigInt(NOW), bump: 1 }) as Uint8Array);
    await expect(requireGraduationApproval(f.chain.account, cross, 2)).rejects.toMatchObject({ detail: { why: 'NO_OUTCOME' } });
    f.chain.put(outcome, CROSS_GRADUATE_PROGRAM_ADDRESS, good);
    await expect(requireGraduationApproval(f.chain.account, cross, 2)).resolves.toMatchObject({ governed: true, venue: 'raydium_cpmm' });
    await expect(requireGraduationApproval(f.chain.account, cross, 0)).rejects.toMatchObject({ detail: { why: 'WRONG_VENUE' } });
  });
});
