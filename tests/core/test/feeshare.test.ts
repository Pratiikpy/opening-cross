// Meteora Dynamic Fee Sharing against the real program binary: an issuer opens a vault that splits the quote token among
// stakeholders by share; anyone funds it and each recipient claims exactly its share.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { AccountRole, type Instruction } from '@solana/kit';
import { OrderSide, ata } from '@opening-cross/sdk';
import { DAMM_V2_PROGRAM_ADDRESS, MAX_FEE_SHARE_RECIPIENTS, buildClaimFeeShare, buildCreateFeeShareVault, buildFundFeeShareFromDammFees, buildFundFeeShareVault, buildSeedDammV2, buildTransferDammPositionToFeeVault } from '@opening-cross/adapters';
import { World } from '../src/world.js';
import { DAMM_FIXTURE, DFS_FIXTURE } from '../src/harness.js';

const cu = getSetComputeUnitLimitInstruction({ units: 400_000 });
const T22 = TOKEN_2022_PROGRAM_ADDRESS;

async function setup() {
  const w = await World.create();
  const base = await createKeyPairSignerFromBytes(Keypair.generate().secretKey);
  const issuer = await w.trader(0n, 0n);
  const treasury = await w.trader(0n, 0n);
  const rewards = await w.trader(0n, 0n);
  const funder = await w.trader(0n, 0n);
  for (const u of [issuer, treasury, rewards]) await w.h.ata(u.address, w.quoteMint, w.admin);
  await w.h.fund(w.quoteMint, w.admin, funder.address, 10_000_000_000n);
  const create = buildCreateFeeShareVault({
    payer: w.creator,
    base,
    owner: w.creator.address,
    mint: w.quoteMint,
    tokenProgram: T22,
    recipients: [
      { address: issuer.address, share: 6000 },
      { address: treasury.address, share: 3000 },
      { address: rewards.address, share: 1000 },
    ],
  });
  await w.h.send([cu, create.instruction], w.creator);
  return { w, base, issuer, treasury, rewards, funder };
}

describe.skipIf(!existsSync(DFS_FIXTURE))('Meteora Dynamic Fee Sharing vault', () => {
  it('splits what is funded by share, and recipients claim exactly their part', async () => {
    const { w, base, issuer, treasury, rewards, funder } = await setup();
    await w.h.send([cu, await buildFundFeeShareVault({ funder, base: base.address, mint: w.quoteMint, tokenProgram: T22, maxAmount: 1_000_000_000n })], funder);
    expect(await w.h.balanceOf(funder.address, w.quoteMint)).toBe(9_000_000_000n);
    const claim = async (user: typeof issuer, index: number) => w.h.send([cu, await buildClaimFeeShare({ user, base: base.address, mint: w.quoteMint, tokenProgram: T22, index })], user);
    await claim(issuer, 0);
    await claim(treasury, 1);
    await claim(rewards, 2);
    expect(await w.h.balanceOf(issuer.address, w.quoteMint)).toBe(600_000_000n);
    expect(await w.h.balanceOf(treasury.address, w.quoteMint)).toBe(300_000_000n);
    expect(await w.h.balanceOf(rewards.address, w.quoteMint)).toBe(100_000_000n);
    // A second funding is shared the same way and a recipient can claim again.
    await w.h.send([cu, await buildFundFeeShareVault({ funder, base: base.address, mint: w.quoteMint, tokenProgram: T22, maxAmount: 500_000_000n })], funder);
    await claim(issuer, 0);
    expect(await w.h.balanceOf(issuer.address, w.quoteMint)).toBe(900_000_000n);
  });

  it('refuses a claim by anyone but the recipient at that index, and a bad recipient list', async () => {
    const { w, base, issuer, treasury, funder } = await setup();
    await w.h.send([cu, await buildFundFeeShareVault({ funder, base: base.address, mint: w.quoteMint, tokenProgram: T22, maxAmount: 1_000_000_000n })], funder);
    const mallory = await w.trader(0n, 0n);
    await w.h.ata(mallory.address, w.quoteMint, w.admin);
    const stolen = await buildClaimFeeShare({ user: mallory, base: base.address, mint: w.quoteMint, tokenProgram: T22, index: 0 });
    expect((await w.h.fail([cu, stolen], mallory)).length > 0).toBe(true);
    // Treasury cannot claim issuer's index either.
    const wrongIndex = await buildClaimFeeShare({ user: treasury, base: base.address, mint: w.quoteMint, tokenProgram: T22, index: 0 });
    expect((await w.h.fail([cu, wrongIndex], treasury)).length > 0).toBe(true);
    expect(await w.h.balanceOf(mallory.address, w.quoteMint)).toBe(0n);
    expect(await w.h.balanceOf(issuer.address, w.quoteMint)).toBe(0n);
    const mk = (addrs: string[]) => buildCreateFeeShareVault({ payer: w.creator, base, owner: w.creator.address, mint: w.quoteMint, tokenProgram: T22, recipients: addrs.map((address) => ({ address: address as never, share: 1 })) });
    expect(() => mk([])).toThrow();
    expect(() => mk(Array.from({ length: MAX_FEE_SHARE_RECIPIENTS + 1 }, (_, i) => `${i}`))).toThrow();
    expect(() => mk([issuer.address, issuer.address])).toThrow();
  });
});

describe.skipIf(!existsSync(DFS_FIXTURE) || !existsSync(DAMM_FIXTURE))('DAMM v2 fees routed into a fee-sharing vault', () => {
  it('hands the pool position to the vault, pulls the trading fees into it, and the stakeholders claim their shares', async () => {
    const w = await World.create();
    // A cleared cross and a DAMM v2 pool at P* (quote-only fees).
    const cross = await w.newCross();
    const seller = await w.trader(0n, 5_000_000_000n);
    const buyer = await w.trader(20_000_000_000n);
    const orders = [await w.place(cross, seller, OrderSide.Sell, 1_200_000n, 2_000_000_000n), await w.place(cross, buyer, OrderSide.Buy, 1_300_000n, 2_000_000_000n)];
    const settled = await w.settle(cross);
    await w.claimAll(settled, orders);
    await w.finalize(w.view(cross.address));
    const view = w.view(cross.address);
    await w.h.fund(w.baseMint, w.admin, w.creator.address, 10_000_000_000n);
    const seed = await buildSeedDammV2({ cross: view, creator: w.creator, baseAmount: 5_000_000_000n, quoteAmount: 6_000_000_000n, feeBps: 100 });
    await w.h.send([cu, seed.instruction], w.creator);

    // The vault: the issuer and a treasury share the quote-token fees 50/50.
    const base = await createKeyPairSignerFromBytes(Keypair.generate().secretKey);
    const treasury = await w.trader(0n, 0n);
    await w.h.ata(treasury.address, w.quoteMint, w.admin);
    await w.h.ata(w.creator.address, w.quoteMint, w.admin);
    const create = buildCreateFeeShareVault({ payer: w.creator, base, owner: w.creator.address, mint: w.quoteMint, tokenProgram: T22, recipients: [{ address: w.creator.address, share: 5000 }, { address: treasury.address, share: 5000 }] });
    await w.h.send([cu, create.instruction], w.creator);
    const vault = create.addresses;

    // The position NFT now belongs to the vault, not to the issuer.
    await w.h.send([cu, buildTransferDammPositionToFeeVault({ owner: w.creator, positionNftAccount: seed.addresses.positionNftAccount, feeVault: vault.feeVault })], w.creator);
    const nft = w.h.svm.getAccount(seed.addresses.positionNftAccount);
    if (!nft.exists) throw new Error('nft account missing');
    expect(new PublicKey(Buffer.from(nft.data).subarray(32, 64)).toBase58()).toBe(vault.feeVault);

    // A trader pays fees into the pool (10 base tokens in, quote out; the pool collects its fee in quote).
    const trader = await w.trader(0n, 1_000_000_000n);
    await w.h.ata(trader.address, w.quoteMint, w.admin);
    const swap: Instruction = {
      programAddress: DAMM_V2_PROGRAM_ADDRESS,
      accounts: [
        { address: seed.addresses.poolAuthority, role: AccountRole.READONLY },
        { address: seed.addresses.pool, role: AccountRole.WRITABLE },
        { address: await ata(trader.address, w.baseMint, T22), role: AccountRole.WRITABLE },
        { address: await ata(trader.address, w.quoteMint, T22), role: AccountRole.WRITABLE },
        { address: seed.addresses.tokenAVault, role: AccountRole.WRITABLE },
        { address: seed.addresses.tokenBVault, role: AccountRole.WRITABLE },
        { address: w.baseMint, role: AccountRole.READONLY },
        { address: w.quoteMint, role: AccountRole.READONLY },
        { address: trader.address, role: AccountRole.READONLY_SIGNER, signer: trader } as never,
        { address: T22, role: AccountRole.READONLY },
        { address: T22, role: AccountRole.READONLY },
        { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: seed.addresses.eventAuthority, role: AccountRole.READONLY },
        { address: DAMM_V2_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: (() => {
        const d = Buffer.alloc(24);
        createHash('sha256').update('global:swap').digest().copy(d, 0, 0, 8);
        d.writeBigUInt64LE(1_000_000_000n, 8);
        d.writeBigUInt64LE(0n, 16);
        return new Uint8Array(d);
      })(),
    };
    await w.h.send([cu, swap], trader);

    // Anyone in the vault's recipient list pulls the position's fees into the vault.
    const vaultBefore = (() => {
      const a = w.h.svm.getAccount(vault.tokenVault);
      return a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : 0n;
    })();
    expect(vaultBefore).toBe(0n);
    const fund = buildFundFeeShareFromDammFees({
      signer: w.creator,
      feeVault: vault.feeVault,
      pool: seed.addresses.pool,
      position: seed.addresses.position,
      positionNftAccount: seed.addresses.positionNftAccount,
      tokenAAccount: await ata(w.creator.address, w.baseMint, T22),
      tokenAVault: seed.addresses.tokenAVault,
      tokenBVault: seed.addresses.tokenBVault,
      tokenAMint: w.baseMint,
      tokenBMint: w.quoteMint,
      tokenAProgram: T22,
      tokenBProgram: T22,
      poolAuthority: seed.addresses.poolAuthority,
      dammEventAuthority: seed.addresses.eventAuthority,
    });
    await w.h.send([cu, fund], w.creator);
    const acct = w.h.svm.getAccount(vault.tokenVault);
    if (!acct.exists) throw new Error('token vault missing');
    const funded = Buffer.from(acct.data).readBigUInt64LE(64);
    expect(funded > 0n).toBe(true);

    // Each stakeholder claims half.
    const issuerBefore = await w.h.balanceOf(w.creator.address, w.quoteMint);
    await w.h.send([cu, await buildClaimFeeShare({ user: w.creator, base: base.address, mint: w.quoteMint, tokenProgram: T22, index: 0 })], w.creator);
    await w.h.send([cu, await buildClaimFeeShare({ user: treasury, base: base.address, mint: w.quoteMint, tokenProgram: T22, index: 1 })], treasury);
    const issuerGot = (await w.h.balanceOf(w.creator.address, w.quoteMint)) - issuerBefore;
    const treasuryGot = await w.h.balanceOf(treasury.address, w.quoteMint);
    console.table({ feesPulledIntoVault: Number(funded), issuerClaimed: Number(issuerGot), treasuryClaimed: Number(treasuryGot) });
    expect(issuerGot).toBe(treasuryGot);
    expect(issuerGot + treasuryGot <= funded && funded - (issuerGot + treasuryGot) <= 2n).toBe(true);
  });
});
