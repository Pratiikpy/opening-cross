// The metric registry: what each number the product reports means, written once. A spec is declarative and carries a content hash, so
// "version 2 of fill-rate" names exactly one definition; changing the definition without changing the version fails the tests, and a
// reader can check that the number on a page is the number the spec describes. Each spec points at where it is computed, and the tests
// confirm the route and the function it names exist.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type Json, canonicalize } from '@opening-cross/promises';

export type MetricStatus = 'measured' | 'experimental' | 'proposed';

export interface MetricSpec {
  readonly id: string;
  /** Bump when the definition, formula or inputs change. Never reuse a version for a different definition. */
  readonly version: number;
  readonly title: string;
  readonly status: MetricStatus;
  readonly definition: string;
  readonly formula: string;
  readonly unit: string;
  /** What one observation is, so a sample size means something. */
  readonly sampleUnit: string;
  /** Below this many observations the metric is shown with its sample size and no headline. */
  readonly minimumSample: number;
  readonly source: { readonly route?: string; readonly field?: string; readonly function: string; readonly file: string };
  readonly caveats: readonly string[];
}

export const SPECS: readonly MetricSpec[] = [
  {
    id: 'fill-rate',
    version: 1,
    title: 'Bid fill rate',
    status: 'measured',
    definition: 'Of all bids placed in finalized crosses that printed, the share that received any fill. A bid that was cancelled or never revealed counts as placed and not filled.',
    formula: 'bids with fill > 0 / bids placed',
    unit: 'share, 0 to 1',
    sampleUnit: 'bid',
    minimumSample: 30,
    source: { route: '/v1/metrics/execution', field: 'bids.fillRate', function: 'executionQuality', file: 'services/api/src/metrics.ts' },
    caveats: ['Devnet traffic is mostly the operator\'s own test wallets; see external-flow-share before reading this as user experience.', 'A bid priced far from the market is expected to go unfilled: the rate is not a quality score by itself.'],
  },
  {
    id: 'price-improvement',
    version: 1,
    title: 'Price improvement of a filled bid',
    status: 'measured',
    definition: 'For a filled bid, its own limit price minus the single clearing price it paid, as basis points of the limit. Reported as the median and the 10th percentile (nearest rank) over filled bids.',
    formula: '(limit - clearingPrice) / limit x 10000',
    unit: 'basis points',
    sampleUnit: 'filled bid',
    minimumSample: 30,
    source: { route: '/v1/metrics/execution', field: 'priceImprovement.bps', function: 'executionQuality', file: 'services/api/src/metrics.ts' },
    caveats: ['A bid placed exactly at the clearing price improves by zero by construction.'],
  },
  {
    id: 'refund-share',
    version: 1,
    title: 'Share of bid escrow returned',
    status: 'measured',
    definition: 'Per finalized cross, the share of bid escrow returned to bidders (the refund on claim plus escrow returned on cancel), summarised as median, minimum and maximum across crosses.',
    formula: 'escrow returned / escrow committed, per cross',
    unit: 'share, 0 to 1',
    sampleUnit: 'cross',
    minimumSample: 10,
    source: { route: '/v1/metrics/execution', field: 'refundShare', function: 'executionQuality', file: 'services/api/src/metrics.ts' },
    caveats: ['High is not good or bad in itself: it measures how much of what bidders put in was not needed.'],
  },
  {
    id: 'close-to-finalized-seconds',
    version: 1,
    title: 'Time from close to finalized',
    status: 'measured',
    definition: 'Seconds from a cross\'s close timestamp to the block time of its CrossFinalized event. Median, 90th percentile and maximum; crosses with an unreadable block time are excluded and counted.',
    formula: 'blockTime(CrossFinalized) - closeTs',
    unit: 'seconds',
    sampleUnit: 'cross',
    minimumSample: 10,
    source: { route: '/v1/metrics/execution', field: 'closeToFinalizedSeconds', function: 'executionQuality', file: 'services/api/src/metrics.ts' },
    caveats: ['Depends on a keeper being online: a stopped keeper shows up here as a long tail.'],
  },
  {
    id: 'top-buyer-concentration',
    version: 1,
    title: 'Largest-buyer concentration',
    status: 'measured',
    definition: 'The proportion of finalized crosses in which the largest single buying wallet took more than a threshold share (default 10%) of the buy-side fill, with a Wilson 95% interval taken over crosses.',
    formula: 'crosses where top-1 buy share > threshold / crosses',
    unit: 'proportion with 95% interval',
    sampleUnit: 'cross',
    minimumSample: 20,
    source: { route: '/v1/metrics/fairness', field: 'topBuyerAboveThreshold', function: 'fairness', file: 'services/api/src/metrics.ts' },
    caveats: ['Wallets are not people: one actor using many wallets looks more dispersed than it is. integrity funding clusters address part of this.'],
  },
  {
    id: 'external-flow-share',
    version: 1,
    title: 'Share of flow that is not ours',
    status: 'measured',
    definition: 'Wallets that are not in OWN_WALLETS and are not a cross\'s creator, proceeds recipient, integrator or fee recipient, as a share of all wallets with orders.',
    formula: 'external wallets / wallets',
    unit: 'share, 0 to 1',
    sampleUnit: 'wallet',
    minimumSample: 30,
    source: { route: '/v1/metrics/external-flow', field: 'wallets.externalShare', function: 'externalFlow', file: 'services/api/src/metrics.ts' },
    caveats: ['An upper bound on outside users: any wallet the operator runs that is not listed counts as external.'],
  },
  {
    id: 'print-rate',
    version: 1,
    title: 'Share of crosses that printed',
    status: 'measured',
    definition: 'Crosses that cleared or finalized with a clearing price, over all crosses indexed.',
    formula: 'crosses printed / crosses total',
    unit: 'share, 0 to 1',
    sampleUnit: 'cross',
    minimumSample: 20,
    source: { route: '/v1/stats', field: 'crosses_printed / crosses_total', function: 'buildServer', file: 'services/api/src/server.ts' },
    caveats: ['A cross that did not print because nothing crossed is working as designed, not failing.'],
  },
  {
    id: 'promise-coverage',
    version: 1,
    title: 'Coverage of signed clearing-price bands',
    status: 'measured',
    definition: 'Of signed promises of a clearing-price band that were scored, the share whose realised price fell inside the band, per confidence bucket, with a Wilson interval and the nominal coverage beside it.',
    formula: 'hits / (hits + misses)',
    unit: 'proportion with 95% interval',
    sampleUnit: 'scored promise',
    minimumSample: 30,
    source: { route: '/v1/accuracy', field: 'buckets[].coverage', function: 'report', file: 'packages/promises/src/accuracy.ts' },
    caveats: ['A band is CALIBRATED only after the gate in ADR-0015 is met; until then it is PROVISIONAL and says why.'],
  },
  {
    id: 'organic-volume-bounds',
    version: 1,
    title: 'Organic volume, lower and upper bound',
    status: 'experimental',
    definition: 'Lower: share of volume from bidders shown independent (a traced funder shared with no other bidder, no tie to the issuer). Upper: share of volume not shown inorganic (minus conflicted volume and cross-side funding-cluster self-trade). The truth lies between.',
    formula: 'independent volume / total; (total - conflicted - self-trade) / total',
    unit: 'basis points of volume, two bounds',
    sampleUnit: 'order, weighted by base atoms',
    minimumSample: 30,
    source: { route: '/v1/integrity/cross/:address/organic', field: 'lowerBps, upperBps', function: 'organicVolume', file: 'packages/integrity/src/organic.ts' },
    caveats: ['Not validated against labelled real wash trading. No Jito bundle data.', 'First-funder tracing only.'],
  },
  {
    id: 'conflicted-volume-share',
    version: 1,
    title: 'Volume from conflicted bidders',
    status: 'experimental',
    definition: 'Share of a cross\'s known volume carried by bidders tied to the issuer by evidence on chain (the issuer, its payee, a wallet it funded, or one that shares its funder).',
    formula: 'volume of flagged orders / volume of orders with known volume',
    unit: 'basis points of volume',
    sampleUnit: 'order, weighted by base atoms',
    minimumSample: 1,
    source: { route: '/v1/integrity/cross/:address/conflicts', field: 'flagged.volumeBps', function: 'findConflicts', file: 'packages/integrity/src/conflicts.ts' },
    caveats: ['A wallet that is not flagged is not proven independent.'],
  },
  {
    id: 'protocol-fee-revenue',
    version: 1,
    title: 'Protocol fee revenue, verified',
    status: 'measured',
    definition: 'Protocol and integrator fees of finalized crosses whose three sources agree to the atom: the cross counters run through the program\'s fee rules, the CrossFinalized event, and the finalize transaction\'s token balance changes. Lines that could not be verified are counted separately and never summed.',
    formula: 'sum of protocolFee over MATCH lines, per quote mint',
    unit: 'quote atoms per mint',
    sampleUnit: 'finalized cross',
    minimumSample: 1,
    source: { route: '/v1/fees/ledger', field: 'totals.verified', function: 'ledgerEntry', file: 'packages/fees/src/ledger.ts' },
    caveats: ['Devnet fees are of no monetary value. Revenue to the company is the share of these that reaches the fee wallet, which is a deployment fact.'],
  },
  {
    id: 'unit-economics',
    version: 1,
    title: 'Unit economics model',
    status: 'proposed',
    definition: 'Revenue and cost per issuer under stated assumptions, with sensitivity and break-even. Every input is a proposal; nothing in the repository measures willingness to pay.',
    formula: 'see docs/economics/FEE_MODEL.md',
    unit: 'USDC per issuer per month',
    sampleUnit: 'modelled issuer',
    minimumSample: 0,
    source: { function: 'model', file: 'packages/fees/src/model.ts' },
    caveats: ['A model, not a measurement. Run `pnpm --filter @opening-cross/fees model` to regenerate the figures.'],
  },
] as const;

/** The declarative content of a spec, in canonical form: what its hash is taken over. */
export function specContent(s: MetricSpec): Json {
  return JSON.parse(JSON.stringify(s)) as Json;
}
export const specHash = (s: MetricSpec): string => bytesToHex(sha256(new TextEncoder().encode(canonicalize(specContent(s)))));

/** The hash of a registry: any change to any spec changes it. */
export const registryHash = (specs: readonly MetricSpec[] = SPECS): string => bytesToHex(sha256(new TextEncoder().encode(specs.map((s) => `${s.id}@${s.version}:${specHash(s)}`).join('\n'))));

export function getSpec(id: string, version?: number, specs: readonly MetricSpec[] = SPECS): MetricSpec {
  const hit = specs.filter((s) => s.id === id && (version === undefined || s.version === version)).sort((a, b) => b.version - a.version)[0];
  if (!hit) throw new RangeError(`no metric spec "${id}"${version === undefined ? '' : ` at version ${version}`}`);
  return hit;
}

/** Whether a number may be shown as a headline, or only with its sample size. */
export function headlineAllowed(s: MetricSpec, n: number): boolean {
  return n >= s.minimumSample;
}

/** Problems in a registry: duplicate ids at a version, missing fields. An empty list means it is well formed. */
export function validateRegistry(specs: readonly MetricSpec[] = SPECS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    const k = `${s.id}@${s.version}`;
    if (seen.has(k)) problems.push(`${k} appears twice`);
    seen.add(k);
    if (!/^[a-z0-9-]+$/.test(s.id)) problems.push(`${k}: id must be lower-case words joined by hyphens`);
    if (!Number.isInteger(s.version) || s.version < 1) problems.push(`${k}: version must be a positive integer`);
    for (const f of ['title', 'definition', 'formula', 'unit', 'sampleUnit'] as const) if (!s[f].trim()) problems.push(`${k}: ${f} is empty`);
    if (!s.source.function || !s.source.file) problems.push(`${k}: source must name a function and a file`);
    if (s.caveats.length === 0) problems.push(`${k}: a metric states at least one caveat`);
  }
  return problems;
}

/** Markdown for docs/metrics/METRIC_SPECS.md, generated so the document cannot drift from the registry. */
export function renderSpecs(specs: readonly MetricSpec[] = SPECS): string {
  const out: string[] = [
    '# Metric specifications',
    '',
    'Generated by `pnpm --filter @opening-cross/metrics docs` from `packages/metrics/src/specs.ts`. Do not edit by hand; a test fails if this file differs from the registry.',
    '',
    `Registry hash: \`${registryHash(specs)}\``,
    '',
    'A metric is named by `id@version`. A change to a definition bumps the version; a version is never reused for a different definition. Below its minimum sample a metric is shown with its sample size and no headline.',
    '',
  ];
  for (const s of specs) {
    out.push(`## ${s.title} (\`${s.id}@${s.version}\`, ${s.status})`, '', s.definition, '', `- Formula: \`${s.formula}\``, `- Unit: ${s.unit}`, `- One observation is a ${s.sampleUnit}; headline from ${s.minimumSample} observations`);
    out.push(`- Computed by \`${s.source.function}\` in \`${s.source.file}\`${s.source.route ? `, served at \`${s.source.route}\`${s.source.field ? ` (\`${s.source.field}\`)` : ''}` : ''}`);
    out.push(`- Spec hash: \`${specHash(s).slice(0, 16)}\``, '', 'Caveats:', ...s.caveats.map((c) => `- ${c}`), '');
  }
  return out.join('\n');
}
