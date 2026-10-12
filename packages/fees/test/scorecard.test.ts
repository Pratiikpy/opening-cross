import { describe, expect, it } from 'vitest';
import { type CrossFlow, FlowRegistry, type FilledOrder, buildScorecard } from '../src/index.js';

const TEAM = 'Team111111111111111111111111111111111111111';
const FUNDED = 'Funded11111111111111111111111111111111111';
const FUNDED2 = 'Funded21111111111111111111111111111111111';
const MM = 'MarketMaker111111111111111111111111111111';
const STRANGER = 'Stranger111111111111111111111111111111111';
const STRANGER2 = 'Stranger211111111111111111111111111111111';
const ISSUER = 'Issuer111111111111111111111111111111111111111';

const WEEK = 604_800;
const reg = () =>
  new FlowRegistry(
    [
      { address: TEAM, class: 'team', source: 'declared', evidence: 'founder wallet' },
      { address: MM, class: 'market_maker', source: 'declared', evidence: 'our own bot' },
    ],
    { [FUNDED]: TEAM, [FUNDED2]: FUNDED },
  );

const cross = (id: string, over: Partial<CrossFlow> = {}): CrossFlow => ({ cross: id, creator: ISSUER, supplyMode: 'escrow', quoteMint: 'Q', protocolBps: 5, integratorBps: 20, protocolFee: 0n, integratorFee: 0n, at: 10 * WEEK, ...over });
const fill = (c: string, owner: string, side: 'buy' | 'sell', notional: bigint, fee: bigint, at = 10 * WEEK): FilledOrder => ({ cross: c, owner, side, notional, fee, at });

describe('wallet classification', () => {
  it('follows funding links up to three hops to a labelled wallet', () => {
    const r = reg();
    expect(r.classify(TEAM).class).toBe('team');
    expect(r.classify(FUNDED).class).toBe('team');
    expect(r.classify(FUNDED2).evidence).toMatch(/funded 2 hops up by/);
    expect(r.classify(STRANGER)).toMatchObject({ class: 'external', source: 'default' });
  });

  it('stops at three hops and survives a funding cycle', () => {
    const r = new FlowRegistry([{ address: 'L', class: 'team', source: 'declared', evidence: 'x' }]);
    r.link('a', 'b'); r.link('b', 'c'); r.link('c', 'd'); r.link('d', 'L');
    expect(r.classify('a').class).toBe('external'); // four hops up
    r.link('c', 'a'); // cycle
    expect(r.classify('a').class).toBe('external');
  });
});

describe('scorecard', () => {
  it('counts only external flow in the headline and keeps the rest apart', () => {
    const crosses = [cross('X')];
    const orders = [
      fill('X', STRANGER, 'sell', 1_000_000_000n, 2_500_000n), // external seller, fee 2.5 USDC (5 protocol + 20 integrator share)
      fill('X', STRANGER2, 'buy', 1_000_000_000n, 0n),
      fill('X', MM, 'sell', 500_000_000n, 1_250_000n), // our market maker
      fill('X', FUNDED, 'buy', 100_000_000n, 0n), // funded by the team
    ];
    const s = buildScorecard(crosses, orders, reg());
    expect(s.external.notional).toBe(2_000_000_000n);
    expect(s.external.protocolFee).toBe(500_000n);
    expect(s.external.integratorFee).toBe(2_000_000n);
    expect(s.external.uniqueWallets).toBe(2);
    expect(s.byClass.market_maker.notional).toBe(500_000_000n);
    expect(s.byClass.team.notional).toBe(100_000_000n);
    expect(s.byClass.market_maker.protocolFee).toBe(250_000n);
  });

  it('charges a mint-mode fee to the issuer class, not to the buyers', () => {
    const crosses = [cross('M', { supplyMode: 'mint', creator: TEAM, protocolFee: 1_200_000n, integratorFee: 4_800_000n })];
    const s = buildScorecard(crosses, [fill('M', STRANGER, 'buy', 2_400_000_000n, 0n)], reg());
    expect(s.byClass.team.protocolFee).toBe(1_200_000n);
    expect(s.external.protocolFee).toBe(0n);
    expect(s.external.notional).toBe(2_400_000_000n); // the external buyer's flow still counts as external volume
  });

  it('reports repeat bidders by weekly cohort and how many external wallets had no funding lookup', () => {
    const crosses = [cross('X'), cross('Y', { at: 12 * WEEK })];
    const orders = [
      fill('X', STRANGER, 'buy', 10n, 0n, 10 * WEEK),
      fill('X', STRANGER2, 'buy', 10n, 0n, 10 * WEEK),
      fill('Y', STRANGER, 'buy', 10n, 0n, 12 * WEEK),
    ];
    const r = reg();
    r.link(STRANGER, 'SomeExchangeHotWallet1111111111111111111111');
    const s = buildScorecard(crosses, orders, r);
    expect(s.external.repeatRate).toEqual({ cohortWallets: 2, returning: 1 });
    expect(s.unchecked).toBe(1); // STRANGER2 was never looked up
  });

  it('is all zeros, not an error, when there is no flow', () => {
    const s = buildScorecard([], [], reg());
    expect(s.external).toMatchObject({ notional: 0n, uniqueWallets: 0 });
    expect(s.crosses).toBe(0);
  });
});
