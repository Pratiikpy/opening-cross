// The issuer wizard's rules step against the API it talks to. The wizard turns a form into the `rules` object of POST /v1/tx/create-cross-ruled;
// this file proves that the object is one the route's own parser reads and that the SDK's `checkRules` (which the route runs) accepts for every
// preset once the issuer has filled in what only the issuer can, that the constants the form mirrors are the SDK's, and that every refusal the
// SDK can produce lands on a box in the form. Lives here, not in the web app, because it needs the SDK and Fastify.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { type Address, address } from '@solana/kit';
import {
  FLAG_FEEDS_LENDERS,
  FLAG_GUARD_SCALED_UI,
  FLAG_RESUMES_HALT,
  FLAG_STANDARD_GRID,
  MAX_BUCKETS,
  MAX_INSIDERS,
  MAX_REFERRAL_BPS,
  MAX_LOCK_SECS,
  MAX_CHALLENGE_SECS,
  MIN_CHALLENGE_SECS,
  MAX_EXTENSION_SECS,
  MAX_MOVE_BPS,
  MAX_WIDEN_BPS,
  SupplyMode,
  checkRules,
} from '@opening-cross/sdk';
import { EMPTY_RULES_FORM, RULE_LIMITS, RULE_PRESETS, type RulesForm, applyRulePreset, cloneRulesForm } from '../../../packages/presets/src/rules.ts';
import { FLAGS, buildRules, formKeyForIssue, rulesBodyPart } from '../../../apps/web/src/lib/issuer-rules.ts';
import { FLAGSHIP_FACTS } from '../../../packages/presets/src/treasury.ts';
import { flagshipExtParams } from '@opening-cross/treasury-client';
import { RequestError } from '../src/tx.js';
import { registerRulesTx } from '../src/routes/rules-tx.js';
import { parseRules } from '../src/routes/rules-input.js';

const market = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
const units = { baseDecimals: 6, quoteDecimals: 6, market };
const WALLET = '2X63vA1W5qEn53oYaYwcUc3jHLfac9dsiQ1WCN21vyXq';
const OTHER = '2E2aBsgDe255cqMZ7MWkyZx2qMEnMsU3ALuK8NWxKQrr';
const FEED = 'cd'.repeat(32);
const GATE = '6TLfAfu8dxF9YrTLuE4kgx3dapLNbkpsa8hcz36EhZHx';
const OPEN = 1_900_000_000n;
const CLOSE = OPEN + 7_200n;

/** The context of a cross a wizard would create: a minting cross with a gate, an oracle guard and a calendar, so every preset's needs are met. */
const ctx = (over: Record<string, unknown> = {}) => ({
  supplyMode: SupplyMode.Mint,
  minPrice: 1_000_000n,
  tick: 50_000n,
  ticks: 40,
  openTs: OPEN,
  closeTs: CLOSE,
  referencePrice: null,
  gateMint: address(GATE) as Address | null,
  oracleFeedId: new Uint8Array(32).fill(7) as Uint8Array | null,
  calendar: address(OTHER) as Address | null,
  ...over,
});

/** A grid that follows the standard for an estimate of 1.30: it starts at half of it, steps by under one percent of it, and contains it. */
const STOCK_GRID = { minPrice: 650_000n, tick: 10_000n, ticks: 80 };

/** What an issuer adds to each preset: the fields the preset leaves to them. */
const FILL: Record<string, Partial<RulesForm>> = {
  'small-buyers-first': { smallCap: '250' },
  'declared-insiders': { insiders: [WALLET], bond: '50' },
  'stock-reopen': { gridEstimate: '1.3' },
  'oracle-median': { extraFeeds: [FEED] },
};

describe('what the form mirrors', () => {
  it('uses the program’s constants', () => {
    expect(FLAGS).toEqual({ resumesHalt: FLAG_RESUMES_HALT, feedsLenders: FLAG_FEEDS_LENDERS, standardGrid: FLAG_STANDARD_GRID, guardScaledUi: FLAG_GUARD_SCALED_UI });
    expect(RULE_LIMITS).toEqual({
      maxBuckets: MAX_BUCKETS,
      maxInsiders: MAX_INSIDERS,
      maxExtraFeeds: 2,
      maxReferralBps: MAX_REFERRAL_BPS,
      maxLockSecs: MAX_LOCK_SECS,
      minChallengeSecs: MIN_CHALLENGE_SECS,
      maxChallengeSecs: MAX_CHALLENGE_SECS,
      maxExtensionSecs: MAX_EXTENSION_SECS,
      maxMoveBps: MAX_MOVE_BPS,
      maxWidenBps: MAX_WIDEN_BPS,
    });
  });

  it('puts every refusal the SDK can make on a box of the form', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../packages/sdk/src/rules-check.ts', import.meta.url)), 'utf8');
    const fields = [...source.matchAll(/bad\('([A-Z0-9_]+)',\s*(?:`([^`]+)`|'([^']+)')/g)].map((m) => (m[2] ?? m[3])!.replace(/\$\{[^}]+\}/g, '0'));
    const pairs = [...source.matchAll(/\['(alloc\.[A-Za-z0-9]+|neutrality\.[A-Za-z0-9]+)',/g)].map((m) => m[1]!);
    const all = [...new Set([...fields, ...pairs])];
    expect(all.length).toBeGreaterThan(30);
    const unmapped = all.filter((f) => formKeyForIssue(f) === null && f !== 'rules');
    expect(unmapped).toEqual([]);
  });
});

describe('the presets', () => {
  it('produce rules the route reads and the SDK accepts, once the issuer fills in their own amounts', () => {
    for (const p of RULE_PRESETS) {
      const form = { ...applyRulePreset(p), ...(FILL[p.id] ?? {}) };
      const built = buildRules(form, units);
      expect(built.errors, p.id).toEqual({});
      const rules = parseRules(built.json ?? {});
      expect(checkRules(ctx(p.id === 'stock-reopen' ? STOCK_GRID : {}), rules), p.id).toEqual([]);
    }
  });

  it('are refused by the SDK for exactly what they leave to the issuer, and not for anything else', () => {
    const codes = (id: string, over: Record<string, unknown> = {}) => {
      const p = RULE_PRESETS.find((x) => x.id === id)!;
      return checkRules(ctx(over), parseRules(buildRules(applyRulePreset(p), units).json ?? {})).map((i) => i.code);
    };
    expect(codes('none')).toEqual([]);
    expect(codes('hard-to-game-ending')).toEqual([]);
    expect(codes('anti-flip')).toEqual([]);
    expect(codes('small-buyers-first')).toEqual(['CLASS1_CAP']);
    expect(codes('stock-reopen', STOCK_GRID)).toEqual(['GRID_ESTIMATE', 'MOVE_ANCHOR']);
    expect(codes('oracle-median')).toEqual(['QUORUM', 'SPREAD']);
    // and the needs a preset names are real: take the thing it relies on away and the SDK says so
    const filled = (id: string, over: Record<string, unknown>) => {
      const p = RULE_PRESETS.find((x) => x.id === id)!;
      return checkRules(ctx(over), parseRules(buildRules({ ...applyRulePreset(p), ...(FILL[id] ?? {}) }, units).json ?? {})).map((i) => i.code);
    };
    expect(filled('small-buyers-first', { gateMint: null })).toContain('CLASS1_GATE');
    expect(filled('anti-flip', { supplyMode: SupplyMode.Escrow })).toContain('CLASSES_NEED_MINT');
    expect(filled('oracle-median', { oracleFeedId: null })).toContain('ORACLE_SET_NEEDS_GUARD');
    expect(filled('hard-to-game-ending', { closeTs: OPEN + 600n })).toContain('ENDING');
  });
});

describe('the route', () => {
  const serve = () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message, ...err.detail }) : reply.code(500).send({ error: String(err) })));
    registerRulesTx(app, { account: async () => null, lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 1n }), clock: () => 1_800_000_000 });
    return app;
  };
  // the body the wizard sends: the create-cross body plus `rules` and `calendar`
  const createBody = (rules: ReturnType<typeof rulesBodyPart>) => ({
    creator: WALLET, baseMint: OTHER, quoteMint: GATE, baseTokenProgram: '11111111111111111111111111111111', quoteTokenProgram: '11111111111111111111111111111111', crossId: '1', kind: 'launch', supplyMode: 'mint', disclosure: 'sealed',
    minPrice: '1000000', tick: '50000', ticks: 40, priceScale: '1000000', openTs: OPEN.toString(), closeTs: CLOSE.toString(), revealEndTs: (CLOSE + 1800n).toString(), minMatched: '0', maxImbalanceBps: null, integratorFeeBps: 0, integrator: WALLET, shards: 4, maxOrders: 1000,
    proceedsTo: WALLET, schedule: [{ price: '1200000', quantity: '1000000000' }], gateMint: GATE, ...rules,
  });

  it('answers the wizard’s body for a preset with the verdict of checkRules, and names the field of a refusal', async () => {
    const app = serve();
    const check = async (f: RulesForm) => JSON.parse((await app.inject({ method: 'POST', url: '/v1/rules/check', payload: createBody(rulesBodyPart(buildRules(f, units))) as never })).body);
    const good = await check({ ...applyRulePreset(RULE_PRESETS.find((p) => p.id === 'hard-to-game-ending')!) });
    expect(good).toEqual({ ok: true, issues: [] });
    const refused = await check(cloneRulesForm({ ...EMPTY_RULES_FORM, endingMins: '30', buckets: '1', drawnEnd: true }));
    expect(refused.ok).toBe(false);
    expect(refused.issues[0]).toMatchObject({ code: 'ENDING_DRAW', field: 'ending.randomEnd' });
    expect(formKeyForIssue(refused.issues[0].field)).toBe('drawnEnd');
    const tooLong = await check(cloneRulesForm({ ...EMPTY_RULES_FORM, endingMins: '300', buckets: '4' }));
    expect(tooLong.issues[0]).toMatchObject({ code: 'ENDING', field: 'ending' });
    expect(formKeyForIssue(tooLong.issues[0].field)).toBe('endingMins');
  });

  it('refuses a body whose rules carry a field the form never sends, so a typo cannot slip into a creation', async () => {
    const app = serve();
    const r = await app.inject({ method: 'POST', url: '/v1/rules/check', payload: createBody({ rules: { ending: { endingMins: 30 } } } as never) as never });
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/endingMins/);
  });
});

describe('the treasury terms the console shows', () => {
  it('are the flagship preset’s, to the day', () => {
    const p = flagshipExtParams({ revenueCredential: OTHER as Address, revenueSchema: OTHER as Address, assignmentCredential: OTHER as Address, assignmentSchema: OTHER as Address, revenueShareBps: 1000, revenueStart: 1n, recovery: OTHER as Address });
    const day = 86_400n;
    const F = FLAGSHIP_FACTS;
    expect([p.votePeriodSecs, p.timelockSecs, p.minLockupSecs, p.navPeriodSecs, p.streamSecs, p.roundSecs, p.payGraceSecs, p.disclosurePeriodSecs, p.windowSecs]).toEqual([F.votePeriodDays, F.timelockDays, F.minLockupDays, F.navPeriodDays, F.streamDays, F.roundDays, F.payGraceDays, F.disclosurePeriodDays, F.windowDays].map((d) => BigInt(d) * day));
    expect([p.quorumBps, p.thresholdBps, p.maxProposalBps, p.proposerMinBps, p.navCapBps, p.requestMinBps]).toEqual([F.quorumPct, F.thresholdPct, F.maxProposalPct, F.proposerMinPct, F.navCapPct, F.requestMinPct].map((x) => x * 100));
    expect(p.assignRequired).toBe(true);
  });
});
