// Bounty (X10; ADR-0654): a committed pool that pays when a cross account breaks an invariant, and by an arbiter for the rest.
// The invariants are proved not to fire on honest crosses (randomized runs through every stage) and to fire on exactly the
// state each one names (accounts rewritten in LiteSVM, owned by cross_core as the real ones are).
import { describe, expect, it } from 'vitest';
import { TOKEN_2022_PROGRAM_ADDRESS, findAssociatedTokenPda } from '@solana-program/token-2022';
import type { Address, KeyPairSigner } from '@solana/kit';
import {
  CrossState,
  Disclosure,
  NoPrintReason,
  OrderSide,
  SupplyMode,
  costCeil,
  getCrossDecoder,
  getCrossEncoder,
} from '@opening-cross/sdk';
import {
  findBountyPda,
  getAwardInstruction,
  getBountyDecoder,
  getClaimInvariantInstruction,
  getCreateBountyInstruction,
  getFundInstruction,
  getWithdrawInstruction,
} from '@opening-cross/cross-bounty-client';
import { SCALE, World, type PlacedOrder } from '../src/world.js';
import { T0 } from '../src/harness.js';

const TOKEN = 1_000_000n;
const DAY = 86_400n;
const INVARIANTS = 11;
const ata = async (owner: Address, mint: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }))[0];

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x % n;
  };
}

async function setup(rewards: bigint[] = Array.from({ length: INVARIANTS }, (_, i) => BigInt(i + 1) * 10n * TOKEN), expiresAt = T0 + 40n * DAY) {
  const w = await World.create();
  const sponsor = await w.trader(10_000n * TOKEN);
  const arbiter = await w.h.wallet();
  const hunter = await w.trader(0n);
  await w.h.ata(hunter.address, w.quoteMint, w.admin);
  const [bounty] = await findBountyPda({ sponsor: sponsor.address, id: 1n });
  const vault = await ata(bounty, w.quoteMint);
  await w.h.send([getCreateBountyInstruction({ sponsor, rewardMint: w.quoteMint, bounty, vault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, id: 1n, arbiter: arbiter.address, expiresAt, rewards })], sponsor);
  const fundFrom = async (who: KeyPairSigner, amount: bigint) =>
    getFundInstruction({ funder: who, bounty, rewardMint: w.quoteMint, funderToken: await ata(who.address, w.quoteMint), vault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount });
  await w.h.send([await fundFrom(sponsor, 1_000n * TOKEN)], sponsor);
  const hunterToken = await ata(hunter.address, w.quoteMint);
  const claimIx = async (invariant: number, cross: Address, who: KeyPairSigner = hunter) =>
    getClaimInvariantInstruction({ claimant: who, bounty, rewardMint: w.quoteMint, cross, vault, claimantToken: await ata(who.address, w.quoteMint), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, invariant });
  const read = () => getBountyDecoder().decode((w.h.svm.getAccount(bounty) as { data: Uint8Array }).data);
  return { w, sponsor, arbiter, hunter, hunterToken, bounty, vault, fundFrom, claimIx, read };
}

/** Rewrites fields of a cross account, keeping its owner, its lamports and its extension tail. */
function rewrite(w: World, cross: Address, patch: (c: ReturnType<ReturnType<typeof getCrossDecoder>['decode']>) => void) {
  const acct = w.h.svm.getAccount(cross);
  if (!acct.exists) throw new Error('cross missing');
  const decoded = getCrossDecoder().decode(acct.data);
  patch(decoded);
  // The account is the struct in Borsh, padded with zeros to its allocated size, then the extension tail.
  const encoded = getCrossEncoder().encode(decoded as never);
  const body = 668;
  expect(encoded.length).toBeLessThanOrEqual(body);
  const data = new Uint8Array(acct.data);
  data.fill(0, 0, body);
  data.set(encoded, 0);
  w.h.svm.setAccount({ address: cross, data, executable: false, lamports: acct.lamports, programAddress: acct.programAddress, space: BigInt(data.length) });
}

async function probeAll(s: Awaited<ReturnType<typeof setup>>, cross: Address, label: string) {
  for (let i = 0; i < INVARIANTS; i++) {
    const logs = await s.w.h.fail([await s.claimIx(i, cross)], s.hunter).catch(() => {
      throw new Error(`${label}: invariant ${i} fired on an honest cross`);
    });
    expect(logs, `${label}: invariant ${i}`).toContain('NoViolation');
  }
}

describe('honest crosses break no invariant, at any stage', () => {
  const RUNS = Number(process.env.BOUNTY_RUNS ?? 12);
  for (let run = 0; run < RUNS; run++) {
    it(`run ${run}: live, cleared, partly claimed, claimed and finalized`, async () => {
      const r = rng(0x51ed270b ^ (run * 104729));
      const s = await setup();
      const w = s.w;
      const mint = r(3) === 0;
      const sealed = r(2) === 0;
      const ticks = 5 + r(12);
      const minPrice = 1_000_000n;
      const tick = 50_000n;
      const schedule = [{ price: minPrice, quantity: BigInt(1 + r(5_000)) * 1_000_000n }];
      const cross = await w.newCross({
        supplyMode: mint ? SupplyMode.Mint : SupplyMode.Escrow,
        disclosure: sealed ? Disclosure.Sealed : Disclosure.Open,
        ticks,
        tick,
        minPrice,
        shards: 1 + r(4),
        integratorFeeBps: r(40),
        reference: r(2) ? minPrice + BigInt(r(ticks)) * tick : null,
        ...(mint ? { schedule } : {}),
      });
      await probeAll(s, cross.address, `run ${run} empty`);
      const orders: PlacedOrder[] = [];
      const n = 1 + r(16);
      for (let i = 0; i < n; i++) {
        const side = mint || r(2) ? OrderSide.Buy : OrderSide.Sell;
        const price = minPrice + BigInt(r(ticks)) * tick;
        const quantity = BigInt(1 + r(4_000)) * 1_000n + BigInt(r(1_000));
        const t = side === OrderSide.Buy ? await w.trader(costCeil(quantity, price, SCALE) * 3n) : await w.trader(0n, quantity * 2n);
        orders.push(await w.place(cross, t, side, price, quantity, { reveal: r(10) !== 0 }));
      }
      await probeAll(s, cross.address, `run ${run} live`);
      if (sealed) await w.revealAll(cross, orders);
      else w.h.setTime(cross.data.closeTs + 1n);
      const settled = await w.settle(cross);
      await probeAll(s, cross.address, `run ${run} ${settled.data.state === CrossState.Cleared ? 'cleared' : 'no-print'}`);
      const half = orders.slice(0, Math.ceil(orders.length / 2));
      await w.claimAll(settled, half);
      await probeAll(s, cross.address, `run ${run} partly claimed`);
      await w.claimAll(w.view(cross.address), orders.slice(half.length));
      await probeAll(s, cross.address, `run ${run} claimed`);
      await w.finalize(w.view(cross.address));
      await probeAll(s, cross.address, `run ${run} finalized`);
      // Nothing was paid out for any of it.
      expect(s.read().paidMask).toBe(0);
      expect(w.h.balance(s.vault)).toBe(1_000n * TOKEN);
    }, 180_000);
  }
});

describe('each invariant pays on exactly the state it names, once', () => {
  const cases: [number, string, (w: World, c: any) => void][] = [
    [0, 'more orders open than placed', (_w, c) => { c.ordersOpen = c.ordersTotal + 1; }],
    [1, 'cleared with no summary', (_w, c) => { c.state = CrossState.Cleared; c.clearing = { __option: 'None' }; }],
    [2, 'no-print with no reason', (_w, c) => { c.state = CrossState.NoPrint; c.noPrintReason = { __option: 'None' }; }],
    [3, 'finalized with an order open', (_w, c) => { c.state = CrossState.Finalized; c.ordersOpen = 1; }],
    [4, 'clearing price off the grid', (_w, c) => { c.state = CrossState.Cleared; c.clearing = { __option: 'Some', value: { price: c.minPrice + 1n, matched: 0n, demand: 0n, supply: 0n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } }; }],
    [5, 'fee above the cap', (_w, c) => { c.protocolFeeBps = 101; }],
    [6, 'matched above the book', (_w, c) => { c.state = CrossState.Cleared; c.clearing = { __option: 'Some', value: { price: c.minPrice, matched: 10n, demand: 5n, supply: 50n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } }; }],
    [7, 'sellers paid more than buyers and the undelivered base can explain', (_w, c) => { c.state = CrossState.Cleared; c.ordersOpen = 0; c.buyerPaid = 9n; c.sellerPaid = 10n; c.baseSold = 0n; c.baseBought = 0n; c.clearing = { __option: 'Some', value: { price: c.minPrice, matched: 1n, demand: 1n, supply: 1n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } }; }],
    [8, 'a no-print reason on a live cross', (_w, c) => { c.noPrintReason = { __option: 'Some', value: NoPrintReason.NoCross }; }],
    [9, 'buyers took more base than sellers delivered', (_w, c) => { c.state = CrossState.Finalized; c.ordersOpen = 0; c.baseSold = 4n; c.baseBought = 5n; }],
    [10, 'buyers took more base than the clear matched', (_w, c) => { c.state = CrossState.Cleared; c.ordersOpen = 0; c.baseBought = 5n; c.clearing = { __option: 'Some', value: { price: c.minPrice, matched: 4n, demand: 4n, supply: 4n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 } }; }],
  ];
  for (const [id, name, patch] of cases) {
    it(`${id}: ${name}`, async () => {
      const s = await setup();
      const cross = await s.w.newCross({ supplyMode: SupplyMode.Escrow });
      rewrite(s.w, cross.address, (c) => patch(s.w, c));
      const reward = (BigInt(id) + 1n) * 10n * TOKEN;
      await s.w.h.send([await s.claimIx(id, cross.address)], s.hunter);
      expect(await s.w.h.balanceOf(s.hunter.address, s.w.quoteMint)).toBe(reward);
      expect(s.read().paidMask & (1 << id)).toBe(1 << id);
      // Each invariant pays once: the same break on another cross pays nothing more.
      const other = await s.w.newCross({ supplyMode: SupplyMode.Escrow });
      rewrite(s.w, other.address, (c) => patch(s.w, c));
      expect(await s.w.h.fail([await s.claimIx(id, other.address)], s.hunter)).toContain('AlreadyPaid');
    });
  }

  it('an invariant the bounty does not cover, an unknown one and a lookalike account all pay nothing', async () => {
    const rewards = Array.from({ length: INVARIANTS }, (_, i) => (i === 0 ? 5n * TOKEN : 0n));
    const s = await setup(rewards);
    const cross = await s.w.newCross();
    rewrite(s.w, cross.address, (c) => { c.protocolFeeBps = 101; });
    expect(await s.w.h.fail([await s.claimIx(5, cross.address)], s.hunter)).toContain('NotCovered');
    expect(await s.w.h.fail([await s.claimIx(11, cross.address)], s.hunter)).toContain('UnknownInvariant');
    // An account that is not a cross: the bounty's own account, and a copy of a cross owned by another program.
    expect(await s.w.h.fail([await s.claimIx(0, s.bounty)], s.hunter)).toContain('NotACross');
    const real = s.w.h.svm.getAccount(cross.address);
    if (!real.exists) throw new Error('missing');
    const forged = (await s.w.h.wallet()).address;
    rewrite(s.w, cross.address, (c) => { c.ordersOpen = c.ordersTotal + 1; });
    const broken = s.w.h.svm.getAccount(cross.address);
    if (!broken.exists) throw new Error('missing');
    s.w.h.svm.setAccount({ address: forged, data: new Uint8Array(broken.data), executable: false, lamports: broken.lamports, programAddress: TOKEN_2022_PROGRAM_ADDRESS, space: BigInt(broken.data.length) });
    expect(await s.w.h.fail([await s.claimIx(0, forged)], s.hunter)).toContain('NotACross');
    expect(s.w.h.balance(s.vault)).toBe(1_000n * TOKEN);
  });

  it('the pool pays what it holds when it holds less than the reward', async () => {
    const s = await setup(Array.from({ length: INVARIANTS }, () => 5_000n * TOKEN));
    const cross = await s.w.newCross();
    rewrite(s.w, cross.address, (c) => { c.protocolFeeBps = 101; });
    await s.w.h.send([await s.claimIx(5, cross.address)], s.hunter);
    expect(await s.w.h.balanceOf(s.hunter.address, s.w.quoteMint)).toBe(1_000n * TOKEN);
    expect(s.w.h.balance(s.vault)).toBe(0n);
    const again = await s.w.newCross();
    rewrite(s.w, again.address, (c) => { c.ordersOpen = c.ordersTotal + 1; });
    expect(await s.w.h.fail([await s.claimIx(0, again.address)], s.hunter)).toContain('PoolEmpty');
  });
});

describe('the committed pool', () => {
  it('requires at least thirty days of commitment', async () => {
    const w = await World.create();
    const sponsor = await w.trader(10n * TOKEN);
    const [bounty] = await findBountyPda({ sponsor: sponsor.address, id: 9n });
    const vault = await ata(bounty, w.quoteMint);
    const ix = (expiresAt: bigint) => getCreateBountyInstruction({ sponsor, rewardMint: w.quoteMint, bounty, vault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, id: 9n, arbiter: sponsor.address, expiresAt, rewards: Array.from({ length: INVARIANTS }, () => 1n) });
    expect(await w.h.fail([ix(T0 + 30n * DAY - 1n)], sponsor)).toContain('CommitmentTooShort');
    await w.h.send([ix(T0 + 30n * DAY)], sponsor);
  });

  it('the sponsor cannot take the pool back before the expiry, and can after it; nobody else can ever', async () => {
    const s = await setup();
    const cross = await s.w.newCross();
    const back = async (who: KeyPairSigner, amount: bigint) =>
      getWithdrawInstruction({ sponsor: who, bounty: s.bounty, rewardMint: s.w.quoteMint, vault: s.vault, sponsorToken: await ata(who.address, s.w.quoteMint), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount });
    expect(await s.w.h.fail([await back(s.sponsor, 1n)], s.sponsor)).toContain('StillCommitted');
    s.w.h.setTime(T0 + 40n * DAY - 1n);
    expect(await s.w.h.fail([await back(s.sponsor, 1n)], s.sponsor)).toContain('StillCommitted');
    s.w.h.setTime(T0 + 40n * DAY);
    expect(await s.w.h.fail([await back(s.hunter, 1n)], s.hunter)).toContain('Unauthorized');
    const before = await s.w.h.balanceOf(s.sponsor.address, s.w.quoteMint);
    await s.w.h.send([await back(s.sponsor, 1_000n * TOKEN)], s.sponsor);
    expect(await s.w.h.balanceOf(s.sponsor.address, s.w.quoteMint)).toBe(before + 1_000n * TOKEN);
    // After the expiry nothing pays out any more.
    rewrite(s.w, cross.address, (c) => { c.protocolFeeBps = 101; });
    expect(await s.w.h.fail([await s.claimIx(5, cross.address)], s.hunter)).toContain('Expired');
  });

  it('only the arbiter awards, only before the expiry, and the award is recorded', async () => {
    const s = await setup();
    const award = (who: KeyPairSigner, amount: bigint) =>
      getAwardInstruction({ arbiter: who, bounty: s.bounty, rewardMint: s.w.quoteMint, vault: s.vault, hunterToken: s.hunterToken, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, amount, evidence: new Uint8Array(32).fill(7) });
    expect(await s.w.h.fail([award(s.sponsor, 1n)], s.sponsor)).toContain('Unauthorized');
    expect(await s.w.h.fail([award(s.hunter, 1n)], s.hunter)).toContain('Unauthorized');
    await s.w.h.send([award(s.arbiter, 250n * TOKEN)], s.arbiter);
    expect(await s.w.h.balanceOf(s.hunter.address, s.w.quoteMint)).toBe(250n * TOKEN);
    expect(s.read().awarded).toBe(250n * TOKEN);
    expect(await s.w.h.fail([award(s.arbiter, 751n * TOKEN)], s.arbiter)).toBeTruthy(); // more than the pool holds
    s.w.h.setTime(T0 + 40n * DAY);
    expect(await s.w.h.fail([award(s.arbiter, 1n)], s.arbiter)).toContain('Expired');
  });

  it('anyone can add to the pool', async () => {
    const s = await setup();
    const donor = await s.w.trader(50n * TOKEN);
    await s.w.h.send([await s.fundFrom(donor, 50n * TOKEN)], donor);
    expect(s.w.h.balance(s.vault)).toBe(1_050n * TOKEN);
  });
});
