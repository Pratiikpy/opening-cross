import { describe, expect, it } from 'vitest';
import { generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { signDocument } from '@opening-cross/attest';
import { type PresetBody, type SignedPreset, type UsedCross, MAX_ROYALTY_BPS, PRESET_SCHEMA, PresetError, checkSignedPreset, parsePresetMemo, performance, presetMemo, validatePreset } from '../src/index.js';

const AUTHOR = 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC';
const body = (over: Partial<PresetBody> = {}, fields: Partial<PresetBody['fields']> = {}): PresetBody => ({
  schema: PRESET_SCHEMA,
  id: 'sealed-24h',
  version: 1,
  author: AUTHOR,
  name: 'Sealed 24 hour launch',
  summary: 'A sealed launch with a 24 hour call and a 30 minute reveal.',
  fields: { kind: 'launch', disclosure: 'sealed', supplyMode: 'mint', ticks: 40, stepBps: 500, openInMinutes: 60, callMinutes: 1440, revealMinutes: 30, maxOrders: 1000, ...fields },
  royaltyBps: 0,
  tags: ['sealed', 'launch'],
  createdAt: 1_800_000_000,
  ...over,
});
const bad = (b: PresetBody) => {
  try {
    validatePreset(b);
    return 'ACCEPTED';
  } catch (e) {
    return (e as PresetError).message;
  }
};

describe('validatePreset', () => {
  it('accepts a well-formed preset', () => {
    expect(bad(body())).toBe('ACCEPTED');
    expect(bad(body({ id: 'open-reopen', tags: [] }, { kind: 'reopen', disclosure: 'open', supplyMode: 'escrow', revealMinutes: 0 }))).toBe('ACCEPTED');
  });
  it('refuses each bad field and names it', () => {
    expect(bad(body({ id: 'A' }))).toMatch(/id must be/);
    expect(bad(body({ id: '-ab' }))).toMatch(/id must be/);
    expect(bad(body({ version: 0 }))).toMatch(/version/);
    expect(bad(body({ author: 'nope' }))).toMatch(/author/);
    expect(bad(body({ name: 'ab' }))).toMatch(/name/);
    expect(bad(body({ summary: 'short' }))).toMatch(/summary/);
    expect(bad(body({ royaltyBps: MAX_ROYALTY_BPS + 1 }))).toMatch(/royaltyBps/);
    expect(bad(body({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toMatch(/tags/);
    expect(bad(body({ tags: ['UPPER'] }))).toMatch(/tags/);
    expect(bad(body({}, { kind: 'auction' as never }))).toMatch(/fields.kind/);
    expect(bad(body({}, { ticks: 1 }))).toMatch(/fields.ticks/);
    expect(bad(body({}, { ticks: 257 }))).toMatch(/fields.ticks/);
    expect(bad(body({}, { stepBps: 0 }))).toMatch(/stepBps/);
    expect(bad(body({}, { callMinutes: 4 }))).toMatch(/callMinutes/);
    expect(bad(body({}, { maxOrders: 0 }))).toMatch(/maxOrders/);
    expect(bad(body({}, { ticks: 40.5 }))).toMatch(/whole number/);
    expect(bad(body({ schema: 'x' as never }))).toMatch(/schema/);
  });
  it('knows a sealed call needs a reveal window and an open one has none', () => {
    expect(bad(body({}, { revealMinutes: 0 }))).toMatch(/revealMinutes/);
    expect(bad(body({}, { disclosure: 'open', revealMinutes: 30 }))).toMatch(/must be 0/);
  });
  it('knows a minting cross is a launch: the issuer mints the supply, a reopen or tender sells existing tokens', () => {
    expect(bad(body({}, { kind: 'reopen', supplyMode: 'mint' }))).toMatch(/minting preset must be a launch/);
    expect(bad(body({}, { kind: 'tender', supplyMode: 'mint' }))).toMatch(/minting preset must be a launch/);
    expect(bad(body({}, { kind: 'recurring', supplyMode: 'mint' }))).toBe('ACCEPTED');
  });
});

describe('signing', () => {
  it('requires the author to have signed, and a valid signature', async () => {
    const kp = await generateKeyPair();
    const addr = await getAddressFromPublicKey(kp.publicKey);
    const mine = (await signDocument(body({ author: addr }), kp)) as SignedPreset;
    await expect(checkSignedPreset(mine)).resolves.toBeUndefined();
    const other = await generateKeyPair();
    const forgedAuthor = (await signDocument(body({ author: addr }), other)) as SignedPreset;
    await expect(checkSignedPreset(forgedAuthor)).rejects.toThrow(/signed by its author|does not verify/);
    const tampered = { ...mine, body: { ...mine.body, royaltyBps: 900 } } as SignedPreset;
    await expect(checkSignedPreset(tampered)).rejects.toThrow(/does not verify/);
    const invalid = (await signDocument(body({ author: addr, id: 'X' }), kp)) as SignedPreset;
    await expect(checkSignedPreset(invalid)).rejects.toThrow(/id must be/);
  });
});

describe('the attribution memo', () => {
  it('round trips and rejects what it did not write', () => {
    const m = presetMemo(AUTHOR, 'sealed-24h', 3);
    expect(m).toBe(`oc-preset:1:${AUTHOR}/sealed-24h@3`);
    expect(parsePresetMemo(m)).toEqual({ author: AUTHOR, id: 'sealed-24h', version: 3 });
    expect(parsePresetMemo('oc-sub:1:recurring-starter')).toBeNull();
    expect(parsePresetMemo(`oc-preset:1:${AUTHOR}/Bad_Id@1`)).toBeNull();
    expect(parsePresetMemo(`oc-preset:1:short/sealed-24h@1`)).toBeNull();
    expect(parsePresetMemo(`oc-preset:1:${AUTHOR}/sealed-24h@`)).toBeNull();
    expect(parsePresetMemo(`xoc-preset:1:${AUTHOR}/sealed-24h@1`)).toBeNull();
  });
});

describe('performance', () => {
  const used = (n: number, o: Partial<UsedCross> = {}): UsedCross[] => Array.from({ length: n }, (_, i) => ({ cross: `c${i}`, state: 'Finalized', creator: 'x', orders: 10 + i, wallets: 5 + i, matchedBps: 8000, externalWallets: 4, ...o }));
  it('shows no headline below the minimum sample, and says why', () => {
    const p = performance(used(3));
    expect(p).toMatchObject({ crosses: 3, finished: 3, printed: 3, headline: false, minimumSample: 5 });
    expect(p.caveats.join(' ')).toMatch(/Only 3 finished crosses/);
  });
  it('reports the print rate with an interval, medians, and the crosses that were only the issuer\'s own wallets', () => {
    const rows = [...used(6), ...used(2, { state: 'NoPrint', matchedBps: null, orders: 2, wallets: 1, externalWallets: 0 }).map((u, i) => ({ ...u, cross: `n${i}` })), { cross: 'live', state: 'Live' as const, creator: 'x', orders: 4, wallets: 3, matchedBps: null, externalWallets: 3 }];
    const p = performance(rows);
    expect(p).toMatchObject({ crosses: 9, finished: 8, printed: 6, headline: true, onlyOwnWallets: 2 });
    expect(p.printRate!.value).toBeCloseTo(0.75, 10);
    expect(p.printRate!.lo).toBeGreaterThan(0.4);
    expect(p.printRate!.hi).toBeLessThan(0.95);
    expect(p.medianMatchedBps).toBe(8000);
    expect(p.medianOrders).toBe(11.5); // finished orders sorted: 2,2,10,11,12,13,14,15 -> (11 + 12) / 2
  });
  it('is empty and honest with nothing', () => {
    expect(performance([])).toMatchObject({ crosses: 0, printRate: null, medianOrders: null, headline: false });
  });
});
