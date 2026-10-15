import { describe, expect, it } from 'vitest';
import { MAX_COMPONENTS, UNSAFE_EXTENSIONS, EMPTY_BASKET, buildBasket, lineText, sharesAtoms, unsafeExtension } from '../src/lib/baskets';
import { EMPTY_LOCK, MAX_LOCK_DAYS, MIN_LOCK_DAYS, type LockRow, buildLock, nextStepOf, timeLeft, tokenDays } from '../src/lib/conviction';

const A = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const B = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const C = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const NOW = 1_800_000_000;

describe('conviction: tokenDays', () => {
  it('is amount x seconds / 86,400 / 10^decimals, rounded down, as the program mints it', () => {
    expect(tokenDays(100_000_000n, 90 * 86_400, 6)).toBe(9_000n);
    expect(tokenDays(1_000_000n, 90 * 86_400 + 86_399, 6)).toBe(90n);
    expect(tokenDays(1_000n, 2 * 86_400, 6)).toBe(0n);
    expect(tokenDays(1n, -5, 6)).toBe(0n);
  });
});

describe('conviction: buildLock', () => {
  const f = { mint: A, amount: '100', days: '90' };
  it('locks for the days named, with a minute of margin so a lock is never shorter', () => {
    const b = buildLock(f, B, 6, 500_000_000n, NOW);
    expect(b.body).toEqual({ holder: B, mint: A, amount: '100000000', unlockTs: NOW + 90 * 86_400 + 60 });
    expect(b.days).toBe(9_000n);
  });
  it('holds the program’s bounds: one day to a little under four years', () => {
    expect(MIN_LOCK_DAYS).toBe(1);
    expect(MAX_LOCK_DAYS * 86_400 + 60).toBeLessThanOrEqual(4 * 365 * 86_400);
    expect(buildLock({ ...f, days: '0' }, B, 6, null, NOW).errors.days).toBeDefined();
    expect(buildLock({ ...f, days: String(MAX_LOCK_DAYS + 1) }, B, 6, null, NOW).errors.days).toBeDefined();
    expect(buildLock({ ...f, days: '1' }, B, 6, null, NOW).body).not.toBeNull();
    expect(buildLock({ ...f, days: String(MAX_LOCK_DAYS) }, B, 6, null, NOW).body).not.toBeNull();
  });
  it('refuses more than the wallet holds, in words, and a token that is not an address', () => {
    expect(buildLock({ ...f, amount: '1000' }, B, 6, 500_000_000n, NOW).errors.amount).toMatch(/holds 500/);
    expect(buildLock({ ...EMPTY_LOCK, mint: 'x', amount: '1' }, B, 6, null, NOW).errors.mint).toMatch(/not a Solana address/);
  });
  it('says a lock too small for a badge earns zero token-days', () => {
    expect(buildLock({ mint: A, amount: '0.00001', days: '1' }, B, 6, null, NOW).days).toBe(0n);
  });
});

describe('conviction: what a lock can do next', () => {
  const lock = (o: Partial<LockRow>): LockRow => ({ lock: A, mint: B, amount: '100000000', lockedAt: NOW - 100, unlockTs: NOW + 100, state: 'locked', badgeClaimed: false, tokenDays: null, ...o });
  it('waits while it has not run, and offers nothing', () => {
    expect(nextStepOf(lock({}), 9_000n)).toBe('wait');
  });
  it('offers the tokens and the badge once it has run, and only what is left afterwards', () => {
    expect(nextStepOf(lock({ state: 'unlockable' }), 9_000n)).toBe('unlock-and-claim');
    expect(nextStepOf(lock({ state: 'unlockable' }), 0n)).toBe('unlock');
    expect(nextStepOf(lock({ state: 'unlocked' }), 9_000n)).toBe('claim');
    expect(nextStepOf(lock({ state: 'unlocked', badgeClaimed: true }), 9_000n)).toBe('close');
    expect(nextStepOf(lock({ state: 'unlocked' }), 0n)).toBe('done');
  });
  it('writes the time left', () => {
    expect(timeLeft(NOW + 2 * 86_400 + 3 * 3_600, NOW)).toBe('2d 3h');
    expect(timeLeft(NOW + 5_400, NOW)).toBe('1h 30m');
    expect(timeLeft(NOW - 1, NOW)).toBe('now');
  });
});

describe('baskets: buildBasket', () => {
  const plain = { decimals: 6, extensions: [] as string[] };
  const form = { label: 'duo', components: [{ mint: A, units: '1' }, { mint: B, units: '0.5' }] };
  it('builds components in atoms per whole share', () => {
    expect(buildBasket(form, C, [plain, plain]).body).toEqual({ creator: C, label: 'duo', components: [{ mint: A, unitsPerShare: '1000000' }, { mint: B, unitsPerShare: '500000' }] });
  });
  it('waits for each token to be read before it will convert an amount', () => {
    const b = buildBasket(form, C, [plain, null]);
    expect(b.body).toBeNull();
    expect(b.errors.rows[1]!.units).toMatch(/Enter the token first/);
  });
  it('refuses a token twice and a token with an extension the program refuses, naming it', () => {
    expect(buildBasket({ ...form, components: [{ mint: A, units: '1' }, { mint: A, units: '1' }] }, C, [plain, plain]).errors.rows[1]!.mint).toMatch(/once/);
    expect(buildBasket(form, C, [plain, { decimals: 6, extensions: ['transferFeeConfig'] }]).errors.rows[1]!.mint).toMatch(/has a transfer fee.*refuses it as a component/);
    expect(unsafeExtension(['metadataPointer', 'transferHook'])).toBe('a transfer hook');
    expect(unsafeExtension(['metadataPointer'])).toBeNull();
  });
  it('holds a label of 1 to 32 bytes and one to eight components', () => {
    expect(buildBasket({ ...form, label: '' }, C, [plain, plain]).errors.label).toBeDefined();
    expect(buildBasket({ ...form, label: 'é'.repeat(17) }, C, [plain, plain]).errors.label).toBeDefined();
    expect(buildBasket({ ...form, label: 'é'.repeat(16) }, C, [plain, plain]).body).not.toBeNull();
    expect(MAX_COMPONENTS).toBe(8);
    expect(buildBasket({ ...form, components: [] }, C, []).errors.components).toMatch(/one to 8/);
  });
  it('names the extensions by the names a cluster’s parsed accounts give them', () => {
    expect(Object.keys(UNSAFE_EXTENSIONS)).toEqual(['transferFeeConfig', 'permanentDelegate', 'transferHook', 'pausableConfig', 'confidentialTransferMint', 'defaultAccountState', 'nonTransferable']);
    expect(EMPTY_BASKET.components).toHaveLength(2);
  });
});

describe('baskets: shares and quote lines', () => {
  it('reads shares with six decimals and nothing finer', () => {
    expect(sharesAtoms('1.5')).toBe(1_500_000n);
    expect(sharesAtoms('0.0000001')).toBeNull();
    expect(sharesAtoms('0')).toBeNull();
  });
  it('marks a rounded line', () => {
    expect(lineText({ mint: A, tokenProgram: B, unitsPerShare: '7', amount: '11', exact: false }, 6, 'USDC')).toBe('0.000011 USDC (rounded)');
    expect(lineText({ mint: A, tokenProgram: B, unitsPerShare: '1', amount: '3000000', exact: true }, 6, 'USDC')).toBe('3 USDC');
  });
});
