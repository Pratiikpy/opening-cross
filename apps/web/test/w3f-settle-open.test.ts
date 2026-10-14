import { describe, expect, it } from 'vitest';
import { EMPTY_ALPHA, EMPTY_DAMM, EMPTY_DBC, EMPTY_DLMM, EMPTY_METLOCK, EMPTY_RAYDIUM, LOCKED_DESIGN_TEMPLATE, buildAlphaInit, buildDamm, buildDbc, buildDlmm, buildFeeShare, buildMetLock, buildRaydium } from '../src/lib/settle-open';

const X = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const Y = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const Z = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const NOW = 1_800_000_000;
const dec = { base: 6, quote: 6 };
/** A datetime-local value for the instant, in the machine's own time zone, as the browser's input gives it. */
const at = (secs: number) => {
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

describe('the DBC continuation', () => {
  it('starts from the locked design the tests run against the real binaries, and sends it as the person left it', () => {
    const b = buildDbc({ ...EMPTY_DBC, name: 'Opening Token', symbol: 'OPEN', uri: 'https://example.invalid/o.json' }, X, Y);
    expect(b.errors).toEqual({});
    expect(b.body).toEqual({ cross: X, creator: Y, design: LOCKED_DESIGN_TEMPLATE, name: 'Opening Token', symbol: 'OPEN', uri: 'https://example.invalid/o.json', locked: true });
  });
  it('names a design that is not JSON and the three text fields that are empty or too long', () => {
    const b = buildDbc({ design: '{ nope', name: '', symbol: 'TOOLONGSYMBOL', uri: 'x'.repeat(201), locked: true }, X, Y);
    expect(Object.keys(b.errors).sort()).toEqual(['design', 'name', 'symbol', 'uri']);
    expect(b.body).toBeNull();
    expect(buildDbc({ ...EMPTY_DBC, design: '[]', name: 'a', symbol: 'a', uri: 'a' }, X, Y).errors.design).toMatch(/not valid JSON/);
  });
  it('can ask for the unlocked opening, and builds nothing without a wallet', () => {
    expect(buildDbc({ ...EMPTY_DBC, name: 'a', symbol: 'a', uri: 'a', locked: false }, X, Y).body?.locked).toBe(false);
    expect(buildDbc({ ...EMPTY_DBC, name: 'a', symbol: 'a', uri: 'a' }, X, null).body).toBeNull();
  });
});

describe('a DAMM v2 pool', () => {
  const plain = { ...EMPTY_DAMM, baseAmount: '1000', quoteAmount: '1500' };
  it('builds the plain pool in atoms', () => {
    expect(buildDamm(plain, X, Y, dec, NOW).body).toEqual({ cross: X, creator: Y, baseAmount: '1000000000', quoteAmount: '1500000000', feeBps: 100 });
  });
  it('builds a batched pool with an Alpha Vault and all of its liquidity locked', () => {
    const f = { ...plain, batch: true, startAt: at(NOW + 7200), windowMins: '60', endingFeePct: '0.25', periods: '10', periodMins: '10', alphaVault: true, lockAll: true };
    const b = buildDamm(f, X, Y, dec, NOW);
    expect(b.errors).toEqual({});
    expect(b.body).toMatchObject({ batch: { windowSecs: 3600, activationPoint: String(Math.floor(new Date(f.startAt).getTime() / 1000)), endingFeeBps: 25, periods: 10, periodSecs: 600 }, alphaVault: true, lock: { permanentLiquidity: 'all' } });
  });
  it('refuses a start that is closer than the window plus the time to land, and says the earliest', () => {
    const b = buildDamm({ ...plain, batch: true, startAt: at(NOW + 3600), windowMins: '60' }, X, Y, dec, NOW);
    expect(b.errors.startAt).toMatch(/at least the window \(60 minutes\).*earliest now is/);
    expect(b.body).toBeNull();
  });
  it('refuses a fee that does not decay, a window outside the program’s range, and an Alpha Vault with no start', () => {
    expect(buildDamm({ ...plain, batch: true, startAt: at(NOW + 7200), endingFeePct: '1' }, X, Y, dec, NOW).errors.endingFeePct).toMatch(/must be lower/);
    expect(buildDamm({ ...plain, batch: true, startAt: at(NOW + 9e6), windowMins: '20000' }, X, Y, dec, NOW).errors.windowMins).toMatch(/at most 7 days/);
    expect(buildDamm({ ...plain, alphaVault: true }, X, Y, dec, NOW).errors.alphaVault).toMatch(/needs a start/);
  });
  it('reads amounts exactly', () => {
    expect(buildDamm({ ...plain, baseAmount: '1.0000001' }, X, Y, dec, NOW).errors.baseAmount).toMatch(/6 decimal places/);
    expect(buildDamm({ ...plain, quoteAmount: '0' }, X, Y, dec, NOW).errors.quoteAmount).toMatch(/above zero/);
    expect(buildDamm(plain, X, Y, { base: null, quote: 6 }, NOW).errors.baseAmount).toMatch(/could not be read/);
    expect(buildDamm({ ...plain, feePct: '101' }, X, Y, dec, NOW).errors.feePct).toMatch(/0.01% to 100%/);
  });
});

describe('a DLMM pair', () => {
  const plain = { ...EMPTY_DLMM, binStep: '25', baseFactor: '10000' };
  it('builds the plain pair, the batched pair and the badged pair', () => {
    expect(buildDlmm(plain, X, Y, NOW).body).toEqual({ cross: X, creator: Y, binStep: 25, baseFactor: 10000 });
    expect(buildDlmm({ ...plain, batch: true, startAt: at(NOW + 7200), windowMins: '30', alphaVault: true }, X, Y, NOW).body).toMatchObject({ batch: { windowSecs: 1800, alphaVault: true } });
    expect(buildDlmm({ ...plain, badgeBase: true, badgeQuote: true }, X, Y, NOW).body).toMatchObject({ badges: { base: true, quote: true } });
    expect(buildDlmm({ ...plain, badgeQuote: true }, X, Y, NOW).body).toMatchObject({ badges: { quote: true } });
  });
  it('names a bin step that is not a number and an Alpha Vault with no start', () => {
    const b = buildDlmm({ ...EMPTY_DLMM, baseFactor: '1', alphaVault: true }, X, Y, NOW);
    expect(Object.keys(b.errors).sort()).toEqual(['alphaVault', 'binStep']);
  });
});

describe('a Raydium CPMM pool', () => {
  it('derives nothing the page does not know: only the base amount, a fee tier and a time', () => {
    expect(buildRaydium({ baseAmount: '500', ammConfigIndex: '', openAt: '' }, X, Y, dec).body).toEqual({ cross: X, creator: Y, baseAmount: '500000000' });
    expect(buildRaydium({ baseAmount: '500', ammConfigIndex: '2', openAt: at(NOW) }, X, Y, dec).body).toMatchObject({ ammConfigIndex: 2, openTime: String(Math.floor(new Date(at(NOW)).getTime() / 1000)) });
    expect(buildRaydium({ baseAmount: '', ammConfigIndex: 'x', openAt: '' }, X, Y, dec).errors).toMatchObject({ baseAmount: expect.any(String), ammConfigIndex: expect.any(String) });
  });
});

describe('an Alpha Vault', () => {
  const f = { ...EMPTY_ALPHA, buyingCap: '10000', vestStart: at(NOW + 86400), vestEnd: at(NOW + 8 * 86400) };
  it('builds a pro-rata vault with its cap in quote atoms', () => {
    expect(buildAlphaInit(f, X, Y, 6).body).toMatchObject({ cross: X, funder: Y, mode: 'prorata', maxBuyingCap: '10000000000' });
  });
  it('builds a first-come vault with both caps, and refuses a vault whose vesting ends before it starts', () => {
    const b = buildAlphaInit({ ...f, mode: 'fcfs', depositCap: '5000', perWalletCap: '50' }, X, Y, 6);
    expect(b.body).toMatchObject({ mode: 'fcfs', maxDepositingCap: '5000000000', individualDepositingCap: '50000000' });
    expect(b.body).not.toHaveProperty('maxBuyingCap');
    expect(buildAlphaInit({ ...f, vestEnd: f.vestStart }, X, Y, 6).errors.vestEnd).toMatch(/end after it starts/);
    expect(buildAlphaInit({ ...EMPTY_ALPHA }, X, Y, 6).errors).toMatchObject({ buyingCap: expect.any(String), vestStart: expect.any(String), vestEnd: expect.any(String) });
  });
});

describe('a Met Lock escrow', () => {
  const f = { ...EMPTY_METLOCK, mint: X, recipient: Y, total: '1200', startAt: at(NOW) };
  it('turns days into seconds and a percentage into basis points', () => {
    expect(buildMetLock({ ...f, cliffDays: '90', cliffUnlockPct: '10' }, Z, Y, 6).body).toEqual({ sender: Z, base: Y, mint: X, recipient: Y, schedule: { total: '1200000000', start: String(Math.floor(new Date(f.startAt).getTime() / 1000)), cliffSeconds: 7_776_000, frequency: 2_592_000, periods: 4, cliffUnlockBps: 1000 } });
  });
  it('names every field it cannot read', () => {
    const b = buildMetLock({ ...EMPTY_METLOCK, mint: 'x', recipient: 'y', total: '0', periods: '0', periodDays: '0', cliffUnlockPct: '101' }, Z, Y, 6);
    expect(Object.keys(b.errors).sort()).toEqual(['cliffUnlockPct', 'mint', 'periodDays', 'periods', 'recipient', 'startAt', 'total']);
  });
});

describe('a fee-sharing vault', () => {
  it('shows what each recipient gets before anything is built', () => {
    const r = buildFeeShare([{ address: X, share: '3' }, { address: Y, share: '1' }], Z, Y, X);
    expect(r.percents).toEqual([75, 25]);
    expect(r.body).toEqual({ payer: Z, base: Y, cross: X, recipients: [{ address: X, share: 3 }, { address: Y, share: 1 }] });
  });
  it('refuses six recipients, a repeat, a weight that is not a whole number, and a wrong address', () => {
    expect(buildFeeShare(Array.from({ length: 6 }, () => ({ address: X, share: '1' })), Z, Y, X).error).toMatch(/at most 5/);
    expect(buildFeeShare([{ address: X, share: '1' }, { address: X, share: '1' }], Z, Y, X).error).toMatch(/listed once/);
    expect(buildFeeShare([{ address: X, share: '1.5' }], Z, Y, X).error).toMatch(/whole number above zero/);
    expect(buildFeeShare([{ address: 'q', share: '1' }], Z, Y, X).error).toMatch(/not a Solana address/);
    expect(buildFeeShare([{ address: '', share: '' }], Z, Y, X).body).toBeNull();
  });
});
