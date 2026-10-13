import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ReplayEvent, type ReplayListResponse, type ReplayResponse, axisPositions, clusterOf, describeEvent, elapsedSince, explorerTx, isReplayListResponse, isReplayResponse, kindLabel, listTimings, tallyAt } from '../src/lib/replay';

const M = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
// Cross 5UfrmxAv... exactly as GET /v1/replay/:address and GET /v1/replay served them from the live devnet API on 2026-10-13:
// three open bids, one clear, three claims, one finalize.
const real = JSON.parse(readFileSync(new URL('./fixtures/replay-5Ufrm.json', import.meta.url), 'utf8')) as ReplayResponse;
const list = JSON.parse(readFileSync(new URL('./fixtures/replay-list.json', import.meta.url), 'utf8')) as ReplayListResponse;

const ev = (n: number, kind: string, details: Record<string, unknown>, time: string | null = null): ReplayEvent => ({ n, kind, event: kind, slot: String(100 + n), time, signature: `sig${n}`, details });

describe('replay response shape', () => {
  it('accepts the real payloads and refuses a malformed one', () => {
    expect(isReplayResponse(real)).toBe(true);
    expect(isReplayListResponse(list)).toBe(true);
    expect(isReplayResponse({ cross: 'x', events: [{ kind: 1 }], summary: {} })).toBe(false);
    expect(isReplayResponse(null)).toBe(false);
    expect(isReplayListResponse({ crosses: [{ address: 'a' }] })).toBe(false);
  });
});

describe('describeEvent on a real cross', () => {
  const text = real.events.map((e) => describeEvent(e, M));
  it('says what each event did in tokens, not atoms', () => {
    expect(text[0]).toMatch(/launch cross was created by AG5h…wHgP with open bids/);
    expect(text[1]).toBe('Buy order #0 was placed by 5ghd…wYBy for 1,500 tokens at a limit of 1.5.');
    expect(text[2]).toMatch(/^Buy order #2 was placed by 9c8A….+ for 800 tokens at a limit of 1\.2\.$/);
    expect(text[4]).toBe('The cross printed at 1.2 with 2,000 tokens traded; buy orders at the price were filled pro rata.');
    expect(text[5]).toContain('received 1,500 tokens');
    expect(text[6]).toContain('was not filled');
    expect(text.at(-1)).toMatch(/finalized/);
  });
  it('labels every kind it knows and passes an unknown one through', () => {
    expect(real.events.map((e) => kindLabel(e.kind))).toEqual(['Cross created', 'Order placed', 'Order placed', 'Order placed', 'Cleared', 'Order settled', 'Order settled', 'Order settled', 'Finalized']);
    expect(kindLabel('something_new')).toBe('something_new');
    expect(describeEvent(ev(1, 'something_new', {}), M)).toBe('something_new.');
  });
});

describe('describeEvent edge cases', () => {
  it('never reveals the terms of a sealed order', () => {
    const t = describeEvent(ev(1, 'order_placed', { side: 1, index: 4, owner: 'Owner111111111111', sealed: true, price: '999', quantity: '999' }), M);
    expect(t).toContain('sealed');
    expect(t).not.toContain('999');
  });
  it('describes a reveal, a cancel and a no print by their own fields', () => {
    expect(describeEvent(ev(1, 'order_revealed', { side: 0, price: '1300000', quantity: '600000000' }), M)).toBe('A sealed buy bid was revealed: 600 tokens at a limit of 1.3.');
    expect(describeEvent(ev(2, 'order_cancelled', { owner: 'Owner111111111111' }), M)).toContain('cancelled by Owne…1111');
    expect(describeEvent(ev(3, 'cleared', { printed: false, clearing: { __option: 'None' }, noPrintReason: { __option: 'Some', value: 1 } }), M)).toBe('The cross did not print: volume below the minimum. Every order is refunded in full.');
  });
  it('leaves out what the program did not emit instead of inventing it', () => {
    expect(describeEvent(ev(1, 'order_placed', { owner: 'Owner111111111111' }), M)).toBe('An order was placed by Owne…1111.');
  });
});

describe('tallyAt', () => {
  it('counts the real cross step by step', () => {
    const at = (n: number) => tallyAt(real.events, n);
    expect(at(0)).toMatchObject({ placed: 0, phase: 'taking orders', levels: [] });
    expect(at(4)).toMatchObject({ placed: 3, open: 3, cleared: false, phase: 'taking orders' });
    expect(at(4).levels.map((l) => [l.price, l.buy, l.sell])).toEqual([
      [1_500_000n, 1_500_000_000n, 0n],
      [1_200_000n, 800_000_000n, 0n],
      [1_100_000n, 500_000_000n, 0n],
    ]);
    expect(at(5)).toMatchObject({ cleared: true, phase: 'cleared', levels: [] });
    expect(at(7)).toMatchObject({ claimed: 2, open: 1 });
    expect(at(9)).toMatchObject({ claimed: 3, open: 0, finalized: true, phase: 'finalized' });
    expect(at(999).step).toBe(9);
  });
  it('keeps a sealed order out of the book until its reveal and drops a cancelled one', () => {
    const e = [
      ev(1, 'order_placed', { order: 'A', side: 0, sealed: true }),
      ev(2, 'order_placed', { order: 'B', side: 1, sealed: true }),
      ev(3, 'order_placed', { order: 'C', side: 0, sealed: false, price: '1100000', quantity: '5' }),
      ev(4, 'order_revealed', { order: 'A', side: 0, price: '1200000', quantity: '7' }),
      ev(5, 'order_cancelled', { order: 'B' }),
    ];
    expect(tallyAt(e, 3)).toMatchObject({ sealedHidden: 2, open: 3 });
    expect(tallyAt(e, 3).levels).toEqual([{ price: 1_100_000n, buy: 5n, sell: 0n }]);
    const done = tallyAt(e, 5);
    expect(done).toMatchObject({ sealedHidden: 0, revealed: 1, cancelled: 1, open: 2 });
    expect(done.levels.map((l) => [l.price, l.buy])).toEqual([
      [1_200_000n, 7n],
      [1_100_000n, 5n],
    ]);
  });
});

describe('time helpers', () => {
  it('measures elapsed time from the first event and tolerates a missing time', () => {
    expect(elapsedSince('2026-10-12T03:18:47.000Z', '2026-10-12T03:19:35.000Z')).toBe('+48 s');
    expect(elapsedSince('2026-10-12T03:18:47.000Z', '2026-10-12T03:29:57.000Z')).toBe('+11 min 10 s');
    expect(elapsedSince('2026-10-12T03:18:47.000Z', '2026-10-12T05:00:00.000Z')).toBe('+1 h 41 min 13 s');
    expect(elapsedSince(null, '2026-10-12T03:18:47.000Z')).toBeNull();
  });
  it('places events on the time axis, falling back to order when a time is missing', () => {
    expect(axisPositions(real.events)[0]).toBe(0);
    expect(axisPositions(real.events).at(-1)).toBe(1);
    expect(axisPositions([ev(1, 'a', {}), ev(2, 'b', {}), ev(3, 'c', {})])).toEqual([0, 0.5, 1]);
    expect(axisPositions([])).toEqual([]);
  });
  it('turns the list row into timings measured between recorded moments', () => {
    const printed = list.crosses.find((c) => c.firstOrderAt !== null)!;
    const t = listTimings(printed);
    expect(t.firstOrderAfterOpen).not.toBeNull();
    expect(t.clearedAfterClose).not.toBeNull();
    const none = list.crosses.find((c) => c.firstOrderAt === null)!;
    expect(listTimings(none).firstOrderAfterOpen).toBeNull();
    expect(listTimings({ window: { openTs: '0', closeTs: '0', revealEndTs: '0' }, firstOrderAt: null, clearedAt: '2026-01-01T00:00:10.000Z', finalizedAt: '2026-01-01T00:00:20.000Z' }).finalizedAfterCleared).toBe('10 s');
  });
});

describe('explorer links', () => {
  it('adds the cluster only off mainnet', () => {
    expect(explorerTx('SIG', 'devnet')).toBe('https://explorer.solana.com/tx/SIG?cluster=devnet');
    expect(explorerTx('SIG', 'mainnet-beta')).toBe('https://explorer.solana.com/tx/SIG');
    expect(clusterOf('https://api.devnet.solana.com')).toBe('devnet');
    expect(clusterOf('https://api.mainnet-beta.solana.com')).toBe('mainnet-beta');
  });
});
