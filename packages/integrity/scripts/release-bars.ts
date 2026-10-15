// Measures every release bar that has a feature behind it and states, for each bar, PASS, FAIL or PENDING with the reason (V-A). Prints a JSON report; exits 1 when any bar FAILS and 0
// otherwise (PENDING is not a failure, and is never reported as a pass).
//
//   pnpm exec tsx scripts/release-bars.ts [--input <dir>]
//
// --input names a directory holding ratings.json, ovs.json and agents.json as written by `services/ratings bars-input`; without it those bars are PENDING with nothing to score.
// The language-model half of the AI bar runs only with ANTHROPIC_API_KEY (`packages/research/scripts/model-bars.ts`); without it that half is reported NOT RUN.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadClearing } from '../../clearing-wasm/src/index.js';
import { buildCorpus, gateOnlyInjections, measureGate, measureInjections, obedientModel, randomTable, runModelBars } from '../../research/src/index.js';
import { CONFORMANCE_SCHEMA, loadVectors, referenceImplementation, runConformance } from '../../verifier/src/index.js';
import { AnthropicLlm, LlmError } from '../../research/src/index.js';
import { type BarResult, agentBar, aiBar, botBar, buildBrief, ovsBar, ratingBar, reproducibilityBar, simulatorBar, type OvsRow, type RatingRow } from '../src/index.js';

const args = process.argv.slice(2);
const inputDir = args.includes('--input') ? args[args.indexOf('--input') + 1] : undefined;
const load = <T>(name: string): T[] => (inputDir && existsSync(join(inputDir, name)) ? (JSON.parse(readFileSync(join(inputDir, name), 'utf8')) as T[]) : []);

const bars: BarResult[] = [];

// Reproducibility: the published clearing vectors, reproduced by the TypeScript verifier and, independently, by the compiled Rust rule the program is built from.
{
  const vectors = loadVectors();
  // runConformance returns the cases that did NOT match.
  const ts = vectors.cases.length - runConformance(vectors, referenceImplementation).length;
  const rule = await loadClearing(readFileSync(new URL('../../clearing-wasm/clearing.wasm', import.meta.url)));
  let wasm = 0;
  for (const c of vectors.cases) {
    const p = rule.preview({ grid: { min: BigInt(c.grid.min), tick: BigInt(c.grid.tick), ticks: c.grid.ticks }, orders: c.orders.map((o) => ({ side: o.side, price: BigInt(o.price), quantity: BigInt(o.quantity) })), reference: c.reference === null ? null : BigInt(c.reference), minMatched: BigInt(c.guards.minMatched), maxImbalanceBps: c.guards.maxImbalanceBps });
    const ok = p.printed === c.expect.printed && (p.printed ? [String(p.price), String(p.matched), p.rationed ?? 'none'].join() === [c.expect.price, c.expect.matched, c.expect.rationed].join() && p.fills.map(String).join() === (c.expect.fills ?? []).join() : p.reason === c.expect.noPrintReason);
    if (ok) wasm += 1;
  }
  const both = Math.min(ts, wasm);
  bars.push({ ...reproducibilityBar({ total: vectors.cases.length, reproduced: both, source: `${CONFORMANCE_SCHEMA}: TypeScript verifier ${ts}, compiled Rust rule ${wasm}` }), reason: both === vectors.cases.length ? `all ${vectors.cases.length} clearing vectors reproduce exactly in two independent implementations (TypeScript verifier ${ts}, the compiled Rust rule ${wasm}). The metrics specifications (R12) and the fairness report are not covered by this check.` : `${vectors.cases.length - both} vector(s) differ (TypeScript ${ts}, Rust ${wasm}).` });
}

// AI summaries.
{
  const gate = measureGate(buildCorpus({ tables: 240, seed: 7 }));
  const brief = buildBrief({ cross: { address: 'X', kind: 'launch', state: 'Finalized', baseMint: 'B', quoteMint: 'Q', creator: 'C', ordersTotal: 40, protocolFeeBps: 30, clearing: null } });
  const inj = await measureInjections(obedientModel(), randomTable(() => 0.5), brief);
  const noSanitizer = gateOnlyInjections(randomTable(() => 0.5));
  let llm: AnthropicLlm | null = null;
  try {
    llm = new AnthropicLlm();
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
  }
  const model = await runModelBars(llm, { tables: 20, seed: 20261016, template: brief, injections: true });
  const r = aiBar({ gate: { sentences: gate.sentences, citationPrecision: gate.citationPrecision, numericAccuracy: gate.numericAccuracy, advicePublished: gate.advicePublished, injectionsPublished: gate.injectionsPublished }, injections: { cases: inj.cases, succeeded: inj.succeeded, model: inj.model }, modelRun: { status: model.status, ...(model.reason && { reason: model.reason }), injections: model.injections && { cases: model.injections.cases, succeeded: model.injections.succeeded } } });
  bars.push({ ...r, measured: { ...(r.measured ?? {}), gateFalseAccepts: gate.falseAccepts, gateFalseRejects: gate.falseRejects, gateOnlyInjectionsPublished: noSanitizer.published } });
}

// OVS, ratings and agents, from the observations the ratings service exports.
bars.push(ovsBar(load<OvsRow>('ovs.json')));
bars.push(ratingBar(load<RatingRow>('ratings.json')));
bars.push(agentBar(load<{ cross: string; agentQuote: string; totalQuote: string }>('agents.json').map((a) => ({ cross: a.cross, agentQuote: BigInt(a.agentQuote), totalQuote: BigInt(a.totalQuote) })), null));

// Bars whose feature does not exist.
bars.push(botBar(), simulatorBar());

console.log(JSON.stringify({ schema: 'opening-cross/release-bars/v1', generatedAt: new Date().toISOString(), bars }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
process.exit(bars.some((b) => b.status === 'FAIL') ? 1 : 0);
