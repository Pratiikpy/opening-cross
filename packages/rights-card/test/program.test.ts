// The cards may say only what the program does. These tests read the program source and fail when a card cites an
// instruction or an error the program does not have, cites an error the instruction cannot raise, or when the program
// gains an instruction the "absence" cards have not been re-derived for.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROGRAM_INSTRUCTIONS, type ExtFacts, type TreasuryFacts, formatAtoms, formatDuration, rightsCards } from '../src/index.js';

const SRC_DIR = fileURLToPath(new URL('../../../programs/treasury/src/', import.meta.url));
const FILES = readdirSync(SRC_DIR).filter((n) => n.endsWith('.rs'));
// The Rust sources may carry CRLF line endings (a Windows checkout); the patterns below assume LF.
const read = (n: string): string => readFileSync(`${SRC_DIR}${n}`, 'utf8').replace(/\r\n/g, '\n');
const SRC = read('lib.rs');
const ALL = FILES.map(read).join('\n');

/** The `pub fn` items inside `pub mod treasury { ... }`, with their bodies (the file's own 4-space layout closes each at `\n    }\n`). */
function instructions(): Map<string, string> {
  const mod = SRC.slice(SRC.indexOf('pub mod treasury {'), SRC.indexOf('\nfn attested('));
  const out = new Map<string, string>();
  for (const m of mod.matchAll(/\n    pub fn (\w+)\(([\s\S]*?)\n    \}\n/g)) out.set(m[1]!, m[0]);
  return out;
}
const errors = (): string[] => [...SRC.slice(SRC.indexOf('pub enum TreasuryError')).matchAll(/\n    (\w+),/g)].map((m) => m[1]!);

/** Text of the Rust function `name` (any file, any indentation), up to the closing brace at the same indentation. */
function fnText(name: string): string | null {
  const m = new RegExp(`\\n( *)(?:pub )?fn ${name}\\b[\\s\\S]*?\\n\\1\\}\\n`).exec(ALL);
  return m ? m[0] : null;
}
const FN_NAMES = new Set([...ALL.matchAll(/\n *(?:pub )?fn (\w+)/g)].map((m) => m[1]!));

/** The accounts struct an instruction uses, found from its `ctx: Context<X>` argument in any file. */
function accountsStruct(instr: string): string {
  const ctx = /Context<(\w+)>/.exec(instructions().get(instr)!)![1]!;
  const at = ALL.indexOf(`pub struct ${ctx}<'info>`);
  return ALL.slice(at, ALL.indexOf('\n}\n', at));
}

/** Everything an instruction can run: its body, its accounts constraints, and the functions it calls (followed three levels deep). */
function reachable(instr: string): string {
  let text = instructions().get(instr)! + accountsStruct(instr);
  const seen = new Set<string>([instr]);
  for (let depth = 0; depth < 3; depth++) {
    for (const call of new Set([...text.matchAll(/(\w+)\(/g)].map((m) => m[1]!))) {
      if (seen.has(call) || !FN_NAMES.has(call)) continue;
      seen.add(call);
      const body = fnText(call);
      if (body) text += body;
    }
  }
  return text;
}

const base: TreasuryFacts = {
  state: 'Active', authority: 'Auth1111111111111111111111111111111111111111', quoteDecimals: 6,
  allowance: 1_000_000_000n, periodSecs: 2_592_000n, periodStart: 1_800_000_000n, spentInPeriod: 250_000_000n,
  graceSecs: 604_800n, lapsedSince: null, snapshotVault: 0n, snapshotSupply: 0n, vaultBalance: 5_000_000_000n, coinSupply: 1_000_000_000n,
  coinMintAuthority: null, attestation: 'live', programUpgradeAuthority: 'Upg11111111111111111111111111111111111111111', now: 1_800_100_000n,
};
const facts = base;

const fullExt: ExtFacts = {
  voting: { votePeriodSecs: 259_200n, timelockSecs: 86_400n, quorumBps: 2_000, thresholdBps: 5_000, maxProposalBps: 3_000, proposerMinBps: 100 },
  nav: { periodSecs: 604_800n, capBps: 1_000, open: false, insiders: ['Ins1111111111111111111111111111111111111111'] },
  revenue: { shareBps: 1_000, roundSecs: 2_592_000n, payGraceSecs: 604_800n, missedRounds: 0, trancheAmount: 100_000_000n },
  disclosure: { periodSecs: 1_209_600n, requestMinBps: 1_000, openRequestTs: null, lastDisclosureTs: null, disclosures: 0 },
  assignment: { assigned: false },
  windDown: { windowSecs: 15_552_000n, recovery: 'Rec11111111111111111111111111111111111111111', windStart: null, swept: false },
  minLockupSecs: 31_536_000n,
  totalStaked: 400_000_000n,
  grantsUnreleased: 50_000_000n,
  streamSecs: 604_800n,
};
const extended: TreasuryFacts = { ...base, ext: fullExt };
const extendedBare: TreasuryFacts = {
  ...base,
  ext: { ...fullExt, voting: null, nav: null, revenue: null, disclosure: null, assignment: null, windDown: null },
};

describe('the program source', () => {
  it('has exactly the instructions the cards were derived from', () => {
    expect([...instructions().keys()].sort()).toEqual([...PROGRAM_INSTRUCTIONS].sort());
  });
});

describe.each([
  ['a treasury that was never extended', base],
  ['an extended treasury with every feature on', extended],
  ['an extended treasury with every feature off', extendedBare],
])('rights cards for %s', (_name, f) => {
  const cards = rightsCards(f);

  it('cite only instructions and errors that exist, and each error is raised by the instruction cited', () => {
    const ix = instructions();
    const all = errors();
    expect(all.length).toBeGreaterThan(40);
    for (const c of cards)
      for (const e of c.enforcedBy) {
        expect(ix.has(e.instruction), `${c.id}: no instruction ${e.instruction}`).toBe(true);
        if (e.error === null) continue;
        expect(all, `${c.id}: no error ${e.error}`).toContain(e.error);
        expect(reachable(e.instruction).includes(`TreasuryError::${e.error}`), `${c.id}: ${e.instruction} cannot raise ${e.error}`).toBe(true);
      }
  });

  it('give every card either an enforcement or an absence, and never both empty', () => {
    for (const c of cards) expect(c.enforcedBy.length > 0 || c.absence !== null, c.id).toBe(true);
  });

  it('have unique ids', () => {
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
  });

  it('end with the upgrade caveat and carry a title and statement on every card', () => {
    expect(cards.at(-1)!.id).toBe('program-upgradeable');
    for (const c of cards) {
      expect(c.title.length, c.id).toBeGreaterThan(5);
      expect(c.statement.length, c.id).toBeGreaterThan(20);
    }
  });
});

describe('rights cards for a treasury that was never extended', () => {
  const cards = rightsCards(base);

  it('say nothing about votes, yield or locks as entitlements', () => {
    for (const id of ['no-vote', 'no-income', 'no-team-lock', 'no-use-limit', 'attestation-content', 'late-deposits']) expect(cards.find((c) => c.id === id)?.kind).toBe('not-provided');
    expect(cards.find((c) => c.id === 'holder-votes')).toBeUndefined();
    expect(cards.find((c) => c.id === 'nav-redemption')).toBeUndefined();
  });

  it('refuse proposals with NotExtended, and say the team can extend once', () => {
    expect(cards.find((c) => c.id === 'no-vote')!.enforcedBy[0]).toMatchObject({ instruction: 'propose', error: 'NotExtended' });
    expect(cards.find((c) => c.id === 'extend-once')!.now).toBe('This treasury has not been extended.');
  });

  it('claim a card is not provided only when the program has no instruction for it', () => {
    // The absence cards rest on this list; a new instruction must be reviewed against them.
    expect(instructions().size).toBe(PROGRAM_INSTRUCTIONS.length);
    expect(ALL).not.toMatch(/pub fn (set_|update_|lock|vest|withdraw|snapshot|push|distribute\b|transfer_authority|change_authority|close)/);
  });

  it('state the actual numbers of this treasury', () => {
    const spend = cards.find((c) => c.id === 'spend-cap')!;
    expect(spend.statement).toContain('1,000 quote');
    expect(spend.statement).toContain('30 days');
    expect(spend.now).toContain('750 quote of 1,000 quote');
  });
});

describe('rights cards for an extended treasury', () => {
  const byId = (f: TreasuryFacts, id: string) => rightsCards(f).find((c) => c.id === id);

  it('add a card for each feature that is on, with the treasury\'s own numbers', () => {
    const ids = rightsCards(extended).map((c) => c.id);
    for (const id of ['holder-votes', 'nav-redemption', 'revenue-rounds', 'staker-distributions', 'team-grants', 'disclosure-requests', 'assignment-gate', 'wind-down', 'extend-once']) expect(ids, id).toContain(id);
    expect(ids).not.toContain('no-vote');
    const votes = byId(extended, 'holder-votes')!;
    expect(votes.statement).toContain('3 days');
    expect(votes.statement).toContain('20%');
    expect(votes.statement).toContain('30% of the vault');
    expect(byId(extended, 'nav-redemption')!.statement).toContain('10% of the supply');
    expect(byId(extended, 'team-grants')!.statement).toContain('365 days');
    expect(byId(extended, 'wind-down')!.statement).toContain('180 days');
  });

  it('leave out a feature the team switched off, and say votes are off', () => {
    const ids = rightsCards(extendedBare).map((c) => c.id);
    for (const id of ['holder-votes', 'nav-redemption', 'revenue-rounds', 'disclosure-requests', 'assignment-gate', 'wind-down']) expect(ids, id).not.toContain(id);
    expect(byId(extendedBare, 'no-vote')!.enforcedBy[0]).toMatchObject({ instruction: 'propose', error: 'Disabled' });
    expect(ids).toContain('staker-distributions');
    expect(ids).toContain('team-grants');
  });

  it('read the NAV window, the disclosure request, the assignment and the wind-down from the chain facts', () => {
    expect(byId(extended, 'nav-redemption')!.now).toBe('The NAV window is closed now.');
    expect(byId({ ...extended, ext: { ...fullExt, nav: { ...fullExt.nav!, open: true } } }, 'nav-redemption')!.now).toBe('The NAV window is open now.');
    expect(byId(extended, 'disclosure-requests')!.now).toContain('No request is open');
    expect(byId({ ...extended, ext: { ...fullExt, disclosure: { ...fullExt.disclosure!, openRequestTs: 1_800_000_500n } } }, 'disclosure-requests')!.now).toContain('is waiting for a post');
    expect(byId(extended, 'assignment-gate')!.now).toContain('cannot spend');
    expect(byId({ ...extended, ext: { ...fullExt, assignment: { assigned: true } } }, 'assignment-gate')!.now).toBe('The assignment is recorded.');
    const liq = { ...extended, state: 'Liquidating' as const };
    expect(byId({ ...liq, ext: { ...fullExt, windDown: { ...fullExt.windDown!, windStart: 1_800_000_000n } } }, 'wind-down')!.now).toContain('The window ends at');
    expect(byId({ ...liq, ext: { ...fullExt, windDown: { ...fullExt.windDown!, swept: true } } }, 'wind-down')!.now).toContain('swept');
    expect(byId(liq, 'nav-redemption')!.now).toContain('liquidation');
  });

  it('never call the revenue figure checked, and never promise a deployed program', () => {
    expect(byId(extended, 'revenue-rounds')!.statement).toContain('does not check it against any payment record');
    for (const c of rightsCards(extended)) expect(c.statement.toLowerCase(), c.id).not.toMatch(/guarantee|audited|safe\b/);
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
