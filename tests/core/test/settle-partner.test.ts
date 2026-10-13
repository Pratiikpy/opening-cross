// DBC partner claims through cross_settle (ADR-0480, ADR-0481, HD4), on the real DBC binary: the settler PDA is the pool's
// partner, so a swap's fees are claimable only through the program, and only to the accounts the cross names.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Address } from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { ata } from '@opening-cross/sdk';
import { buildClaimPartnerFee, buildWithdrawPartnerMigrationFee, buildWithdrawPartnerSurplus } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DBC_FIXTURE } from '../src/harness.js';
import { CU, dbcBuy, defaultDesign, launchDbc, readPool } from '../src/settle-world.js';

const T22 = TOKEN_2022_PROGRAM_ADDRESS;

async function trade() {
  const w = await World.create();
  const l = await launchDbc(w);
  await w.h.ata(w.feeRecipient.address, l.baseMint, w.admin);
  const buyer = await w.trader(1_000_000_000n);
  await w.h.send([CU, await dbcBuy(l, buyer, 100_000_000n)], buyer);
  return { w, l, buyer };
}

describe.skipIf(!existsSync(DBC_FIXTURE))('DBC partner claims', () => {
  it('claims the partner trading fee to the fee recipient and leaves nothing in the settler', async () => {
    const { w, l } = await trade();
    const pool = readPool(w, l.addresses.pool);
    const partnerFee = BigInt(pool.partner_quote_fee.toString());
    const creatorFee = BigInt(pool.creator_quote_fee.toString());
    const protocolFee = BigInt(pool.protocol_quote_fee.toString());
    // 1% of 100,000,000 = 1,000,000 in fees, split between protocol, creator (40%) and partner by DBC's own rules.
    expect(partnerFee + creatorFee + protocolFee).toBe(1_000_000n);
    expect(partnerFee > 0n).toBe(true);

    const before = await w.h.balanceOf(w.feeRecipient.address, w.quoteMint);
    const cranker = await w.h.wallet();
    await w.h.send([CU, await buildClaimPartnerFee({ cross: l.cross })], cranker);
    const received = (await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)) - before;
    expect(received).toBe(partnerFee);
    // The settler never holds tokens: the claim paid DBC's account straight into the destination.
    expect(await w.h.balanceOf(l.addresses.settler, w.quoteMint)).toBe(0n);
    expect(BigInt(readPool(w, l.addresses.pool).partner_quote_fee.toString())).toBe(0n);
    // The creator's share is untouched: it is the issuer's to claim directly.
    expect(BigInt(readPool(w, l.addresses.pool).creator_quote_fee.toString())).toBe(creatorFee);
  });

  it('refuses a destination that is not the fee recipient (the cranker cannot redirect the fee)', async () => {
    const { w, l } = await trade();
    const thief = await w.h.wallet();
    const stolen = await w.h.ata(thief.address, w.quoteMint, w.admin);
    const log = await w.h.fail([CU, await buildClaimPartnerFee({ cross: l.cross, quoteDestination: stolen })], thief);
    expect(log).toContain('WrongDestination');
    const baseThief = await w.h.ata(thief.address, l.baseMint, w.admin);
    expect(await w.h.fail([CU, await buildClaimPartnerFee({ cross: l.cross, baseDestination: baseThief })], thief)).toContain('WrongDestination');
    // Nothing moved.
    expect(BigInt(readPool(w, l.addresses.pool).partner_quote_fee.toString()) > 0n).toBe(true);
  });

  it('a second claim pays nothing more, and a claim for a cross with no pool is refused', async () => {
    const { w, l } = await trade();
    const payer = await w.h.wallet();
    await w.h.send([CU, await buildClaimPartnerFee({ cross: l.cross })], payer);
    const after = await w.h.balanceOf(w.feeRecipient.address, w.quoteMint);
    await w.h.send([CU, await buildClaimPartnerFee({ cross: l.cross })], payer);
    expect(await w.h.balanceOf(w.feeRecipient.address, w.quoteMint)).toBe(after);

    // A pool that belongs to another cross cannot be claimed against this cross's config.
    const w2 = await World.create();
    const other = await launchDbc(w2);
    const mixed = await buildClaimPartnerFee({ cross: l.cross });
    const wrongPool = { ...mixed, accounts: mixed.accounts!.map((a) => (a.address === l.addresses.pool ? { ...a, address: other.addresses.pool as Address } : a)) };
    expect(await w.h.fail([CU, wrongPool], payer)).toBeTruthy();
  });

  it('refuses surplus and migration-fee withdrawals before the curve has completed', async () => {
    const { w, l } = await trade();
    const payer = await w.h.wallet();
    const proceeds = await ata(l.cross.data.proceedsTo, w.quoteMint, T22);
    void proceeds;
    // DBC itself refuses: the pool is not complete. The adapter forwards that refusal.
    expect(await w.h.fail([CU, await buildWithdrawPartnerSurplus(l.cross)], payer)).toBeTruthy();
    expect(await w.h.fail([CU, await buildWithdrawPartnerMigrationFee(l.cross)], payer)).toBeTruthy();
    // And a surplus destination that is not the issuer's proceeds account is refused by the adapter before DBC runs.
    const thief = await w.h.wallet();
    const stolen = await w.h.ata(thief.address, w.quoteMint, w.admin);
    expect(await w.h.fail([CU, await buildWithdrawPartnerSurplus(l.cross, stolen)], payer)).toContain('WrongDestination');
    expect(await w.h.fail([CU, await buildWithdrawPartnerMigrationFee(l.cross, stolen)], payer)).toContain('WrongDestination');
    void defaultDesign;
  });
});
