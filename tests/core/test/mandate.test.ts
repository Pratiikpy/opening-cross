// Auto-invest mandates (S4, J2; ADR-0650): an agent places buy orders inside limits the owner set, the owner can revoke and
// withdraw at any time, and no path sends the owner's funds anywhere but into a cross or back to the owner.
import { describe, expect, it } from 'vitest';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { CrossState, Disclosure, OrderSide, SupplyMode } from '@opening-cross/sdk';
import { getCreateMandateInstruction } from '@opening-cross/cross-mandate-client';
import { RulesWorld } from '../src/rules-world.js';
import { T0 } from '../src/harness.js';
import {
  AllowKind,
  asOrder,
  cancelIx,
  createMandate,
  fundIx,
  limits,
  mandateAddresses,
  placeIx,
  readMandate,
  revealIx,
  revokeIx,
  setLimitsIx,
  sweepIxs,
  withdrawIx,
  withdrawLamportsIx,
} from '../src/mandate-world.js';

const TOKEN = 1_000_000n;
// A launch that sells 1,000 tokens at 1.0 and declares a supply of 1,000 tokens; a 25% order is 250 tokens.
const SUPPLY = 1_000n * TOKEN;
const schedule = [{ price: 1_000_000n, quantity: SUPPLY }];
const launch = (w: RulesWorld, disclosure = Disclosure.Open) => w.newRuledCross({ supplyMode: SupplyMode.Mint, disclosure, schedule, rules: { guards: { totalSupply: SUPPLY } } });

async function setup(over: Parameters<typeof limits>[1] = {}, fund: { quote?: bigint; lamports?: bigint } = { quote: 800n * TOKEN, lamports: 50_000_000n }, disclosure = Disclosure.Open) {
  const w = await RulesWorld.createRules();
  const cross = await launch(w, disclosure);
  const owner = await w.trader(2_000n * TOKEN);
  const agent = await w.h.wallet();
  const m = await createMandate(w, owner, agent, 1n, limits(w, over), fund);
  return { w, cross, owner, agent, m };
}

describe('a mandate end to end', () => {
  it('the agent buys, the cross fills, the base reaches the owner, and every atom is accounted for', async () => {
    const { w, cross, owner, m } = await setup();
    const { ix, placed } = await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 250n * TOKEN);
    await w.h.send([ix], m.agent);
    const mand = readMandate(w, m);
    expect(mand.committed).toBe(375n * TOKEN);
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN - 375n * TOKEN);
    // The order exists, and belongs to the signer PDA, never to the agent.
    expect(w.h.svm.getAccount(placed.order).exists).toBe(true);

    // The same order by an ordinary buyer, to compare the outcome.
    const plain = await w.trader(1_000n * TOKEN);
    const po = await w.place(cross, plain, OrderSide.Buy, 1_500_000n, 250n * TOKEN);

    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    await w.h.send(await w.claimIxs(w.view(cross.address), w.admin, asOrder(m, placed)), w.admin);
    await w.claimAll(settled, [po]);

    // Fill and refund equal an ordinary buyer's.
    const baseMint = settled.data.baseMint;
    const plainBase = await w.h.balanceOf(plain.address, baseMint);
    expect(plainBase).toBe(250n * TOKEN);
    expect(await w.h.balanceOf(m.signer, baseMint)).toBe(plainBase);
    // Quote: 800 - 375 + the 125 refunded (the cross cleared at 1.0).
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN - 250n * TOKEN);

    // Anyone sweeps the base to the owner; the owner then takes the rest of the quote.
    await w.h.send(await sweepIxs(m, baseMint, w.admin), w.admin);
    expect(await w.h.balanceOf(owner.address, baseMint)).toBe(250n * TOKEN);
    expect(await w.h.balanceOf(m.signer, baseMint)).toBe(0n);
    await w.h.send([await withdrawIx(w, m, 550n * TOKEN)], owner);
    expect(w.h.balance(m.vault)).toBe(0n);
    // The owner started with 2,000 quote and paid exactly 250 at the clearing price of 1.0.
    expect(await w.h.balanceOf(owner.address, w.quoteMint)).toBe(2_000n * TOKEN - 250n * TOKEN);
  });

  it('a sealed order is committed by the agent and revealed by the owner; a stranger cannot reveal', async () => {
    const { w, cross, owner, m } = await setup({}, { quote: 800n * TOKEN, lamports: 50_000_000n }, Disclosure.Sealed);
    // Sealed: the share bound is read from the escrow at the cross's lowest price, so the escrow is sized to the order.
    const { ix, placed } = await placeIx(w, w.view(cross.address), m, 0n, 1_000_000n, 200n * TOKEN);
    await w.h.send([ix], m.agent);
    const stranger = await w.h.wallet();
    w.h.setTime(cross.data.closeTs + 1n);
    expect(await w.h.fail([await revealIx(w, w.view(cross.address), m, placed, stranger)], stranger)).toContain('Unauthorized');
    await w.h.send([await revealIx(w, w.view(cross.address), m, placed, owner)], owner);
    const settled = await w.settle(cross);
    expect(settled.data.state).toBe(CrossState.Cleared);
    await w.h.send(await w.claimIxs(w.view(cross.address), w.admin, asOrder(m, placed)), w.admin);
    expect(await w.h.balanceOf(m.signer, settled.data.baseMint)).toBe(200n * TOKEN);
  });

  it('a no-print refunds the order into the vault, not to the agent', async () => {
    const { w, m } = await setup();
    const c2 = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule, minMatched: 900n * TOKEN, rules: { guards: { totalSupply: SUPPLY } } });
    const { ix, placed } = await placeIx(w, w.view(c2.address), m, 0n, 1_500_000n, 100n * TOKEN);
    await w.h.send([ix], m.agent);
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN - 150n * TOKEN);
    const settled = await w.settle(c2);
    expect(settled.data.state).toBe(CrossState.NoPrint);
    await w.h.send(await w.claimIxs(w.view(c2.address), w.admin, asOrder(m, placed)), w.admin);
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN);
  });
});

describe('the limits, each at its edge', () => {
  it('per-order: the limit passes, one atom over fails', async () => {
    const { w, cross, m } = await setup({ maxPerOrder: 150n * TOKEN, totalCap: 800n * TOKEN });
    const ok = await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 100n * TOKEN);
    await w.h.send([ok.ix], m.agent);
    const over = await placeIx(w, w.view(cross.address), m, 1n, 1_500_000n, 100n * TOKEN, { escrow: 150n * TOKEN + 1n });
    expect(await w.h.fail([over.ix], m.agent)).toContain('OverPerOrderLimit');
  });

  it('lifetime cap: counts every order, refunded or not, and only the owner can raise it', async () => {
    const { w, cross, m } = await setup({ maxPerOrder: 400n * TOKEN, totalCap: 600n * TOKEN });
    await w.h.send([(await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 250n * TOKEN)).ix], m.agent);
    expect(await w.h.fail([(await placeIx(w, w.view(cross.address), m, 1n, 1_500_000n, 250n * TOKEN)).ix], m.agent)).toContain('OverTotalCap');
    await w.h.send([setLimitsIx(m, limits(w, { maxPerOrder: 400n * TOKEN, totalCap: 750n * TOKEN }))], m.owner);
    await w.h.send([(await placeIx(w, w.view(cross.address), m, 1n, 1_500_000n, 250n * TOKEN)).ix], m.agent);
    expect(readMandate(w, m).committed).toBe(750n * TOKEN);
  });

  it('share: exactly 25% of the declared supply passes, one atom more fails', async () => {
    const { w, cross, m } = await setup({ maxPerOrder: 500n * TOKEN, totalCap: 800n * TOKEN });
    expect(await w.h.fail([(await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 250n * TOKEN + 1n)).ix], m.agent)).toContain('OverShareLimit');
    await w.h.send([(await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 250n * TOKEN)).ix], m.agent);
  });

  it('share: a sealed order is measured by its escrow at the lowest price, so an oversized escrow is refused', async () => {
    const { w, cross, m } = await setup({ maxPerOrder: 500n * TOKEN, totalCap: 800n * TOKEN }, { quote: 800n * TOKEN, lamports: 50_000_000n }, Disclosure.Sealed);
    const fat = await placeIx(w, w.view(cross.address), m, 0n, 1_000_000n, 100n * TOKEN, { escrow: 250n * TOKEN + 1n });
    expect(await w.h.fail([fat.ix], m.agent)).toContain('OverShareLimit');
    const exact = await placeIx(w, w.view(cross.address), m, 0n, 1_000_000n, 100n * TOKEN, { escrow: 250n * TOKEN });
    await w.h.send([exact.ix], m.agent);
  });

  it('a cross that declares no supply cannot be bought through a mandate', async () => {
    const { w, m } = await setup();
    const bare = await w.newRuledCross({ supplyMode: SupplyMode.Mint, schedule });
    expect(await w.h.fail([(await placeIx(w, w.view(bare.address), m, 0n, 1_500_000n, 10n * TOKEN)).ix], m.agent)).toContain('NoSupplyReference');
  });

  it('expiry: an order at expires_at fails, the owner can still withdraw', async () => {
    const { w, cross, m, owner } = await setup({ expiresAt: T0 + 50n });
    w.h.setTime(T0 + 50n);
    expect(await w.h.fail([(await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 10n * TOKEN)).ix], m.agent)).toContain('Expired');
    await w.h.send([await withdrawIx(w, m, 800n * TOKEN)], owner);
    expect(w.h.balance(m.vault)).toBe(0n);
  });

  it('allow list: creator, cross and base mint rules each admit, anything else is refused', async () => {
    const { w, cross, m, owner } = await setup();
    const stranger = await w.h.wallet();
    const refused = async (kind: AllowKind) => {
      await w.h.send([setLimitsIx(m, limits(w, { allow: [{ kind, key: stranger.address }] }), owner)], owner);
      return w.h.fail([(await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 10n * TOKEN)).ix], m.agent);
    };
    for (const kind of [AllowKind.Creator, AllowKind.Cross, AllowKind.BaseMint]) expect(await refused(kind)).toContain('NotAllowed');
    const accepted = [
      { kind: AllowKind.Cross, key: cross.address },
      { kind: AllowKind.BaseMint, key: w.view(cross.address).data.baseMint },
      { kind: AllowKind.Creator, key: w.creator.address },
    ];
    for (const [i, rule] of accepted.entries()) {
      await w.h.send([setLimitsIx(m, limits(w, { allow: [rule] }), owner)], owner);
      await w.h.send([(await placeIx(w, w.view(cross.address), m, BigInt(i), 1_500_000n, 10n * TOKEN)).ix], m.agent);
    }
  });

  it('a cross quoted in another token is refused', async () => {
    const { w, cross, agent } = await setup();
    const stale = cross;
    await w.freshMints();
    const owner2 = await w.trader(100n * TOKEN);
    const m2 = await createMandate(w, owner2, agent, 7n, limits(w), { quote: 50n * TOKEN, lamports: 50_000_000n });
    expect(await w.h.fail([(await placeIx(w, w.view(stale.address), m2, 0n, 1_500_000n, 10n * TOKEN)).ix], agent)).toContain('WrongQuote');
  });

  it('the vault cannot be overspent and the signer must hold the order rent', async () => {
    const { w, cross, m } = await setup({}, { quote: 100n * TOKEN, lamports: 50_000_000n });
    expect(await w.h.fail([(await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 100n * TOKEN)).ix], m.agent)).toContain('VaultTooLow');
    const noRent = await setup({}, { quote: 800n * TOKEN });
    expect(await noRent.w.h.fail([(await placeIx(noRent.w, noRent.w.view(noRent.cross.address), noRent.m, 0n, 1_500_000n, 10n * TOKEN)).ix], noRent.m.agent)).toContain('NeedRentFunding');
  });
});

describe('who can do what', () => {
  it('only the named agent places orders: not the owner, not a stranger', async () => {
    const { w, cross, m, owner } = await setup();
    const stranger = await w.h.wallet();
    for (const who of [owner, stranger]) {
      const { ix } = await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 10n * TOKEN, { agent: who });
      expect(await w.h.fail([ix], who)).toContain('Unauthorized');
    }
  });

  it('the agent cannot withdraw, change limits, revoke, fund or redirect a sweep', async () => {
    const { w, cross, m, agent } = await setup();
    const agentQuote = await w.h.ata(agent.address, w.quoteMint, agent);
    expect(await w.h.fail([await withdrawIx(w, m, TOKEN, agent, agentQuote)], agent)).toContain('Unauthorized');
    expect(await w.h.fail([setLimitsIx(m, limits(w, { totalCap: 10n ** 15n, maxPerOrder: 10n ** 15n }), agent)], agent)).toContain('Unauthorized');
    expect(await w.h.fail([revokeIx(m, agent)], agent)).toContain('Unauthorized');
    expect(await w.h.fail([await fundIx(w, m, 1n, 0n, agent)], agent)).toContain('Unauthorized');
    expect(await w.h.fail([withdrawLamportsIx(m, 1_000n, agent)], agent)).toContain('Unauthorized');
    // The owner's own withdraw into an account that is not the owner's fails: the destination is bound to the owner.
    expect(await w.h.fail([await withdrawIx(w, m, TOKEN, m.owner, agentQuote)], m.owner)).toContain('ConstraintTokenOwner');
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN);

    // Base tokens in the signer's account can only go to the owner.
    const { ix, placed } = await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 100n * TOKEN);
    await w.h.send([ix], agent);
    const settled = await w.settle(cross);
    await w.h.send(await w.claimIxs(w.view(cross.address), w.admin, asOrder(m, placed)), w.admin);
    const baseMint = settled.data.baseMint;
    const agentBase = await w.h.ata(agent.address, baseMint, agent);
    expect(await w.h.fail(await sweepIxs(m, baseMint, agent, agentBase), agent)).toContain('ConstraintTokenOwner');
    // The quote token never goes through sweep.
    expect(await w.h.fail(await sweepIxs(m, w.quoteMint, agent), agent)).toContain('QuoteStaysInVault');
    expect(await w.h.balanceOf(m.signer, baseMint)).toBe(100n * TOKEN);
  });

  it('the agent cannot point the escrow at its own account or hand in a lookalike cross', async () => {
    const { w, cross, m, agent } = await setup();
    const agentQuote = await w.h.ata(agent.address, w.quoteMint, agent);
    const { ix } = await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 10n * TOKEN);
    const swap = (index: number) => ({ ...ix, accounts: ix.accounts!.map((a, i) => (i === index ? { ...a, address: agentQuote } : a)) });
    // Account order: agent, mandate, signer, quoteMint, vault, protocol, cross, order, shard, pass, escrowVault.
    expect(await w.h.fail([swap(10)], agent)).toContain('WrongVault');
    expect(await w.h.fail([swap(6)], agent)).toContain('NotACross');
  });

  it('create refuses every bad shape of limits and an agent equal to the owner', async () => {
    const w = await RulesWorld.createRules();
    const owner = await w.trader(100n * TOKEN);
    const agent = await w.h.wallet();
    const cases: [string, Parameters<typeof limits>[1]][] = [
      ['share over 25%', { maxShareBps: 2_501 }],
      ['share zero', { maxShareBps: 0 }],
      ['cap below order', { maxPerOrder: 10n, totalCap: 9n }],
      ['order zero', { maxPerOrder: 0n }],
      ['already expired', { expiresAt: T0 }],
      ['empty allow list', { allow: [] }],
      ['nine rules', { allow: Array.from({ length: 9 }, () => ({ kind: AllowKind.Creator, key: w.creator.address })) }],
    ];
    let id = 100n;
    const create = async (agentKey: string, lim: ReturnType<typeof limits>) => {
      const a = await mandateAddresses(owner.address, id, w.quoteMint);
      const ix = getCreateMandateInstruction({ owner, agent: agentKey as never, quoteMint: w.quoteMint, mandate: a.address, signer: a.signer, vault: a.vault, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, id, limits: lim });
      id += 1n;
      return w.h.fail([ix], owner);
    };
    for (const [name, over] of cases) expect(await create(agent.address, limits(w, over)), name).toContain('BadLimits');
    expect(await create(owner.address, limits(w))).toContain('AgentIsOwner');
  });
});

describe('the kill switch', () => {
  it('revoke stops new orders at once; the open order can still be cancelled and the funds withdrawn', async () => {
    const { w, cross, m, owner, agent } = await setup();
    const { ix, placed } = await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 100n * TOKEN);
    await w.h.send([ix], agent);
    await w.h.send([revokeIx(m)], owner);
    expect(readMandate(w, m).revoked).toBe(true);
    expect(await w.h.fail([(await placeIx(w, w.view(cross.address), m, 1n, 1_500_000n, 10n * TOKEN)).ix], agent)).toContain('Revoked');
    expect(await w.h.fail([revokeIx(m)], owner)).toContain('Revoked');
    expect(await w.h.fail([setLimitsIx(m, limits(w))], owner)).toContain('Revoked');
    await w.h.send([await cancelIx(w, w.view(cross.address), m, placed, owner)], owner);
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN);
    await w.h.send([await withdrawIx(w, m, 800n * TOKEN)], owner);
    expect(w.h.balance(m.vault)).toBe(0n);
  });

  it('the agent can cancel too, and the refund lands in the vault; a stranger cannot', async () => {
    const { w, cross, m, agent } = await setup();
    const { ix, placed } = await placeIx(w, w.view(cross.address), m, 0n, 1_500_000n, 100n * TOKEN);
    await w.h.send([ix], agent);
    expect(w.h.balance(m.vault)).toBe(650n * TOKEN);
    const stranger = await w.h.wallet();
    expect(await w.h.fail([await cancelIx(w, w.view(cross.address), m, placed, stranger)], stranger)).toContain('Unauthorized');
    await w.h.send([await cancelIx(w, w.view(cross.address), m, placed, agent)], agent);
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN);
  });

  it('lamports: the owner takes back the order-rent float, never leaving a non-rent-exempt remainder', async () => {
    const { w, m } = await setup();
    const rent0 = w.h.svm.minimumBalanceForRentExemption(0n);
    const held = w.h.svm.getBalance(m.signer) ?? 0n;
    expect(held).toBe(50_000_000n);
    expect(await w.h.fail([withdrawLamportsIx(m, held - rent0 + 1n)], m.owner)).toBeTruthy();
    await w.h.send([withdrawLamportsIx(m, held - rent0)], m.owner);
    await w.h.send([withdrawLamportsIx(m, rent0)], m.owner);
    expect(w.h.svm.getBalance(m.signer) ?? 0n).toBe(0n);
  });

  it('two mandates of one owner are independent', async () => {
    const { w, cross, m, owner, agent } = await setup();
    const m2 = await createMandate(w, owner, agent, 2n, limits(w), { quote: 100n * TOKEN, lamports: 50_000_000n });
    await w.h.send([(await placeIx(w, w.view(cross.address), m2, 0n, 1_500_000n, 50n * TOKEN)).ix], agent);
    expect(w.h.balance(m2.vault)).toBe(25n * TOKEN);
    expect(w.h.balance(m.vault)).toBe(800n * TOKEN);
    expect(readMandate(w, m2).committed).toBe(75n * TOKEN);
    expect(readMandate(w, m).committed).toBe(0n);
  });
});
