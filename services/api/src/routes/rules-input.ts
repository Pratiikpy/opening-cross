// The rules of a cross as JSON (the `rules` field of POST /v1/tx/create-cross-ruled), and the creation parameters that carry them.
//
// Every field is optional and means "off" when left out; the names are the ones in `docs/spec/OCIP-1.md` and `RulesConfig` of the SDK.
// Quote and base amounts are decimal strings (a safe integer is also accepted), basis points and seconds are integers, addresses are
// base58, feed ids are 32 bytes of hex. Unknown fields are refused.
import type { Address } from '@solana/kit';
import type { RulesConfig } from '@opening-cross/sdk';
import { RequestError } from '../tx.js';
import { addr, bool, hex32, i64, int, list, obj, only, opt, u64 } from './_inputs.js';

const sub = (b: Record<string, unknown>, k: string) => (b[k] === undefined || b[k] === null ? {} : obj(b[k], `rules.${k}`));

export function parseRules(raw: unknown): RulesConfig {
  const r = obj(raw, 'rules');
  only(r, ['flags', 'guards', 'ending', 'identity', 'alloc', 'neutrality', 'referral', 'oracleSet'], 'rules');
  const out: RulesConfig = {};
  if (r.flags !== undefined) out.flags = int(r.flags, 'rules.flags', 0xffff);

  const g = sub(r, 'guards');
  only(g, ['minRaiseQuote', 'maxMatched', 'totalSupply', 'minFloatBps', 'maxFdvX100', 'anchorPrice', 'moveBps', 'gridEstimate', 'haltSource'], 'rules.guards');
  out.guards = {
    ...(g.minRaiseQuote !== undefined && { minRaiseQuote: u64(g.minRaiseQuote, 'rules.guards.minRaiseQuote') }),
    ...(g.maxMatched !== undefined && { maxMatched: u64(g.maxMatched, 'rules.guards.maxMatched') }),
    ...(g.totalSupply !== undefined && { totalSupply: u64(g.totalSupply, 'rules.guards.totalSupply') }),
    ...(g.minFloatBps !== undefined && { minFloatBps: int(g.minFloatBps, 'rules.guards.minFloatBps', 0xffff) }),
    ...(g.maxFdvX100 !== undefined && { maxFdvX100: int(g.maxFdvX100, 'rules.guards.maxFdvX100', 0xffff_ffff) }),
    ...(g.anchorPrice !== undefined && { anchorPrice: u64(g.anchorPrice, 'rules.guards.anchorPrice') }),
    ...(g.moveBps !== undefined && { moveBps: int(g.moveBps, 'rules.guards.moveBps', 0xffff) }),
    ...(g.gridEstimate !== undefined && { gridEstimate: u64(g.gridEstimate, 'rules.guards.gridEstimate') }),
    ...(g.haltSource !== undefined && g.haltSource !== null && { haltSource: addr(g.haltSource, 'rules.guards.haltSource') }),
  };

  const e = sub(r, 'ending');
  only(e, ['endingSecs', 'buckets', 'cancelCutoffSecs', 'randomEnd', 'extensionMinSecs', 'extensionMaxSecs'], 'rules.ending');
  out.ending = {
    ...(e.endingSecs !== undefined && { endingSecs: int(e.endingSecs, 'rules.ending.endingSecs', 0xffff_ffff) }),
    ...(e.buckets !== undefined && { buckets: int(e.buckets, 'rules.ending.buckets', 255) }),
    ...(e.cancelCutoffSecs !== undefined && { cancelCutoffSecs: int(e.cancelCutoffSecs, 'rules.ending.cancelCutoffSecs', 0xffff_ffff) }),
    ...(e.randomEnd !== undefined && { randomEnd: bool(e.randomEnd, 'rules.ending.randomEnd') }),
    ...(e.extensionMinSecs !== undefined && { extensionMinSecs: int(e.extensionMinSecs, 'rules.ending.extensionMinSecs', 0xffff_ffff) }),
    ...(e.extensionMaxSecs !== undefined && { extensionMaxSecs: int(e.extensionMaxSecs, 'rules.ending.extensionMaxSecs', 0xffff_ffff) }),
  };

  const id = sub(r, 'identity');
  only(id, ['capQuote', 'maxOrders'], 'rules.identity');
  out.identity = {
    ...(id.capQuote !== undefined && { capQuote: u64(id.capQuote, 'rules.identity.capQuote') }),
    ...(id.maxOrders !== undefined && { maxOrders: int(id.maxOrders, 'rules.identity.maxOrders', 255) }),
  };

  const a = sub(r, 'alloc');
  only(a, ['reserveBps', 'smallCapQuote', 'lotteryUnit', 'minLockSecs', 'lockVestSecs', 'earlyUntilTs', 'priorityGate', 'class1CliffSecs', 'class1VestSecs'], 'rules.alloc');
  out.alloc = {
    ...(a.reserveBps !== undefined && {
      reserveBps: ((): [number, number, number] => {
        const v = list(a.reserveBps, 'rules.alloc.reserveBps', 3, (x, i) => int(x, `rules.alloc.reserveBps[${i}]`, 10_000));
        if (v.length !== 3) throw new RequestError(400, 'rules.alloc.reserveBps must hold three shares: small verified buyers, locked buyers, priority buyers');
        return [v[0]!, v[1]!, v[2]!];
      })(),
    }),
    ...(a.smallCapQuote !== undefined && { smallCapQuote: u64(a.smallCapQuote, 'rules.alloc.smallCapQuote') }),
    ...(a.lotteryUnit !== undefined && { lotteryUnit: u64(a.lotteryUnit, 'rules.alloc.lotteryUnit') }),
    ...(a.minLockSecs !== undefined && { minLockSecs: int(a.minLockSecs, 'rules.alloc.minLockSecs', 0xffff_ffff) }),
    ...(a.lockVestSecs !== undefined && { lockVestSecs: int(a.lockVestSecs, 'rules.alloc.lockVestSecs', 0xffff_ffff) }),
    ...(a.earlyUntilTs !== undefined && { earlyUntilTs: i64(a.earlyUntilTs, 'rules.alloc.earlyUntilTs') }),
    ...(a.priorityGate !== undefined && a.priorityGate !== null && { priorityGate: addr(a.priorityGate, 'rules.alloc.priorityGate') }),
    ...(a.class1CliffSecs !== undefined && { class1CliffSecs: int(a.class1CliffSecs, 'rules.alloc.class1CliffSecs', 0xffff_ffff) }),
    ...(a.class1VestSecs !== undefined && { class1VestSecs: int(a.class1VestSecs, 'rules.alloc.class1VestSecs', 0xffff_ffff) }),
  };

  const n = sub(r, 'neutrality');
  only(n, ['insiders', 'insiderCliffSecs', 'insiderVestSecs', 'bondQuote', 'challengeSecs'], 'rules.neutrality');
  out.neutrality = {
    ...(n.insiders !== undefined && { insiders: list<Address>(n.insiders, 'rules.neutrality.insiders', 8, (x, i) => addr(x, `rules.neutrality.insiders[${i}]`)) }),
    ...(n.insiderCliffSecs !== undefined && { insiderCliffSecs: int(n.insiderCliffSecs, 'rules.neutrality.insiderCliffSecs', 0xffff_ffff) }),
    ...(n.insiderVestSecs !== undefined && { insiderVestSecs: int(n.insiderVestSecs, 'rules.neutrality.insiderVestSecs', 0xffff_ffff) }),
    ...(n.bondQuote !== undefined && { bondQuote: u64(n.bondQuote, 'rules.neutrality.bondQuote') }),
    ...(n.challengeSecs !== undefined && { challengeSecs: int(n.challengeSecs, 'rules.neutrality.challengeSecs', 0xffff_ffff) }),
  };

  const ref = sub(r, 'referral');
  only(ref, ['referrer', 'shareBps'], 'rules.referral');
  out.referral = {
    ...(ref.referrer !== undefined && { referrer: addr(ref.referrer, 'rules.referral.referrer') }),
    ...(ref.shareBps !== undefined && { shareBps: int(ref.shareBps, 'rules.referral.shareBps', 0xffff) }),
  };

  const o = sub(r, 'oracleSet');
  only(o, ['extraFeeds', 'quorum', 'maxSpreadBps', 'offHoursWidenBps'], 'rules.oracleSet');
  out.oracleSet = {
    ...(o.extraFeeds !== undefined && { extraFeeds: list(o.extraFeeds, 'rules.oracleSet.extraFeeds', 2, (x, i) => hex32(x, `rules.oracleSet.extraFeeds[${i}]`)) }),
    ...(o.quorum !== undefined && { quorum: int(o.quorum, 'rules.oracleSet.quorum', 255) }),
    ...(o.maxSpreadBps !== undefined && { maxSpreadBps: int(o.maxSpreadBps, 'rules.oracleSet.maxSpreadBps', 0xffff_ffff) }),
    ...(o.offHoursWidenBps !== undefined && { offHoursWidenBps: int(o.offHoursWidenBps, 'rules.oracleSet.offHoursWidenBps', 0xffff_ffff) }),
  };
  return out;
}

const enumOf = (v: unknown, field: string, names: readonly string[]) => {
  const i = names.indexOf(String(v));
  if (i < 0) throw new RequestError(400, `${field} must be one of ${names.join(', ')}`);
  return i;
};

/** The creation parameters of `POST /v1/tx/create-cross`, parsed the same way (the fields are the same). */
export function parseCreateParams(b: Record<string, unknown>) {
  const schedule =
    b.schedule === undefined
      ? []
      : list(b.schedule, 'schedule', 64, (s, i) => ({ price: u64(obj(s, `schedule[${i}]`).price, `schedule[${i}].price`), quantity: u64(obj(s, `schedule[${i}]`).quantity, `schedule[${i}].quantity`) }));
  const oracle = opt(b.oracle, (o) => {
    const r = obj(o, 'oracle');
    return { feedId: hex32(r.feedId, 'oracle.feedId'), maxDivergenceBps: int(r.maxDivergenceBps, 'oracle.maxDivergenceBps', 10_000), maxStalenessSecs: int(r.maxStalenessSecs, 'oracle.maxStalenessSecs', 86_400) };
  });
  const baseMint = opt(b.baseMint, (x) => addr(x, 'baseMint'));
  return {
    creator: addr(b.creator, 'creator'),
    ...(baseMint && { baseMint }),
    quoteMint: addr(b.quoteMint, 'quoteMint'),
    baseTokenProgram: addr(b.baseTokenProgram, 'baseTokenProgram'),
    quoteTokenProgram: addr(b.quoteTokenProgram, 'quoteTokenProgram'),
    crossId: u64(b.crossId, 'crossId'),
    kind: enumOf(b.kind, 'kind', ['launch', 'reopen', 'tender', 'recurring']),
    supplyMode: enumOf(b.supplyMode, 'supplyMode', ['escrow', 'mint', 'deferred-mint']),
    disclosure: enumOf(b.disclosure, 'disclosure', ['sealed', 'open']),
    minPrice: u64(b.minPrice, 'minPrice'),
    tick: u64(b.tick, 'tick'),
    ticks: int(b.ticks, 'ticks', 65_535),
    priceScale: u64(b.priceScale, 'priceScale'),
    openTs: u64(b.openTs, 'openTs'),
    closeTs: u64(b.closeTs, 'closeTs'),
    revealEndTs: u64(b.revealEndTs, 'revealEndTs'),
    referencePrice: opt(b.referencePrice, (x) => u64(x, 'referencePrice')),
    minMatched: u64(b.minMatched ?? '0', 'minMatched'),
    maxImbalanceBps: opt(b.maxImbalanceBps, (x) => int(x, 'maxImbalanceBps', 10_000)),
    integratorFeeBps: int(b.integratorFeeBps ?? 0, 'integratorFeeBps', 300),
    integrator: addr(b.integrator, 'integrator'),
    gateMint: opt(b.gateMint, (x) => addr(x, 'gateMint')),
    shards: int(b.shards, 'shards', 32),
    maxOrders: int(b.maxOrders, 'maxOrders', 1_000_000),
    proceedsTo: addr(b.proceedsTo, 'proceedsTo'),
    schedule,
    oracle,
    calendar: opt(b.calendar, (x) => addr(x, 'calendar')),
    settler: opt(b.settler, (x) => addr(x, 'settler')),
    settleDeadlineTs: u64(b.settleDeadlineTs ?? '0', 'settleDeadlineTs'),
  };
}
