import { describe, expect, it } from 'vitest';
import { checkIssuerForm } from '../src/lib/issuer';
import { PRESETS, applyPreset } from '../src/lib/issuer-presets';
import { type ChainFacts, type MintRead, type ReadinessInput, creationCost, dustBond, evaluateReadiness, ready } from '../src/lib/issuer-readiness';

const WALLET = 'WALLETxxxxxxxx';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const mint = (over: Partial<Extract<MintRead, { ok: true }>> = {}): MintRead => ({ ok: true, program: TOKEN, decimals: 6, mintAuthority: WALLET, freezeAuthority: null, extensions: [], ...over });
// Rent the devnet cluster reported for a real cross: 668-byte cross, 6192-byte book and shards, 165-byte vaults.
const rent = { cross: 4_043_680n, level: 32_105_600n, vault: 1_488_440n };
const now = Date.parse('2026-10-13T12:00:00Z');
const facts = (over: Partial<ChainFacts> = {}): ChainFacts => ({
  base: mint(),
  quote: mint({ mintAuthority: null }),
  lamports: 5_000_000_000n,
  quoteAccount: { exists: true, amount: 100_000_000n },
  rent,
  clock: { chainMs: now, localMs: now },
  ...over,
});
const form = () =>
  checkIssuerForm(
    {
      creator: WALLET,
      baseMint: 'B',
      quoteMint: 'Q',
      baseDecimals: 6,
      quoteDecimals: 6,
      baseTokenProgram: TOKEN,
      quoteTokenProgram: TOKEN,
      disclosure: 'sealed',
      supplyMode: 'mint',
      kind: 'launch',
      minPrice: '1.00',
      tick: '0.05',
      ticks: 40,
      openAt: new Date(now + 3_600_000),
      closeAt: new Date(now + 3 * 3_600_000),
      revealMinutes: 30,
      minMatched: '',
      maxImbalancePct: '',
      integrator: WALLET,
      integratorFeeBps: 0,
      maxOrders: 1000,
      shards: 4,
      proceedsTo: WALLET,
      schedule: [{ price: '1.20', quantity: '1000' }],
      crossId: '1',
    },
    new Date(now),
  );
const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  wallet: WALLET,
  supplyMode: 'mint',
  baseMint: 'B',
  quoteMint: 'Q',
  shards: 4,
  openAt: new Date(now + 3_600_000),
  closeAt: new Date(now + 3 * 3_600_000),
  form: form(),
  ...over,
});
const byId = (c: ReturnType<typeof evaluateReadiness>, id: string) => c.find((x) => x.id === id)!;

describe('readiness checklist', () => {
  it('everything passes for a wallet that holds the mint authority, SOL, quote tokens and has a future window', () => {
    const checks = evaluateReadiness(input(), facts(), now);
    expect(checks.filter((c) => c.status === 'fail' || c.status === 'wait')).toEqual([]);
    expect(ready(checks)).toBe(true);
  });
  it('waits, without failing anything, until both mints are read', () => {
    const checks = evaluateReadiness(input(), null, now);
    expect(checks.every((c) => c.status === 'wait')).toBe(true);
    expect(ready(checks)).toBe(false);
  });
  it('minting mode fails when another wallet holds the mint authority, naming it', () => {
    const c = byId(evaluateReadiness(input(), facts({ base: mint({ mintAuthority: 'OTHERwalletxxx' }) }), now), 'authority');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/OTHE…txxx/);
  });
  it('minting mode fails when the mint has no authority; escrow mode does not need one', () => {
    expect(byId(evaluateReadiness(input(), facts({ base: mint({ mintAuthority: null }) }), now), 'authority').detail).toMatch(/escrow/);
    expect(byId(evaluateReadiness(input({ supplyMode: 'escrow' }), facts({ base: mint({ mintAuthority: null }) }), now), 'authority').status).toBe('pass');
  });
  it('a freeze authority is a warning that does not block', () => {
    const checks = evaluateReadiness(input(), facts({ base: mint({ freezeAuthority: 'FREEZERxxxxxxx' }) }), now);
    expect(byId(checks, 'freeze').status).toBe('warn');
    expect(ready(checks)).toBe(true);
  });
  it('an unreadable mint fails decimals with the reason', () => {
    const c = byId(evaluateReadiness(input(), facts({ quote: { ok: false, reason: 'No account exists at this address.' } }), now), 'decimals');
    expect(c.status).toBe('fail');
    expect(c.detail).toMatch(/No account exists/);
  });
  it('detects the token program; Token-2022 extensions warn; an unknown program fails; the same mint twice fails', () => {
    expect(byId(evaluateReadiness(input(), facts({ base: mint({ program: T22 }) }), now), 'programs').detail).toMatch(/Token-2022/);
    expect(byId(evaluateReadiness(input(), facts({ base: mint({ program: T22, extensions: ['transferFeeConfig'] }) }), now), 'programs').status).toBe('warn');
    expect(byId(evaluateReadiness(input(), facts({ base: mint({ program: 'SomethingElsexxxxx' }) }), now), 'programs').status).toBe('fail');
    expect(byId(evaluateReadiness(input({ baseMint: 'Q' }), facts(), now), 'programs').status).toBe('fail');
  });
  it('states the SOL cost and fails with the shortfall when the wallet is short', () => {
    expect(creationCost(rent, 4, true).rent).toBe(4_043_680n + 5n * 32_105_600n + 2n * 1_488_440n); // 0.1675 SOL, as measured on devnet
    expect(byId(evaluateReadiness(input(), facts(), now), 'rent').status).toBe('pass');
    const short = byId(evaluateReadiness(input(), facts({ lamports: 100_000_000n }), now), 'rent');
    expect(short.status).toBe('fail');
    expect(short.detail).toMatch(/Add 0\.0\d+ SOL more/);
  });
  it('more shards cost more, and a missing quote account adds its rent', () => {
    expect(creationCost(rent, 8, true).total - creationCost(rent, 4, true).total).toBeGreaterThan(4n * 32_105_600n);
    expect(creationCost(rent, 4, false).ata).toBe(1_488_440n);
  });
  it('fails when rent cannot be measured or the balance cannot be read, instead of passing', () => {
    expect(byId(evaluateReadiness(input(), facts({ rent: null }), now), 'rent').status).toBe('fail');
    expect(byId(evaluateReadiness(input(), facts({ lamports: null }), now), 'rent').status).toBe('fail');
  });
  it('the bond is one atom per allowed order at the highest price, rounded up', () => {
    const f = form();
    if (!f.ok) throw new Error('form');
    expect(dustBond(f.body)).toBe(2950n); // 1000 orders x 2.95 (1.00 + 39 x 0.05) quote atoms per whole token, over 10^6
  });
  it('quote account: no account and a bond fails; too little fails; enough passes; unreadable fails', () => {
    expect(byId(evaluateReadiness(input(), facts({ quoteAccount: { exists: false, amount: 0n } }), now), 'quote').status).toBe('fail');
    expect(byId(evaluateReadiness(input(), facts({ quoteAccount: { exists: true, amount: 1n } }), now), 'quote').status).toBe('fail');
    expect(byId(evaluateReadiness(input(), facts(), now), 'quote').status).toBe('pass');
    expect(byId(evaluateReadiness(input(), facts({ quoteAccount: null }), now), 'quote').status).toBe('fail');
  });
  it('the window is judged on the chain clock, not the device clock', () => {
    // The device runs 10 minutes behind the chain: a window opening 5 minutes from the device now is already past on chain.
    const skewed = facts({ clock: { chainMs: now + 600_000, localMs: now } });
    expect(byId(evaluateReadiness(input({ openAt: new Date(now + 300_000), closeAt: new Date(now + 3_600_000) }), skewed, now), 'window').status).toBe('fail');
    expect(byId(evaluateReadiness(input(), facts(), now), 'window').status).toBe('pass');
  });
  it('with no chain clock the window only warns, naming the device clock', () => {
    const c = byId(evaluateReadiness(input(), facts({ clock: null }), now), 'window');
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/this device/);
  });
  it('a window in the past fails, and close before open fails', () => {
    expect(byId(evaluateReadiness(input({ openAt: new Date(now - 600_000) }), facts(), now), 'window').status).toBe('fail');
    expect(byId(evaluateReadiness(input({ closeAt: new Date(now + 1000) }), facts(), now), 'window').status).toBe('fail');
  });
  it('an invalid form names its first problem and blocks', () => {
    const checks = evaluateReadiness(input({ form: { ok: false, errors: { minPrice: 'Enter a price above zero with at most 6 decimal places.' } } }), facts(), now);
    expect(byId(checks, 'form').status).toBe('fail');
    expect(ready(checks)).toBe(false);
  });
});

describe('presets', () => {
  const at = new Date('2026-10-13T12:00:00Z');
  it('fill the format and the window and nothing about price or supply', () => {
    const { fields } = applyPreset(PRESETS[0]!, { minPrice: '1.00', tick: '0.07', quoteDecimals: 6 }, at);
    expect(fields).toMatchObject({ kind: 'launch', disclosure: 'sealed', supplyMode: 'mint', ticks: 40, revealMinutes: 30 });
    expect(fields).not.toHaveProperty('minPrice');
    expect(fields).not.toHaveProperty('schedule');
  });
  it('sets the step to its share of the lowest price when that is exact, otherwise keeps the current step', () => {
    expect(applyPreset(PRESETS[0]!, { minPrice: '1.00', tick: '0.07', quoteDecimals: 6 }, at)).toMatchObject({ fields: { tick: '0.05' }, stepKept: false });
    expect(applyPreset(PRESETS[0]!, { minPrice: '0.000001', tick: '0.07', quoteDecimals: 6 }, at)).toMatchObject({ fields: { tick: '0.07' }, stepKept: true });
    expect(applyPreset(PRESETS[0]!, { minPrice: '1.00', tick: '0.07', quoteDecimals: null }, at).stepKept).toBe(true);
  });
  it('place the window in the future and every preset is a valid shape', () => {
    for (const p of PRESETS) {
      const { fields } = applyPreset(p, { minPrice: '1.00', tick: '0.05', quoteDecimals: 6 }, at);
      expect(Date.parse(`${fields.closeAt}:00Z`)).toBeGreaterThan(Date.parse(`${fields.openAt}:00Z`));
      expect(p.fields.ticks).toBeGreaterThanOrEqual(2);
      expect(p.fields.ticks).toBeLessThanOrEqual(256);
    }
  });
});
