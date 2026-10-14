// Baskets (S5, K3; ADR-0652): a share token backed by fixed amounts of several tokens. Deposits round up, redemptions round
// down, and each vault always covers what the outstanding shares are owed.
import { describe, expect, it } from 'vitest';
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction as getInitializeMint2022,
  getInitializePermanentDelegateInstruction,
  getInitializeTransferFeeConfigInstruction,
  getMintSize,
} from '@solana-program/token-2022';
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeMint2Instruction as getInitializeMintLegacy,
  getMintToInstruction as getMintToLegacy,
  getTokenDecoder as getLegacyTokenDecoder,
  getMintDecoder as getLegacyMintDecoder,
  getCreateAssociatedTokenIdempotentInstruction as getCreateLegacyAta,
  findAssociatedTokenPda as findLegacyAta,
} from '@solana-program/token';
import { readonly, withAccounts, writable } from '@opening-cross/sdk';
import { findBasketPda, findShareMintPda, getBasketDecoder, getCreateBasketInstruction, getMintSharesInstruction, getRedeemSharesInstruction } from '@opening-cross/cross-basket-client';
import { World } from '../src/world.js';

type Comp = { mint: Address; program: Address; units: bigint };

async function legacyMint(w: World, decimals = 6): Promise<Address> {
  const mint = await generateKeyPairSigner();
  await w.h.send(
    [
      getCreateAccountInstruction({ payer: w.admin, newAccount: mint, lamports: w.h.svm.minimumBalanceForRentExemption(82n), space: 82, programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeMintLegacy({ mint: mint.address, decimals, mintAuthority: w.admin.address, freezeAuthority: null }),
    ],
    w.admin,
  );
  return mint.address;
}

async function extensionMint(w: World, kind: 'fee' | 'delegate'): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const ext = kind === 'fee' ? ({ __kind: 'TransferFeeConfig', transferFeeConfigAuthority: w.admin.address, withdrawWithheldAuthority: w.admin.address, withheldAmount: 0n, olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 }, newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 } } as const) : ({ __kind: 'PermanentDelegate', delegate: w.admin.address } as const);
  const space = getMintSize([ext as never]);
  const init = kind === 'fee' ? getInitializeTransferFeeConfigInstruction({ mint: mint.address, transferFeeConfigAuthority: w.admin.address, withdrawWithheldAuthority: w.admin.address, transferFeeBasisPoints: 100, maximumFee: 1_000n }) : getInitializePermanentDelegateInstruction({ mint: mint.address, delegate: w.admin.address });
  await w.h.send(
    [
      getCreateAccountInstruction({ payer: w.admin, newAccount: mint, lamports: w.h.svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      init,
      getInitializeMint2022({ mint: mint.address, decimals: 6, mintAuthority: w.admin.address, freezeAuthority: null }),
    ],
    w.admin,
  );
  return mint.address;
}

const ata = async (owner: Address, mint: Address, program: Address) => (program === TOKEN_PROGRAM_ADDRESS ? (await findLegacyAta({ owner, mint, tokenProgram: program }))[0] : (await findAssociatedTokenPda({ owner, mint, tokenProgram: program }))[0]);
const createAta = (payer: KeyPairSigner, owner: Address, mint: Address, program: Address, at: Address): Instruction =>
  program === TOKEN_PROGRAM_ADDRESS ? getCreateLegacyAta({ payer, ata: at, owner, mint, tokenProgram: program }) : getCreateAssociatedTokenIdempotentInstruction({ payer, ata: at, owner, mint, tokenProgram: program });

function amountOf(w: World, account: Address): bigint {
  const a = w.h.svm.getAccount(account);
  return a.exists ? getLegacyTokenDecoder().decode(a.data).amount : 0n;
}
const supplyOf = (w: World, mint: Address) => {
  const a = w.h.svm.getAccount(mint);
  if (!a.exists) throw new Error('mint missing');
  return getLegacyMintDecoder().decode(a.data).supply;
};

async function give(w: World, who: Address, c: Comp, amount: bigint) {
  const at = await ata(who, c.mint, c.program);
  await w.h.send([createAta(w.admin, who, c.mint, c.program, at)], w.admin);
  if (c.program === TOKEN_PROGRAM_ADDRESS) await w.h.send([getMintToLegacy({ mint: c.mint, token: at, mintAuthority: w.admin, amount })], w.admin);
  else await w.h.fund(c.mint, w.admin, who, amount);
}

async function makeBasket(w: World, creator: KeyPairSigner, id: bigint, comps: Comp[], label = 'Cohort 1') {
  const [basket] = await findBasketPda({ creator: creator.address, id });
  const [shareMint] = await findShareMintPda({ basket });
  const vaults = await Promise.all(comps.map((c) => ata(basket, c.mint, c.program)));
  const pre = comps.map((c, i) => createAta(creator, basket, c.mint, c.program, vaults[i]!));
  const create = withAccounts(
    getCreateBasketInstruction({ creator, basket, shareMint, id, label, unitsPerShare: comps.map((c) => c.units) }),
    comps.flatMap((c, i) => [readonly(c.mint), readonly(vaults[i]!)]),
  );
  return { basket, shareMint, vaults, comps, ixs: [...pre, create] };
}
type Basket = Awaited<ReturnType<typeof makeBasket>>;

async function legs(b: Basket, user: Address) {
  const out = [];
  for (const [i, c] of b.comps.entries()) out.push(readonly(c.mint), writable(b.vaults[i]!), writable(await ata(user, c.mint, c.program)));
  return out;
}

async function mintIx(b: Basket, user: KeyPairSigner, shares: bigint) {
  const userShares = await ata(user.address, b.shareMint, TOKEN_PROGRAM_ADDRESS);
  return withAccounts(getMintSharesInstruction({ user, basket: b.basket, shareMint: b.shareMint, userShares, tokenProgram: TOKEN_PROGRAM_ADDRESS, token2022Program: TOKEN_2022_PROGRAM_ADDRESS, shares }), await legs(b, user.address));
}
async function redeemIx(b: Basket, user: KeyPairSigner, shares: bigint) {
  const userShares = await ata(user.address, b.shareMint, TOKEN_PROGRAM_ADDRESS);
  return withAccounts(getRedeemSharesInstruction({ user, basket: b.basket, shareMint: b.shareMint, userShares, tokenProgram: TOKEN_PROGRAM_ADDRESS, token2022Program: TOKEN_2022_PROGRAM_ADDRESS, shares }), await legs(b, user.address));
}
async function shareAccount(w: World, b: Basket, user: KeyPairSigner) {
  const at = await ata(user.address, b.shareMint, TOKEN_PROGRAM_ADDRESS);
  await w.h.send([createAta(user, user.address, b.shareMint, TOKEN_PROGRAM_ADDRESS, at)], user);
  return at;
}

async function setup() {
  const w = await World.create();
  const lg = await legacyMint(w, 6);
  const comps: Comp[] = [
    { mint: w.baseMint, program: TOKEN_2022_PROGRAM_ADDRESS, units: 2_000_000n },
    { mint: w.quoteMint, program: TOKEN_2022_PROGRAM_ADDRESS, units: 500_000n },
    { mint: lg, program: TOKEN_PROGRAM_ADDRESS, units: 7n },
  ];
  const creator = await w.h.wallet();
  const b = await makeBasket(w, creator, 1n, comps);
  await w.h.send(b.ixs, creator);
  const user = await w.h.wallet();
  for (const c of comps) await give(w, user.address, c, 1_000_000_000n);
  const userShares = await shareAccount(w, b, user);
  return { w, b, user, userShares, comps, creator };
}

const solvent = (w: World, b: Basket) => {
  const supply = supplyOf(w, b.shareMint);
  for (const [i, c] of b.comps.entries()) expect(amountOf(w, b.vaults[i]!) * 1_000_000n).toBeGreaterThanOrEqual(c.units * supply);
};

describe('minting and redeeming', () => {
  it('a deposit rounds up, a redemption rounds down, and the vaults always cover the shares', async () => {
    const { w, b, user, userShares } = await setup();
    // 1.5 shares: 3,000,000 + 750,000 + ceil(10.5) = 11.
    await w.h.send([await mintIx(b, user, 1_500_000n)], user);
    expect(amountOf(w, userShares)).toBe(1_500_000n);
    expect(b.vaults.map((v) => amountOf(w, v))).toEqual([3_000_000n, 750_000n, 11n]);
    solvent(w, b);
    const held = await Promise.all(b.comps.map(async (c) => amountOf(w, await ata(user.address, c.mint, c.program))));
    // Redeem it all: 3,000,000 + 750,000 + floor(10.5) = 10. One atom stays behind.
    await w.h.send([await redeemIx(b, user, 1_500_000n)], user);
    expect(supplyOf(w, b.shareMint)).toBe(0n);
    expect(b.vaults.map((v) => amountOf(w, v))).toEqual([0n, 0n, 1n]);
    const after = await Promise.all(b.comps.map(async (c) => amountOf(w, await ata(user.address, c.mint, c.program))));
    expect(after.map((a, i) => a - held[i]!)).toEqual([3_000_000n, 750_000n, 10n]);
    solvent(w, b);
  });

  it('the smallest share atom costs at least one atom of each component and returns what rounds down', async () => {
    const { w, b, user } = await setup();
    await w.h.send([await mintIx(b, user, 1n)], user);
    expect(b.vaults.map((v) => amountOf(w, v))).toEqual([2n, 1n, 1n]);
    await w.h.send([await redeemIx(b, user, 1n)], user);
    expect(b.vaults.map((v) => amountOf(w, v))).toEqual([0n, 1n, 1n]);
    solvent(w, b);
  });

  it('a donation to a vault does not change the price of a share', async () => {
    const { w, b, user } = await setup();
    const donor = await w.h.wallet();
    await give(w, donor.address, b.comps[0]!, 5_000_000n);
    const { getTransferCheckedInstruction } = await import('@solana-program/token-2022');
    await w.h.send([getTransferCheckedInstruction({ source: await ata(donor.address, b.comps[0]!.mint, TOKEN_2022_PROGRAM_ADDRESS), mint: b.comps[0]!.mint, destination: b.vaults[0]!, authority: donor, amount: 5_000_000n, decimals: 6 }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS })], donor);
    await w.h.send([await mintIx(b, user, 1_000_000n)], user);
    expect(amountOf(w, b.vaults[0]!)).toBe(5_000_000n + 2_000_000n);
    solvent(w, b);
  });

  it('is atomic: a user short of one component moves nothing', async () => {
    const { w, b, comps, creator } = await setup();
    const poor = await w.h.wallet();
    for (const [i, c] of comps.entries()) await give(w, poor.address, c, i === 2 ? 0n : 10_000_000n);
    await shareAccount(w, b, poor);
    const before = b.vaults.map((v) => amountOf(w, v));
    expect(await w.h.fail([await mintIx(b, poor, 1_000_000n)], poor)).toBeTruthy();
    expect(b.vaults.map((v) => amountOf(w, v))).toEqual(before);
    expect(supplyOf(w, b.shareMint)).toBe(0n);
    void creator;
  });

  it('no one can mint shares except through the deposit, and a user cannot redeem more than they hold', async () => {
    const { w, b, user, userShares, creator } = await setup();
    const { getMintToInstruction } = await import('@solana-program/token');
    expect(await w.h.fail([getMintToInstruction({ mint: b.shareMint, token: userShares, mintAuthority: creator, amount: 1n })], creator)).toBeTruthy();
    await w.h.send([await mintIx(b, user, 1_000_000n)], user);
    expect(await w.h.fail([await redeemIx(b, user, 1_000_001n)], user)).toBeTruthy();
    expect(supplyOf(w, b.shareMint)).toBe(1_000_000n);
  });

  it('keeps the invariant over a long random run of mints and redemptions by several users', async () => {
    const { w, b, comps } = await setup();
    const users: KeyPairSigner[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await w.h.wallet();
      for (const c of comps) await give(w, u.address, c, 10_000_000_000n);
      await shareAccount(w, b, u);
      users.push(u);
    }
    const paid = new Map<string, bigint[]>();
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const held = (u: KeyPairSigner) => amountOf(w, ata_cache.get(u.address)!);
    const ata_cache = new Map<string, Address>();
    for (const u of users) ata_cache.set(u.address, await ata(u.address, b.shareMint, TOKEN_PROGRAM_ADDRESS));
    for (let step = 0; step < 60; step++) {
      const u = users[Math.floor(rnd() * users.length)]!;
      const have = held(u);
      if (have === 0n || rnd() < 0.55) {
        const shares = BigInt(1 + Math.floor(rnd() * 3_000_000));
        const before = await Promise.all(comps.map(async (c) => amountOf(w, await ata(u.address, c.mint, c.program))));
        await w.h.send([await mintIx(b, u, shares)], u);
        const after = await Promise.all(comps.map(async (c) => amountOf(w, await ata(u.address, c.mint, c.program))));
        const prev = paid.get(u.address) ?? comps.map(() => 0n);
        paid.set(u.address, prev.map((p, i) => p + (before[i]! - after[i]!)));
      } else {
        const shares = 1n + BigInt(Math.floor(rnd() * Number(have)));
        const before = await Promise.all(comps.map(async (c) => amountOf(w, await ata(u.address, c.mint, c.program))));
        await w.h.send([await redeemIx(b, u, shares)], u);
        const after = await Promise.all(comps.map(async (c) => amountOf(w, await ata(u.address, c.mint, c.program))));
        const prev = paid.get(u.address) ?? comps.map(() => 0n);
        paid.set(u.address, prev.map((p, i) => p - (after[i]! - before[i]!)));
      }
      solvent(w, b);
    }
    // Redeem everything: nobody ends up with more of any component than they put in.
    for (const u of users) {
      const have = held(u);
      if (have > 0n) {
        const before = await Promise.all(comps.map(async (c) => amountOf(w, await ata(u.address, c.mint, c.program))));
        await w.h.send([await redeemIx(b, u, have)], u);
        const after = await Promise.all(comps.map(async (c) => amountOf(w, await ata(u.address, c.mint, c.program))));
        const prev = paid.get(u.address)!;
        paid.set(u.address, prev.map((p, i) => p - (after[i]! - before[i]!)));
      }
      for (const net of paid.get(u.address) ?? []) expect(net).toBeGreaterThanOrEqual(0n);
    }
    expect(supplyOf(w, b.shareMint)).toBe(0n);
    solvent(w, b);
  });
});

describe('creating a basket', () => {
  it('records its components and is immutable', async () => {
    const { w, b } = await setup();
    const a = w.h.svm.getAccount(b.basket);
    if (!a.exists) throw new Error('missing');
    const d = getBasketDecoder().decode(a.data);
    expect(d.label).toBe('Cohort 1');
    expect(d.components.map((c) => c.unitsPerShare)).toEqual([2_000_000n, 500_000n, 7n]);
    expect(d.shareMint).toBe(b.shareMint);
  });

  it('refuses every bad shape', async () => {
    const w = await World.create();
    const creator = await w.h.wallet();
    const t22 = (mint: Address, units = 1n): Comp => ({ mint, program: TOKEN_2022_PROGRAM_ADDRESS, units });
    const m1 = t22(w.baseMint);
    const m2 = t22(w.quoteMint);
    let id = 10n;
    const attempt = async (comps: Comp[], label = 'x', tweak?: (ixs: Instruction[]) => Instruction[]) => {
      const b = await makeBasket(w, creator, id++, comps, label);
      return w.h.fail(tweak ? tweak(b.ixs) : b.ixs, creator);
    };
    expect(await attempt([m1, { ...m2, mint: m1.mint }])).toContain('DuplicateComponent');
    expect(await attempt([{ ...m1, units: 0n }])).toContain('BadBasket');
    expect(await attempt([])).toContain('BadBasket');
    expect(await attempt([m1], 'x'.repeat(33))).toContain('BadBasket');
    const mints = [];
    for (let i = 0; i < 9; i++) mints.push(t22(await w.h.mint(w.admin, 6)));
    // Nine components: the vaults are made first, a few per transaction, then the creation is refused.
    const nine = await makeBasket(w, creator, id++, mints);
    for (let i = 0; i < 9; i += 3) await w.h.send(nine.ixs.slice(i, i + 3), creator);
    expect(await w.h.fail([nine.ixs[9]!], creator)).toContain('BadBasket');
    // A vault that is not the basket's account for the token.
    const stranger = await w.h.wallet();
    const strangerVault = await ata(stranger.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS);
    await w.h.send([createAta(w.admin, stranger.address, w.baseMint, TOKEN_2022_PROGRAM_ADDRESS, strangerVault)], w.admin);
    expect(
      await attempt([m1], 'x', (ixs) => {
        const create = ixs[ixs.length - 1]!;
        const accounts = create.accounts!;
        const patched = { ...create, accounts: accounts.map((a, i) => (i === accounts.length - 1 ? { ...a, address: strangerVault } : a)) };
        return [...ixs.slice(0, -1), patched];
      }),
    ).toContain('BadVault');
    // A mint that is not a token mint.
    expect(await attempt([t22(stranger.address)])).toBeTruthy();
  });

  it('refuses tokens that could break the backing: a transfer fee and a permanent delegate', async () => {
    const w = await World.create();
    const creator = await w.h.wallet();
    for (const [i, kind] of (['fee', 'delegate'] as const).entries()) {
      const mint = await extensionMint(w, kind);
      const b = await makeBasket(w, creator, 50n + BigInt(i), [{ mint, program: TOKEN_2022_PROGRAM_ADDRESS, units: 1_000_000n }]);
      expect(await w.h.fail(b.ixs, creator)).toContain('UnsafeExtension');
    }
  });
});

describe('the accounts a caller passes', () => {
  it('a swapped or foreign token account is refused', async () => {
    const { w, b, user, comps } = await setup();
    const other = await w.h.wallet();
    for (const c of comps) await give(w, other.address, c, 100_000_000n);
    const ix = await mintIx(b, user, 1_000_000n);
    // The user's token account for component 0 replaced by another wallet's.
    const otherToken = await ata(other.address, comps[0]!.mint, comps[0]!.program);
    const swapped = { ...ix, accounts: ix.accounts!.map((a, i) => (i === 8 ? { ...a, address: otherToken } : a)) };
    expect(await w.h.fail([swapped], user)).toBeTruthy();
    // A vault replaced by the other wallet's account.
    const vaultSwap = { ...ix, accounts: ix.accounts!.map((a, i) => (i === 7 ? { ...a, address: otherToken } : a)) };
    expect(await w.h.fail([vaultSwap], user)).toContain('BadVault');
    // Too few accounts.
    const short = { ...ix, accounts: ix.accounts!.slice(0, -3) };
    expect(await w.h.fail([short], user)).toContain('BadAccounts');
    expect(supplyOf(w, b.shareMint)).toBe(0n);
  });
});
