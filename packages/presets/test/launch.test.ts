import { describe, expect, it } from 'vitest';
import { LAUNCH_PRESETS, LISTING_TYPES, type TokenFacts, autofillFromToken, launchPreset, listingType, rankQuoteMints, stepAtoms } from '../src/launch.js';

const WALLET = 'WaLLetWaLLetWaLLetWaLLetWaLLetWaLLetWaLLet111';
const token = (over: Partial<TokenFacts> = {}): TokenFacts => ({ decimals: 6, program: 'token', supply: 0n, mintAuthority: WALLET, freezeAuthority: null, extensions: [], metadata: null, ...over });

describe('launch presets', () => {
  it('every preset stays inside what the program and the form accept', () => {
    for (const p of LAUNCH_PRESETS) {
      expect(p.fields.ticks).toBeGreaterThanOrEqual(2);
      expect(p.fields.ticks).toBeLessThanOrEqual(256);
      expect(p.fields.callMinutes).toBeGreaterThan(0);
      expect(p.fields.openInMinutes).toBeGreaterThanOrEqual(0);
      expect(p.fields.revealMinutes).toBeGreaterThanOrEqual(1);
      expect(p.fields.maxOrders).toBeGreaterThanOrEqual(1);
      expect(p.fields.stepBps).toBeGreaterThan(0);
    }
  });

  it('ids are unique, every preset is findable, and none carries a price, a supply or a raise target', () => {
    expect(new Set(LAUNCH_PRESETS.map((p) => p.id)).size).toBe(LAUNCH_PRESETS.length);
    for (const p of LAUNCH_PRESETS) {
      expect(launchPreset(p.id)).toBe(p);
      expect(Object.keys(p.fields).sort()).toEqual(['callMinutes', 'disclosure', 'kind', 'maxOrders', 'openInMinutes', 'revealMinutes', 'stepBps', 'supplyMode', 'ticks']);
    }
    expect(launchPreset('nope')).toBeUndefined();
  });

  it('a minting preset is never paired with escrow supply and a reopening one always is', () => {
    expect(launchPreset('sealed-launch')?.fields).toMatchObject({ supplyMode: 'mint', disclosure: 'sealed' });
    expect(launchPreset('reopen')?.fields).toMatchObject({ supplyMode: 'escrow', kind: 'reopen' });
    expect(launchPreset('tender')?.fields).toMatchObject({ supplyMode: 'escrow', disclosure: 'sealed' });
  });

  it('the oracle guard is advised only where a reference price can exist, the treasury only where a coin is minted', () => {
    expect(launchPreset('reopen')?.modules.oracleGuard).toBe('recommended');
    expect(launchPreset('sealed-launch')?.modules.oracleGuard).toBe('not-applicable');
    expect(launchPreset('sealed-launch')?.modules.treasury).toBe('recommended');
    expect(launchPreset('reopen')?.modules.treasury).toBe('not-applicable');
  });
});

describe('stepAtoms', () => {
  it('is the share of the lowest price when exact', () => {
    expect(stepAtoms(1_000_000n, 500)).toBe(50_000n);
    expect(stepAtoms(2_000_000n, 100)).toBe(20_000n);
  });
  it('is null when the division would leave the quote atoms', () => {
    expect(stepAtoms(1_000_001n, 500)).toBeNull();
    expect(stepAtoms(1n, 500)).toBeNull();
  });
  it('is null for a non-positive price or step', () => {
    expect(stepAtoms(0n, 500)).toBeNull();
    expect(stepAtoms(-5n, 500)).toBeNull();
    expect(stepAtoms(1_000_000n, 0)).toBeNull();
    expect(stepAtoms(1_000_000n, 1.5)).toBeNull();
  });
});

describe('listing types', () => {
  it('every available type names a real preset, and every type that needs a partner names why and which human task', () => {
    for (const t of LISTING_TYPES) {
      if (t.availability === 'available') {
        expect(t.presetId && launchPreset(t.presetId), t.id).toBeTruthy();
        expect(t.blocker).toBeNull();
      } else {
        expect(t.presetId).toBeNull();
        expect(t.blocker?.length ?? 0).toBeGreaterThan(20);
        expect(t.humanTasks.length).toBeGreaterThan(0);
      }
    }
    expect(listingType('pre-ipo')?.availability).toBe('needs-partner');
    expect(listingType('ownership-coin')?.availability).toBe('available');
    expect(listingType('zzz')).toBeUndefined();
  });
  it('does not promise payouts the treasury program does not make', () => {
    expect(listingType('revenue-share')?.rights).toMatch(/does not pay revenue out/);
  });
});

describe('autofillFromToken', () => {
  it('a token whose mint authority is the wallet suggests a minting launch', () => {
    const a = autofillFromToken(token(), WALLET);
    expect(a.blockers).toEqual([]);
    expect(a.suggestions.find((s) => s.field === 'supplyMode')?.value).toBe('mint');
    expect(a.suggestions.find((s) => s.field === 'presetId')?.value).toBe('sealed-launch');
    expect(a.facts).toContain('your wallet holds the mint authority');
  });

  it('a fixed-supply token suggests escrow and a reopening, and an empty one cannot be sold', () => {
    const a = autofillFromToken(token({ mintAuthority: null, supply: 5_000_000n }), WALLET);
    expect(a.suggestions.find((s) => s.field === 'supplyMode')?.value).toBe('escrow');
    expect(a.suggestions.find((s) => s.field === 'listingType')?.value).toBe('existing-token');
    expect(a.blockers).toEqual([]);
    expect(autofillFromToken(token({ mintAuthority: null, supply: 0n }), WALLET).blockers[0]).toMatch(/nothing to sell/);
  });

  it('a token someone else can still mint is blocked, with no suggestion', () => {
    const a = autofillFromToken(token({ mintAuthority: 'SomeoneElse' }), WALLET);
    expect(a.suggestions).toEqual([]);
    expect(a.blockers[0]).toMatch(/not the mint authority/);
  });

  it('with no wallet connected it can say what the token allows, but never that the wallet is wrong', () => {
    const own = autofillFromToken(token({ mintAuthority: 'SomeoneElse' }), null);
    expect(own.blockers).toEqual([]);
    expect(own.suggestions).toEqual([]);
    expect(own.notes.join(' ')).toMatch(/Connect the wallet that holds it/);
    expect(own.facts).toContain('a mint authority is set');
    // a fixed supply is a fact about the token, so the suggestion stands without a wallet
    expect(autofillFromToken(token({ mintAuthority: null, supply: 3n }), null).suggestions.find((s) => s.field === 'supplyMode')?.value).toBe('escrow');
  });

  it('extensions a cross cannot settle through are blockers, powers over holders are notes', () => {
    const a = autofillFromToken(token({ program: 'token-2022', extensions: ['transferHook', 'transferFeeConfig', 'nonTransferable', 'permanentDelegate'], freezeAuthority: 'F' }), WALLET);
    expect(a.blockers).toHaveLength(3);
    expect(a.notes.join(' ')).toMatch(/freeze authority/);
    expect(a.notes.join(' ')).toMatch(/permanent delegate/);
  });

  it('reads the name from the token’s own metadata and notes existing supply on a minting launch', () => {
    const a = autofillFromToken(token({ program: 'token-2022', metadata: { name: 'Northwind', symbol: 'NWC' }, supply: 10n }), WALLET);
    expect(a.facts.join(' ')).toContain('Northwind (NWC)');
    expect(a.notes.join(' ')).toMatch(/already minted/);
  });

  it('never suggests a price, a supply amount or a quote mint', () => {
    for (const mintAuthority of [WALLET, null]) {
      const a = autofillFromToken(token({ mintAuthority, supply: 1n }), WALLET);
      expect(new Set(a.suggestions.map((s) => s.field))).toEqual(new Set(['supplyMode', 'presetId', 'listingType']));
    }
  });
});

describe('rankQuoteMints', () => {
  it('orders by use, breaking ties by address, and offers nothing it was not given', () => {
    expect(rankQuoteMints(['B', 'A', 'B', 'C', 'A', 'B'])).toEqual([
      { mint: 'B', crosses: 3 },
      { mint: 'A', crosses: 2 },
      { mint: 'C', crosses: 1 },
    ]);
    expect(rankQuoteMints([])).toEqual([]);
    expect(rankQuoteMints(['Z', 'Y'])).toEqual([
      { mint: 'Y', crosses: 1 },
      { mint: 'Z', crosses: 1 },
    ]);
  });
});
