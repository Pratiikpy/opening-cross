// MetaDAO futarchy adapter (X3; ADR-0657) against the real mainnet `futarchy` v0.6 and Squads v4 binaries: after a cross clears,
// the creator opens a MetaDAO DAO whose spot pool starts at P*, and the adapter refuses every departure from P*.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Address, type ReadonlyUint8Array, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, lamports } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token-2022';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { CrossState, FLAG_GOVERNED_GRADUATION, OrderSide, readonly, withAccounts } from '@opening-cross/sdk';
import { getSeedFutarchyDaoInstruction } from '@opening-cross/cross-settle-client';
import { CROSS_GRADUATE_PROGRAM_ADDRESS, getOutcomeEncoder } from '@opening-cross/cross-graduate-client';
import { World } from '../src/world.js';

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const FUTARCHY = address('FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq');
const SQUADS = address('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
const have = existsSync(`${FIX}futarchy.so`) && existsSync(`${FIX}squads_v4.so`);
const TOKEN = 1_000_000n;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const enc = getAddressEncoder();
const pk = (a: Address) => new PublicKey(a);

function u128(v: bigint): Uint8Array {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setBigUint64(0, v & 0xffff_ffff_ffff_ffffn, true);
  new DataView(b.buffer).setBigUint64(8, v >> 64n, true);
  return b;
}
/** Borsh of MetaDAO's InitializeDaoParams, with the pinned first field. */
function daoParams(twap: bigint, nonce: bigint, team: Address): Uint8Array {
  const out = new Uint8Array(16 + 16 + 4 + 8 + 8 + 8 + 2 + 4 + 8 + 1 + 2 + 32);
  const dv = new DataView(out.buffer);
  out.set(u128(twap), 0);
  out.set(u128(1_000_000_000_000n), 16); // twap_max_observation_change_per_update
  dv.setUint32(32, 0, true); // twap_start_delay_seconds
  dv.setBigUint64(36, 1n, true); // min_quote_futarchic_liquidity
  dv.setBigUint64(44, 1n, true); // min_base_futarchic_liquidity
  dv.setBigUint64(52, 0n, true); // base_to_stake
  dv.setUint16(60, 300, true); // pass_threshold_bps
  dv.setUint32(62, 3 * 86_400, true); // seconds_per_proposal
  dv.setBigUint64(66, nonce, true);
  out[74] = 0; // initial_spending_limit: None
  dv.setInt16(75, -300, true); // team_sponsored_pass_threshold_bps
  out.set(enc.encode(team), 77);
  return out;
}

async function pda(program: Address, seeds: ReadonlyUint8Array[]) {
  return (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
}
const text = (s: string) => new TextEncoder().encode(s);

/** Loads MetaDAO's futarchy and Squads v4 as dumped from mainnet, and Squads' program config. */
function loadMetaDao(w: World) {
  w.h.svm.addProgramFromFile(FUTARCHY, `${FIX}futarchy.so`);
  w.h.svm.addProgramFromFile(SQUADS, `${FIX}squads_v4.so`);
  const cfg = JSON.parse(readFileSync(`${FIX}squads_program_config.json`, 'utf8'));
  const data = new Uint8Array(Buffer.from(cfg.account.data[0], 'base64'));
  w.h.svm.setAccount({ address: address(cfg.pubkey), data, executable: false, lamports: lamports(BigInt(cfg.account.lamports)), programAddress: address(cfg.account.owner), space: BigInt(data.length) });
}

async function legacyWorld() {
  const w = await World.create(TOKEN_PROGRAM_ADDRESS);
  loadMetaDao(w);
  return w;
}

async function cleared(w: World) {
  const cross = await w.newCross();
  const seller = await w.trader(0n, 5_000n * TOKEN);
  const buyer = await w.trader(20_000n * TOKEN);
  const orders = [await w.place(cross, seller, OrderSide.Sell, 1_200_000n, 2_000n * TOKEN), await w.place(cross, buyer, OrderSide.Buy, 1_300_000n, 2_000n * TOKEN)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  const view = w.view(cross.address);
  await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000n * TOKEN);
  return view;
}

async function buildSeed(w: World, cross: Awaited<ReturnType<typeof cleared>>, opts: { nonce?: bigint; twapDelta?: bigint; baseAmount?: bigint; quoteAmount?: bigint; creator?: Awaited<ReturnType<World['trader']>> } = {}) {
  const creator = opts.creator ?? w.creator;
  const c = cross.data;
  const price = c.clearing.__option === 'Some' ? c.clearing.value.price : 0n;
  const twap = (price * 1_000_000_000_000n) / c.priceScale + (opts.twapDelta ?? 0n);
  const nonce = opts.nonce ?? 1n;
  const baseAmount = opts.baseAmount ?? 1_000n * TOKEN;
  const quoteAmount = opts.quoteAmount ?? (baseAmount * price + c.priceScale - 1n) / c.priceScale;
  const dao = await pda(FUTARCHY, [text('dao'), enc.encode(creator.address), (() => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, nonce, true); return b; })()]);
  const squadsMultisig = address(multisig.getMultisigPda({ createKey: pk(dao) })[0].toBase58());
  const squadsMultisigVault = address(multisig.getVaultPda({ multisigPda: pk(squadsMultisig), index: 0 })[0].toBase58());
  const spendingLimit = address(multisig.getSpendingLimitPda({ multisigPda: pk(squadsMultisig), createKey: pk(dao) })[0].toBase58());
  const programConfig = address(multisig.getProgramConfigPda({})[0].toBase58());
  // Squads checks the treasury against its program config: authority (32), creation fee (8), then the treasury.
  const cfgData = w.h.svm.getAccount(programConfig);
  if (!cfgData.exists) throw new Error('squads program config missing');
  const treasury = getAddressDecoder().decode(cfgData.data.slice(8 + 32 + 8, 8 + 32 + 8 + 32));
  const ammBaseVault = (await findAssociatedTokenPda({ owner: dao, mint: c.baseMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const ammQuoteVault = (await findAssociatedTokenPda({ owner: dao, mint: c.quoteMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const ix = getSeedFutarchyDaoInstruction({
    creator,
    cross: cross.address,
    dao,
    baseMint: c.baseMint,
    quoteMint: c.quoteMint,
    squadsMultisig,
    squadsMultisigVault,
    squadsProgram: SQUADS,
    squadsProgramConfig: programConfig,
    squadsProgramConfigTreasury: treasury,
    spendingLimit,
    ammBaseVault,
    ammQuoteVault,
    creatorBase: (await findAssociatedTokenPda({ owner: creator.address, mint: c.baseMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
    creatorQuote: (await findAssociatedTokenPda({ owner: creator.address, mint: c.quoteMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
    ammPosition: await pda(FUTARCHY, [text('amm_position'), enc.encode(dao), enc.encode(creator.address)]),
    eventAuthority: await pda(FUTARCHY, [text('__event_authority')]),
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    params: daoParams(twap, nonce, creator.address),
    baseAmount,
    quoteAmount,
  });
  return { ix, dao, ammBaseVault, ammQuoteVault, price, baseAmount, quoteAmount, twap };
}

describe.skipIf(!have)('MetaDAO futarchy adapter', () => {
  it('opens a DAO whose pool starts at exactly the creator\'s deposits at P*', async () => {
    const w = await legacyWorld();
    const cross = await cleared(w);
    expect(cross.data.state).toBe(CrossState.Finalized);
    const s = await buildSeed(w, cross);
    await w.h.send([cu, s.ix], w.creator);
    const dao = w.h.svm.getAccount(s.dao);
    expect(dao.exists && dao.programAddress).toBe(FUTARCHY);
    expect(w.h.balance(s.ammBaseVault)).toBe(s.baseAmount);
    expect(w.h.balance(s.ammQuoteVault)).toBe(s.quoteAmount);
    // MetaDAO's own price of the pool: quote_reserves * 1e12 / base_reserves, within one quote atom of P*.
    const poolPrice = (s.quoteAmount * 1_000_000_000_000n) / s.baseAmount;
    expect(poolPrice >= s.twap && poolPrice <= s.twap + 1_000_000_000_000n / s.baseAmount + 1n).toBe(true);
  });

  it('refuses a starting price or deposits that are not P*, and anyone but the creator', async () => {
    const w = await legacyWorld();
    const cross = await cleared(w);
    for (const delta of [-1n, 1n]) {
      const s = await buildSeed(w, cross, { twapDelta: delta });
      expect(await w.h.fail([cu, s.ix], w.creator)).toContain('StartPriceNotClearingPrice');
    }
    const price = (await buildSeed(w, cross)).price;
    const cheap = await buildSeed(w, cross, { quoteAmount: (1_000n * TOKEN * price) / cross.data.priceScale - 2n });
    expect(await w.h.fail([cu, cheap.ix], w.creator)).toContain('StartPriceNotClearingPrice');
    const dear = await buildSeed(w, cross, { quoteAmount: (1_000n * TOKEN * price) / cross.data.priceScale + 2n });
    expect(await w.h.fail([cu, dear.ix], w.creator)).toContain('StartPriceNotClearingPrice');
    const mallory = await w.trader(10_000n * TOKEN, 10_000n * TOKEN);
    const stolen = await buildSeed(w, cross, { creator: mallory });
    expect(await w.h.fail([cu, stolen.ix], mallory)).toContain('NotCreator');
  });

  it('refuses a cross made of Token-2022 tokens before MetaDAO can fail on them', async () => {
    const w = await World.create();
    loadMetaDao(w);
    const cross = await cleared(w);
    const s = await buildSeed(w, cross);
    expect(await w.h.fail([cu, s.ix], w.creator)).toContain('FutarchyNeedsLegacyTokens');
  });
});

describe.skipIf(!have)('MetaDAO futarchy adapter on a governed cross', () => {
  it('opens the DAO only with an outcome that names MetaDAO', async () => {
    const lw = await legacyWorld();
    // The rules builders of the test worlds make Token-2022 crosses, so the gate is exercised on a legacy cross whose rules tail is
    // written by hand: the flag is what `cross_settle` reads (the governed vote itself is `graduate.test.ts`).
    const cross = await cleared(lw);
    const raw = lw.h.svm.getAccount(cross.address);
    if (!raw.exists) throw new Error('missing');
    const data = new Uint8Array(raw.data);
    // The tail: version 1, rules_set true, created_slot (8), flags (2).
    data[668] = 1;
    data[669] = 1;
    new DataView(data.buffer).setUint16(668 + 10, FLAG_GOVERNED_GRADUATION, true);
    lw.h.svm.setAccount({ address: cross.address, data, executable: false, lamports: raw.lamports, programAddress: raw.programAddress, space: BigInt(data.length) });
    const s = await buildSeed(lw, lw.view(cross.address));
    expect(await lw.h.fail([cu, s.ix], lw.creator)).toContain('GraduationNotApproved');
    const outcome = await pda(CROSS_GRADUATE_PROGRAM_ADDRESS, [text('outcome'), enc.encode(cross.address)]);
    const put = (venue: number) => {
      const bytes = new Uint8Array(getOutcomeEncoder().encode({ cross: cross.address, venue, round: 0, publishedTs: 0n, bump: 255 }));
      lw.h.svm.setAccount({ address: outcome, data: bytes, executable: false, lamports: raw.lamports, programAddress: CROSS_GRADUATE_PROGRAM_ADDRESS, space: BigInt(bytes.length) });
    };
    put(0); // DAMM v2 won the vote: MetaDAO is refused
    expect(await lw.h.fail([cu, withAccounts(s.ix, [readonly(outcome)])], lw.creator)).toContain('GraduationNotApproved');
    put(3); // MetaDAO won
    await lw.h.send([cu, withAccounts(s.ix, [readonly(outcome)])], lw.creator);
    expect(lw.h.svm.getAccount(s.dao).exists).toBe(true);
  });
});
