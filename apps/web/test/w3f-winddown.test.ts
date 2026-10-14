import { describe, expect, it } from 'vitest';
import { type WindDetail, type WindExt, entitlement, windDownView } from '../src/lib/winddown';

const DAY = 86_400;
const NOW = 1_800_000_000;
const R = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';

const detail = (o: Partial<WindDetail> = {}): WindDetail => ({ state: 'Active', lapse: { lapsedSince: null, graceEndsAt: null }, snapshot: null, balances: { vault: '10000000000' }, history: null, ...o });
const extended = (live: { start: string; sweepOpensAt: string; swept: boolean } | null, window: { windowSecs: string; recovery: string } | null = { windowSecs: String(180 * DAY), recovery: R }): WindExt => ({ extended: true, terms: { windDown: window }, live: { windDown: live } });
const liquidating = (o: Partial<WindDetail> = {}) => detail({ state: 'Liquidating', lapse: { lapsedSince: String(NOW - 230 * DAY), graceEndsAt: String(NOW - 200 * DAY) }, snapshot: { vault: '10000000000', supply: '1000000000' }, ...o });

describe('windDownView', () => {
  it('an active treasury is not winding down, and says what would start it', () => {
    const v = windDownView(detail(), extended(null), NOW);
    expect(v.phase).toBe('active');
    expect(v.headline).toMatch(/Nothing is winding down/);
    expect(v.steps.map((s) => [s.id, s.state])).toEqual([['lapse', 'next'], ['liquidation', 'next'], ['redemption', 'next'], ['sweep', 'next']]);
    expect(v.holder).toEqual([]);
    expect(v.countdown).toBeNull();
  });
  it('a lapse with the grace period running counts down to the earliest liquidation', () => {
    const v = windDownView(detail({ lapse: { lapsedSince: String(NOW - DAY), graceEndsAt: String(NOW + 6 * DAY) } }), extended(null), NOW);
    expect(v.phase).toBe('lapsing');
    expect(v.countdown).toEqual({ label: 'until the liquidation can be triggered', secs: 6 * DAY });
    expect(v.steps[0]).toMatchObject({ id: 'lapse', state: 'done' });
    expect(v.steps[1]).toMatchObject({ id: 'liquidation', state: 'next' });
  });
  it('once the grace period is over anyone can trigger the liquidation', () => {
    const v = windDownView(detail({ lapse: { lapsedSince: String(NOW - 10 * DAY), graceEndsAt: String(NOW - 3 * DAY) } }), extended(null), NOW);
    expect(v.phase).toBe('lapsing');
    expect(v.headline).toMatch(/Anyone can trigger the liquidation/);
    expect(v.steps[1]).toMatchObject({ state: 'now' });
  });
  it('inside the window holders redeem, nothing can be swept, and the end is counted down', () => {
    const v = windDownView(liquidating(), extended({ start: String(NOW - 20 * DAY), sweepOpensAt: String(NOW + 160 * DAY), swept: false }), NOW);
    expect(v.phase).toBe('redeeming');
    expect(v.countdown).toEqual({ label: 'until the redemption window ends', secs: 160 * DAY });
    expect(v.steps.find((s) => s.id === 'redemption')).toMatchObject({ state: 'now', title: 'Holders redeem for at least 180 days' });
    expect(v.steps.find((s) => s.id === 'sweep')).toMatchObject({ state: 'next' });
    expect(v.holder[0]).toMatch(/Redeem your coins/);
    expect(v.holder.join(' ')).toMatch(/before the window ends/);
  });
  it('after the window the remainder can be swept, and redemption still works until someone does', () => {
    const v = windDownView(liquidating(), extended({ start: String(NOW - 200 * DAY), sweepOpensAt: String(NOW - 20 * DAY), swept: false }), NOW);
    expect(v.phase).toBe('sweepable');
    expect(v.steps.find((s) => s.id === 'sweep')).toMatchObject({ state: 'now' });
    expect(v.holder.join(' ')).toMatch(/redemption still works/);
  });
  it('after the sweep redemption is closed and nobody is told otherwise', () => {
    const v = windDownView(liquidating(), extended({ start: String(NOW - 200 * DAY), sweepOpensAt: String(NOW - 20 * DAY), swept: true }), NOW);
    expect(v.phase).toBe('swept');
    expect(v.headline).toMatch(/Wound down/);
    expect(v.steps.find((s) => s.id === 'sweep')).toMatchObject({ state: 'done' });
    expect(v.holder[0]).toMatch(/Redemption is closed/);
    expect(v.recovery).toBe(R);
  });
  it('a treasury extended without a window never expires redemption', () => {
    const v = windDownView(liquidating(), extended(null, null), NOW);
    expect(v.mode).toBe('no-window');
    expect(v.steps.map((s) => s.id)).toEqual(['lapse', 'liquidation', 'redemption']);
    expect(v.headline).toMatch(/never expires/);
    expect(v.countdown).toBeNull();
  });
  it('the first release has no window either, and says so', () => {
    const v = windDownView(liquidating(), { extended: false }, NOW);
    expect(v.mode).toBe('first-release');
    expect(v.steps.find((s) => s.id === 'redemption')!.text).toMatch(/first release.*no wind-down window/);
  });
  it('claims nothing about the window while the extension could not be read', () => {
    const v = windDownView(liquidating(), null, NOW);
    expect(v.mode).toBe('unknown');
    expect(v.steps.map((s) => s.id)).toEqual(['lapse', 'liquidation']);
  });
});

describe('entitlement', () => {
  it('is the holder’s share of the snapshot, rounded down as the program does', () => {
    expect(entitlement(400_000_000n, { snapshot: { vault: '10000000000', supply: '1000000000' } })).toBe(4_000_000_000n);
    expect(entitlement(1n, { snapshot: { vault: '10', supply: '3' } })).toBe(3n);
    expect(entitlement(5n, { snapshot: null })).toBeNull();
  });
});
