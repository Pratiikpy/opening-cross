// A cited brief on a cross (J3), and a checker for claims about it. No language model is involved and no number is generated: every
// sentence is a template filled from facts this package holds, each with the metric it came from, and what is not known is said to
// be not known. A claim is checked against the same facts: supported, contradicted, or unverifiable because the fact is missing.
// Free-form text is parsed only for the few statements this module understands; every other sentence is returned as unparsed
// instead of being waved through.
import type { BackingResult } from './backing.js';
import type { ConflictReport } from './conflicts.js';
import type { HolderReport } from './holders.js';
import type { OrganicReport } from './organic.js';
import type { Rating } from './rating.js';
import type { SupplyReport } from './supply.js';

export interface BriefFacts {
  cross: {
    address: string;
    kind: string;
    state: string;
    baseMint: string;
    quoteMint: string;
    creator: string;
    ordersTotal: number;
    protocolFeeBps: number;
    clearing?: { price: bigint; matched: bigint; demand: bigint; supply: bigint } | null;
    noPrintReason?: string | null;
  };
  holders?: HolderReport | null;
  conflicts?: ConflictReport | null;
  organic?: OrganicReport | null;
  supply?: SupplyReport | null;
  backing?: BackingResult | null;
  rating?: Rating | null;
}

export interface Fact {
  value: bigint | string;
  /** Where it comes from: the account or route a reader can open. */
  source: string;
}

/** Every fact the brief and the checker can speak about, by metric name. */
export function facts(f: BriefFacts): Map<string, Fact> {
  const m = new Map<string, Fact>();
  const put = (k: string, value: bigint | number | string | null | undefined, source: string) => {
    if (value === null || value === undefined) return;
    m.set(k, { value: typeof value === 'number' ? BigInt(Math.trunc(value)) : value, source });
  };
  const c = f.cross;
  const acct = `chain:cross_core.Cross ${c.address}`;
  put('cross.kind', c.kind, acct);
  put('cross.state', c.state, acct);
  put('cross.ordersTotal', c.ordersTotal, acct);
  put('cross.protocolFeeBps', c.protocolFeeBps, acct);
  put('cross.creator', c.creator, acct);
  if (c.clearing) {
    put('cross.clearing.price', c.clearing.price, `${acct} .clearing`);
    put('cross.clearing.matched', c.clearing.matched, `${acct} .clearing`);
    put('cross.clearing.demand', c.clearing.demand, `${acct} .clearing`);
    put('cross.clearing.supply', c.clearing.supply, `${acct} .clearing`);
  }
  put('cross.noPrintReason', c.noPrintReason, acct);
  if (f.conflicts) {
    const s = `api:/v1/integrity/cross/${c.address}/conflicts`;
    put('conflicts.flaggedOrders', f.conflicts.flagged.orders, s);
    put('conflicts.flaggedVolumeBps', f.conflicts.flagged.volumeBps, s);
  }
  if (f.organic) {
    const s = `api:/v1/integrity/cross/${c.address}/organic`;
    put('organic.lowerBps', f.organic.lowerBps, s);
    put('organic.upperBps', f.organic.upperBps, s);
    put('organic.independentGroups', f.organic.breadth.independentGroups, s);
  }
  if (f.supply) {
    const s = `api:/v1/integrity/mint/${c.baseMint}/supply`;
    put('supply.onchain', f.supply.onchainSupply, s);
    put('supply.declared', f.supply.declaredSupply, s);
  }
  if (f.holders) {
    const s = `api:/v1/integrity/mint/${c.baseMint}/holders`;
    put('holders.issuerBps', f.holders.byKind.issuer?.shareBps ?? 0, s);
    put('holders.teamBps', f.holders.byKind.team?.shareBps ?? 0, s);
    put('holders.protocolBps', f.holders.byKind.protocol?.shareBps ?? 0, s);
    put('holders.coveredBps', f.holders.coveredBps, s);
  }
  if (f.backing) {
    put('backing.status', f.backing.status, `api:/v1/integrity/backing/${c.baseMint}`);
    put('backing.coverageBps', f.backing.coverageBps, `api:/v1/integrity/backing/${c.baseMint}`);
  }
  if (f.rating?.score !== null && f.rating?.score !== undefined) put('rating.score', f.rating.score, `api:/v1/integrity/cross/${c.address}/rating`);
  return m;
}

export interface Statement {
  text: string;
  /** The metrics the sentence is built from, with their values and sources. */
  cites: { metric: string; value: string; source: string }[];
}
export interface Brief {
  cross: string;
  statements: Statement[];
  /** What the brief cannot say, and why. */
  abstentions: string[];
  generated: 'template';
}

const pct = (bps: bigint | string) => `${Number(bps) / 100}%`;

export function buildBrief(f: BriefFacts): Brief {
  const m = facts(f);
  const st: Statement[] = [];
  const abstain: string[] = [];
  const cite = (...keys: string[]) => keys.filter((k) => m.has(k)).map((k) => ({ metric: k, value: String(m.get(k)!.value), source: m.get(k)!.source }));
  const need = (keys: string[], what: string): boolean => {
    const missing = keys.filter((k) => !m.has(k));
    if (missing.length) abstain.push(`${what}: not available (${missing.join(', ')}).`);
    return missing.length === 0;
  };
  const c = f.cross;
  st.push({ text: `This is a ${c.kind} cross with ${c.ordersTotal} orders, currently ${c.state}, charging a protocol fee of ${c.protocolFeeBps} bps.`, cites: cite('cross.kind', 'cross.ordersTotal', 'cross.state', 'cross.protocolFeeBps') });
  if (c.clearing) st.push({ text: `It cleared at a price of ${c.clearing.price} with ${c.clearing.matched} base atoms matched, against demand of ${c.clearing.demand} and supply of ${c.clearing.supply}.`, cites: cite('cross.clearing.price', 'cross.clearing.matched', 'cross.clearing.demand', 'cross.clearing.supply') });
  else if (c.noPrintReason) st.push({ text: `It ended without a price (${c.noPrintReason}).`, cites: cite('cross.noPrintReason') });
  else abstain.push('Clearing: the cross has not printed.');

  if (need(['organic.lowerBps', 'organic.upperBps'], 'Organic volume')) st.push({ text: `Between ${pct(m.get('organic.lowerBps')!.value as bigint)} and ${pct(m.get('organic.upperBps')!.value as bigint)} of volume is organic by the experimental version-0 measure, across ${m.get('organic.independentGroups')!.value} independent bidder groups.`, cites: cite('organic.lowerBps', 'organic.upperBps', 'organic.independentGroups') });
  if (need(['conflicts.flaggedOrders', 'conflicts.flaggedVolumeBps'], 'Conflicted bidders')) st.push({ text: `${m.get('conflicts.flaggedOrders')!.value} orders carry a conflict flag, ${pct(m.get('conflicts.flaggedVolumeBps')!.value as bigint)} of known volume.`, cites: cite('conflicts.flaggedOrders', 'conflicts.flaggedVolumeBps') });
  if (need(['holders.issuerBps', 'holders.teamBps', 'holders.protocolBps'], 'Holders')) st.push({ text: `Among the largest holders, the issuer holds ${pct(m.get('holders.issuerBps')!.value as bigint)} of supply, declared team wallets ${pct(m.get('holders.teamBps')!.value as bigint)} and protocol accounts ${pct(m.get('holders.protocolBps')!.value as bigint)}; the listed holders cover ${pct(m.get('holders.coveredBps')!.value as bigint)} of supply.`, cites: cite('holders.issuerBps', 'holders.teamBps', 'holders.protocolBps', 'holders.coveredBps') });
  if (f.supply) {
    for (const x of f.supply.findings.filter((x) => x.severity === 'high' || x.severity === 'warn')) st.push({ text: x.message, cites: cite('supply.onchain', 'supply.declared') });
  } else abstain.push('Supply: not available.');
  if (f.backing) st.push({ text: `Backing is ${f.backing.status}: ${f.backing.reasons[0] ?? ''}`.trim(), cites: cite('backing.status', 'backing.coverageBps') });
  if (f.rating?.score !== null && f.rating?.score !== undefined) st.push({ text: `Its version-0 rating is ${f.rating.score} out of 100, on ${f.rating.coverage} of 100 weight. The rating is not fitted to outcomes.`, cites: cite('rating.score') });
  else if (f.rating) abstain.push(`Rating: ${f.rating.reason}`);
  return { cross: c.address, statements: st, abstentions: abstain, generated: 'template' };
}

// -------------------------------------------------------------------------------------------------------- claims

export type Op = '=' | '<=' | '>=' | '<' | '>';
export interface Claim {
  id: string;
  metric: string;
  op: Op;
  value: string;
  /** The sentence it came from, if parsed from text. */
  text?: string;
}
export type Verdict = 'supported' | 'contradicted' | 'unverifiable';
export interface ClaimResult {
  claim: Claim;
  verdict: Verdict;
  actual?: string;
  source?: string;
  reason?: string;
}

export function verifyClaims(claims: readonly Claim[], f: BriefFacts): ClaimResult[] {
  const m = facts(f);
  return claims.map((claim) => {
    const fact = m.get(claim.metric);
    if (!fact) return { claim, verdict: 'unverifiable', reason: `No fact named ${claim.metric} is available for this cross.` };
    const actual = fact.value;
    if (typeof actual === 'string') {
      if (claim.op !== '=') return { claim, verdict: 'unverifiable', actual, source: fact.source, reason: 'Only equality can be checked on a text fact.' };
      return { claim, verdict: actual === claim.value ? 'supported' : 'contradicted', actual, source: fact.source };
    }
    let want: bigint;
    try {
      want = BigInt(claim.value);
    } catch {
      return { claim, verdict: 'unverifiable', actual: String(actual), source: fact.source, reason: `${claim.value} is not a whole number.` };
    }
    const ok = { '=': actual === want, '<=': actual <= want, '>=': actual >= want, '<': actual < want, '>': actual > want }[claim.op];
    return { claim, verdict: ok ? 'supported' : 'contradicted', actual: String(actual), source: fact.source };
  });
}

const PATTERNS: { re: RegExp; metric: string; op: Op }[] = [
  { re: /cleared at (?:a price of )?(\d+)\b/i, metric: 'cross.clearing.price', op: '=' },
  { re: /\b(\d+) base atoms (?:were |was )?matched/i, metric: 'cross.clearing.matched', op: '=' },
  { re: /\bmatched (\d+) base atoms/i, metric: 'cross.clearing.matched', op: '=' },
  { re: /\b(\d+) orders\b/i, metric: 'cross.ordersTotal', op: '=' },
  { re: /protocol fee of (\d+) ?bps/i, metric: 'cross.protocolFeeBps', op: '=' },
  { re: /\bat most (\d+) ?bps of volume (?:is|was|are) (?:from )?(?:flagged|conflicted)/i, metric: 'conflicts.flaggedVolumeBps', op: '<=' },
  { re: /\bat least (\d+) ?bps of volume (?:is|was) organic/i, metric: 'organic.lowerBps', op: '>=' },
];

/** Reads claims out of sentences. Sentences this module cannot read are returned in `unparsed`, never dropped. */
export function parseClaims(text: string): { claims: Claim[]; unparsed: string[] } {
  const claims: Claim[] = [];
  const unparsed: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  sentences.forEach((s, si) => {
    let any = false;
    for (const p of PATTERNS) {
      const m = p.re.exec(s);
      if (m) {
        claims.push({ id: `s${si + 1}.${claims.length + 1}`, metric: p.metric, op: p.op, value: m[1]!, text: s });
        any = true;
      }
    }
    if (!any) unparsed.push(s);
  });
  return { claims, unparsed };
}
