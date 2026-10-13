// The cards may say only what the program does. These tests read the program source and fail when a card cites an
// instruction or an error the program does not have, cites an error from the wrong instruction, or when the program
// gains an instruction the "absence" cards have not been re-derived for.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROGRAM_INSTRUCTIONS, type TreasuryFacts, formatAtoms, formatDuration, rightsCards } from '../src/index.js';

const SRC = readFileSync(fileURLToPath(new URL('../../../programs/treasury/src/lib.rs', import.meta.url)), 'utf8');

/** The `pub fn` items inside `pub mod treasury { ... }`, with their bodies (the file's own 4-space layout closes each at `\n    }\n`). */
function instructions(): Map<string, string> {
  const mod = SRC.slice(SRC.indexOf('pub mod treasury {'), SRC.indexOf('\nfn attested('));
  const out = new Map<string, string>();
  for (const m of mod.matchAll(/\n    pub fn (\w+)\(([\s\S]*?)\n    \}\n/g)) out.set(m[1]!, m[0]);
  return out;
}
const errors = (): string[] => [...SRC.slice(SRC.indexOf('pub enum TreasuryError')).matchAll(/\n    (\w+),/g)].map((m) => m[1]!);

/** Account-constraint errors live in the `#[derive(Accounts)]` structs, not the instruction bodies; map the struct each instruction uses. */
const ACCOUNTS_OF: Record<string, string> = { create_treasury: 'CreateTreasury', spend: 'Spend', record_lapse: 'Observe', record_attested: 'Observe', trigger_liquidation: 'Trigger', redeem: 'Redeem' };
const accountsStruct = (name: string): string => {
  const at = SRC.indexOf(`pub struct ${name}<'info>`);
  return SRC.slice(at, SRC.indexOf('\n}\n', at));
};

const attestedHelper = (): string => {
  const at = SRC.indexOf('\nfn attested(');
  return SRC.slice(at, SRC.indexOf('\n}\n', at));
};

const facts: TreasuryFacts = {
  state: 'Active', authority: 'Auth1111111111111111111111111111111111111111', quoteDecimals: 6,
  allowance: 1_000_000_000n, periodSecs: 2_592_000n, periodStart: 1_800_000_000n, spentInPeriod: 250_000_000n,
  graceSecs: 604_800n, lapsedSince: null, snapshotVault: 0n, snapshotSupply: 0n, vaultBalance: 5_000_000_000n, coinSupply: 1_000_000_000n,
  coinMintAuthority: null, attestation: 'live', programUpgradeAuthority: 'Upg11111111111111111111111111111111111111111', now: 1_800_100_000n,
};

describe('the program source', () => {
  it('has exactly the instructions the cards were derived from', () => {
    expect([...instructions().keys()].sort()).toEqual([...PROGRAM_INSTRUCTIONS].sort());
  });
});

describe('rights cards', () => {
  const cards = rightsCards(facts);

  it('cite only instructions and errors that exist, and each error is raised by the instruction cited', () => {
    const ix = instructions();
    const all = errors();
    expect(all.length).toBeGreaterThan(10);
    for (const c of cards)
      for (const e of c.enforcedBy) {
        expect(ix.has(e.instruction), `${c.id}: no instruction ${e.instruction}`).toBe(true);
        if (e.error === null) continue;
        expect(all, `${c.id}: no error ${e.error}`).toContain(e.error);
        const inBody = ix.get(e.instruction)!;
        // `attested()` is the shared helper that raises WrongAttestationAccount for every instruction that calls it.
        const body = inBody + accountsStruct(ACCOUNTS_OF[e.instruction]!) + (inBody.includes('attested(') ? attestedHelper() : '');
        expect(body.includes(e.error), `${c.id}: ${e.instruction} does not raise ${e.error}`).toBe(true);
      }
  });

  it('give every card either an enforcement or an absence, and never both empty', () => {
    for (const c of cards) expect(c.enforcedBy.length > 0 || c.absence !== null, c.id).toBe(true);
  });

  it('have unique ids and say nothing about votes, yield or locks as entitlements', () => {
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
    for (const id of ['no-vote', 'no-income', 'no-team-lock', 'no-use-limit', 'attestation-content', 'late-deposits']) expect(cards.find((c) => c.id === id)?.kind).toBe('not-provided');
  });

  it('claim a card is not provided only when the program has no instruction for it', () => {
    // The absence cards rest on this list; a new instruction must be reviewed against them.
    expect(instructions().size).toBe(6);
    expect(SRC).not.toMatch(/pub fn (vote|propose|set_|update_|lock|vest|withdraw|distribute|claim)/);
  });

  it('state the actual numbers of this treasury', () => {
    const spend = cards.find((c) => c.id === 'spend-cap')!;
    expect(spend.statement).toContain('1,000 quote');
    expect(spend.statement).toContain('30 days');
    expect(spend.now).toContain('750 quote of 1,000 quote');
  });
});

describe('state-dependent lines', () => {
  const now = (f: TreasuryFacts, id: string) => rightsCards(f).find((c) => c.id === id)!.now;

  it('says the allowance is whole again once the period has elapsed', () => {
    expect(now({ ...facts, now: facts.periodStart + facts.periodSecs + 5n }, 'spend-cap')).toContain('1,000 quote of 1,000 quote');
  });

  it('walks the lapse, grace and liquidation lines', () => {
    expect(now(facts, 'anyone-triggers-liquidation')).toContain('no lapse');
    const lapsed = { ...facts, lapsedSince: 1_800_050_000n, attestation: 'not-live' as const };
    expect(now(lapsed, 'anyone-triggers-liquidation')).toContain('before then, liquidation is refused');
    expect(now({ ...lapsed, now: 1_800_050_000n + 604_800n }, 'anyone-triggers-liquidation')).toContain('anyone can trigger liquidation now');
    expect(now(lapsed, 'spend-gate')).toContain('cannot spend');
  });

  it('shows the exact snapshot share once liquidating, and an explicit estimate before', () => {
    expect(now(facts, 'redeem-pro-rata')).toContain('an estimate, not a promise');
    const liq = { ...facts, state: 'Liquidating' as const, snapshotVault: 8_000_000_001n, snapshotSupply: 1_000_000_000n };
    expect(now(liq, 'redeem-pro-rata')).toContain('floor(8000000001 × N ÷ 1000000000)');
    expect(now(liq, 'spend-cap')).toContain('closed for good');
  });

  it('reports an immutable, an upgradeable and an unreadable program honestly', () => {
    expect(rightsCards({ ...facts, programUpgradeAuthority: null }).at(-1)!.title).toBe('The program cannot be changed');
    expect(rightsCards(facts).at(-1)!.now).toContain('Upg1111');
    expect(rightsCards({ ...facts, programUpgradeAuthority: 'unknown' }).at(-1)!.now).toContain('could not be read');
  });

  it('shows the coin mint authority from chain rather than assuming it is revoked', () => {
    expect(now({ ...facts, coinMintAuthority: 'Minter1111111111111111111111111111111111111' }, 'fixed-supply')).toContain('Minter1111');
  });
});

describe('formatting', () => {
  it('formats atoms exactly and durations plainly', () => {
    expect(formatAtoms(10_000_000_001n, 6)).toBe('10,000.000001');
    expect(formatAtoms(5n, 0)).toBe('5');
    expect(formatDuration(90n)).toBe('1 minute 30 seconds');
    expect(formatDuration(604_800n)).toBe('7 days');
  });
});
