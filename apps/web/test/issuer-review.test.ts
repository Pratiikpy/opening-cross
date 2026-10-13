import { describe, expect, it } from 'vitest';
import { checkIssuerForm } from '../src/lib/issuer';
import { newDraft } from '../src/lib/issuer-draft';
import { type MintRead, evaluateReadiness } from '../src/lib/issuer-readiness';
import { derive, ruleChecks } from '../src/lib/issuer-wizard';
import { AUTOMATIC, REVIEWED } from '../src/lib/issuer-review';

describe('the published checklist', () => {
  it('lists only checks the wizard really makes', () => {
    const d = newDraft(new Date('2026-10-13T12:00:00'));
    const mint: MintRead = { ok: true, program: 'T', decimals: 6, mintAuthority: 'W', freezeAuthority: null, extensions: [], supply: 1n };
    const facts = { base: mint, quote: mint, lamports: 5_000_000_000n, quoteAccount: { exists: true, amount: 1_000_000_000n }, rent: { cross: 1n, level: 1n, vault: 1n }, clock: { chainMs: 0, localMs: 0 } };
    const form = checkIssuerForm(
      { creator: 'W', baseMint: 'B', quoteMint: 'Q', baseDecimals: 6, quoteDecimals: 6, baseTokenProgram: 'T', quoteTokenProgram: 'T', disclosure: 'open', supplyMode: 'mint', kind: 'launch', minPrice: '1', tick: '0.1', ticks: 5, openAt: new Date(3_600_000), closeAt: new Date(7_200_000), revealMinutes: 1, minMatched: '', maxImbalancePct: '', integrator: 'W', integratorFeeBps: 0, maxOrders: 10, shards: 1, proceedsTo: 'W', schedule: [], crossId: '1' },
      new Date(0),
    );
    const ids = new Set([
      ...evaluateReadiness({ wallet: 'W', supplyMode: 'mint', baseMint: 'B', quoteMint: 'Q', shards: 1, openAt: new Date(3_600_000), closeAt: new Date(7_200_000), form }, facts, 0).map((c) => c.id),
      // the rule checks appear when the form asks for them
      ...ruleChecks({ ...d, minFloatPct: '5', maxFdv: '100', minMatched: '1' }, derive({ ...d, minFloatPct: '5', maxFdv: '100' }, mint, mint)).map((c) => c.id),
    ]);
    for (const c of AUTOMATIC) expect(ids.has(c.id), c.id).toBe(true);
  });

  it('has unique ids', () => {
    const all = [...AUTOMATIC, ...REVIEWED].map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });
});
