// A fixed-price tranche at the clearing price (B4; ADR-0663) against the real mainnet Meteora Presale Vault binary: after a cross
// clears, the creator opens a presale whose price is P*, and the adapter refuses any other price.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type KeyPairSigner, type ReadonlyUint8Array, address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { OrderSide } from '@opening-cross/sdk';
import { getOpenFixedPricePresaleInstruction } from '@opening-cross/cross-settle-client';
import { World } from '../src/world.js';
import { T0 } from '../src/harness.js';

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const PRESALE = address('presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj');
const AUTHORITY = address('4Xgt6XKZiowAGNdPWngVAwpYbSwAmbBnRBPtCFXhrypc');
const have = existsSync(`${FIX}presale.so`);
const TOKEN = 1_000_000n;
const cu = getSetComputeUnitLimitInstruction({ units: 1_400_000 });
const enc = getAddressEncoder();
const text = (s: string) => new TextEncoder().encode(s);
const pda = async (seeds: ReadonlyUint8Array[]) => (await getProgramDerivedAddress({ programAddress: PRESALE, seeds }))[0];

/** Borsh of the presale's InitializePresaleArgs for a permissionless fixed-price sale of `supply` base atoms. */
function presaleArgs(o: { maxCap: bigint; minCap: bigint; start: bigint; end: bigint; supply: bigint; mode?: number }): Uint8Array {
  const out = new Uint8Array(32 + 4 + 30 + 2 + 24 + 24 + 32 + 4 + 8 + 8 + 8 + 2 + 32);
  const dv = new DataView(out.buffer);
  let at = 0;
  const u64 = (v: bigint) => { dv.setBigUint64(at, v, true); at += 8; };
  u64(o.maxCap); u64(o.minCap); u64(o.start); u64(o.end);
  out[at++] = 0; // whitelist_mode: permissionless
  out[at++] = o.mode ?? 0; // presale_mode: fixed price
  out[at++] = 0; // unsold_token_action: refund
  out[at++] = 0; // disable_earlier_presale_end_once_cap_reached
  at += 30; // padding
  dv.setUint16(at, 10_000, true); at += 2; // immediately_release_bps
  u64(0n); u64(0n); u64(o.end); // lock_duration, vest_duration, immediate_release_timestamp
  at += 24; // padding
  at += 32; // padding
  dv.setUint32(at, 1, true); at += 4; // one registry
  u64(1_000n); u64(o.maxCap); u64(o.supply); // buyer min, buyer max, supply
  dv.setUint16(at, 0, true); at += 2; // deposit_fee_bps
  return out;
}

async function cleared(w: World) {
  const cross = await w.newCross();
  const seller = await w.trader(0n, 5_000n * TOKEN);
  const buyer = await w.trader(20_000n * TOKEN);
  const orders = [await w.place(cross, seller, OrderSide.Sell, 1_200_000n, 2_000n * TOKEN), await w.place(cross, buyer, OrderSide.Buy, 1_300_000n, 2_000n * TOKEN)];
  const settled = await w.settle(cross);
  await w.claimAll(settled, orders);
  await w.finalize(w.view(cross.address));
  await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000n * TOKEN);
  return w.view(cross.address);
}

async function build(w: World, cross: ReturnType<World['view']>, base: KeyPairSigner, o: { qDelta?: bigint; mode?: number; supply?: bigint; creator?: KeyPairSigner } = {}) {
  const creator = o.creator ?? w.creator;
  const c = cross.data;
  const price = c.clearing.__option === 'Some' ? c.clearing.value.price : 0n;
  const q = (price << 64n) / c.priceScale + (o.qDelta ?? 0n);
  const supply = o.supply ?? 500n * TOKEN;
  const presale = await pda([text('presale'), enc.encode(base.address), enc.encode(c.baseMint), enc.encode(c.quoteMint)]);
  const start = T0 + 600n;
  const ix = getOpenFixedPricePresaleInstruction({
    creator,
    cross: cross.address,
    base,
    presaleMint: c.baseMint,
    quoteTokenMint: c.quoteMint,
    presale,
    fixedPricePresaleParams: await pda([text('fixed_price_param'), enc.encode(presale)]),
    presaleAuthority: AUTHORITY,
    presaleVault: await pda([text('base_vault'), enc.encode(presale)]),
    quoteTokenVault: await pda([text('quote_vault'), enc.encode(presale)]),
    payerPresaleToken: (await findAssociatedTokenPda({ owner: creator.address, mint: c.baseMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0],
    baseTokenProgram: c.baseTokenProgram,
    quoteTokenProgram: c.quoteTokenProgram,
    eventAuthority: await pda([text('__event_authority')]),
    args: presaleArgs({ maxCap: (supply * price) / c.priceScale, minCap: TOKEN, start, end: start + 3_600n, supply, ...(o.mode !== undefined ? { mode: o.mode } : {}) }),
    qPrice: q,
    disableWithdraw: 0,
    hook: new Uint8Array(4), // Borsh of an empty `RemainingAccountsInfo`: no transfer-hook accounts
  });
  return { ix, presale, supply };
}

describe.skipIf(!have)('fixed-price tranche at the clearing price (Meteora Presale Vault)', () => {
  const setup = async () => {
    const w = await World.create(TOKEN_PROGRAM_ADDRESS);
    w.h.svm.addProgramFromFile(PRESALE, `${FIX}presale.so`);
    const cross = await cleared(w);
    return { w, cross };
  };

  it('opens a presale at exactly P* and the program moves the supply into its vault', async () => {
    const { w, cross } = await setup();
    const base = await generateKeyPairSigner();
    const s = await build(w, cross, base);
    const before = await w.h.balanceOf(w.creator.address, w.baseMint);
    await w.h.send([cu, s.ix], w.creator);
    const acct = w.h.svm.getAccount(s.presale);
    expect(acct.exists && acct.programAddress).toBe(PRESALE);
    expect(await w.h.balanceOf(w.creator.address, w.baseMint)).toBe(before - s.supply);
    const vault = await pda([text('base_vault'), enc.encode(s.presale)]);
    expect(w.h.balance(vault)).toBe(s.supply);
  });

  it('refuses a price that is not P* (one unit either way), another presale mode and anyone but the creator', async () => {
    const { w, cross } = await setup();
    for (const qDelta of [-1n, 1n]) {
      const s = await build(w, cross, await generateKeyPairSigner(), { qDelta });
      expect(await w.h.fail([cu, s.ix], w.creator)).toContain('StartPriceNotClearingPrice');
    }
    const prorata = await build(w, cross, await generateKeyPairSigner(), { mode: 1 });
    expect(await w.h.fail([cu, prorata.ix], w.creator)).toContain('PresaleNotFixedPrice');
    const mallory = await w.trader(10_000n * TOKEN, 10_000n * TOKEN);
    const stolen = await build(w, cross, await generateKeyPairSigner(), { creator: mallory });
    expect(await w.h.fail([cu, stolen.ix], mallory)).toContain('NotCreator');
  });
});
