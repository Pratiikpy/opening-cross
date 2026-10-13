/**
 * Runner: sniper gain share on bonding curves versus the uniform-price call auction.
 *
 *   tsx run.ts [--n 200] [--nm 600] [--seed 0] [--sens] [--json]
 *
 * --n    runs per mechanism in the project scenario P   (R2: 200)
 * --nm   runs per mechanism in the memecoin scenario M  (R2: 600)
 * --seed first seed; run i uses seed + i. The same seeds are used for every mechanism.
 * --sens also run the one-at-a-time sensitivity grid over the assumed parameters
 * --json print the cells as JSON after the tables
 */
import { runCell, seedRange, type CellSpec, type CellSummary } from "./experiments.js";
import { SCEN_M, SCEN_P, type AuctionOptions, type Scenario } from "./params.js";
import { fmtInterval, pct } from "./stats.js";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
  return v;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const N_P = arg("n", 200);
const N_M = arg("nm", 600);
const SEED = arg("seed", 0);

function header(): void {
  console.log("| Mechanism | Bid / clearing variant | Runs (failed) | Sniper gain share, mean [95% CI] | Pooled | Median run | Runs with a sniper gain | Sniper share of sale | Price / fair (median) |");
  console.log("|---|---|---|---|---|---|---|---|---|");
}
function row(c: CellSummary): void {
  console.log(
    `| ${c.mech} | ${c.label} | ${c.runs} (${c.failed}) | ${fmtInterval(c.share, 3)} | ${pct(c.pooledShare, 3)} | ${pct(c.medianShare, 3)} | ${pct(c.runsWithFastGain, 1)} | ${pct(c.sniperShareOfSale.mean, 1)} | ${c.medianDiscRatio.toFixed(2)} |`,
  );
}

function cells(sc: Scenario): CellSpec[] {
  const uni = (label: string, auction: Partial<AuctionOptions>): CellSpec => ({ mech: "uniform", sc, label, auction });
  return [
    { mech: "pump", sc, label: "-" },
    { mech: "dbc_typ", sc, label: "-" },
    { mech: "dbc_as", sc, label: "-" },
    uni("R2 assumption (sniper bids 0.3-0.9 x issuer estimate), ADR-0003 clearing", {}),
    uni("R2 assumption, original budget-curve clearing", { clearing: "budget" }),
    uni("sniper bids like an informed bidder (fair x exp(N(0,0.1)))", { sniperBid: "sincere" }),
    uni("sniper bids exact fair value (perfect information)", { sniperBid: "oracle" }),
    uni("perfect information + bundle bids + hold 30 d (most favourable to snipers)", {
      sniperBid: "oracle",
      bundlersBid: true,
      sniperHoldDays: 30,
    }),
  ];
}

const all: CellSummary[] = [];
const t0 = Date.now();
console.log(`# Sniper gain share. Seed ${SEED}; project scenario ${N_P} runs, memecoin scenario ${N_M} runs per cell.`);
console.log(`# Node ${process.version}. Mean of the per-run share (R2 definition) with a 95% percentile bootstrap (1000 resamples).`);
for (const [sc, n] of [
  [SCEN_P, N_P],
  [SCEN_M, N_M],
] as const) {
  console.log(`\n## Scenario ${sc.name} (${sc.meme ? "memecoin" : "project, median fair FDV $5M"})\n`);
  header();
  for (const spec of cells(sc)) {
    const c = runCell(spec, seedRange(SEED, n));
    all.push(c);
    row(c);
  }
}

if (flag("sens")) {
  console.log("\n## Sensitivity: one assumed parameter at a time (project scenario P)\n");
  console.log("Ranges are chosen here (x0.2 and x5 around the original value); no source documents them, which is why they are varied.\n");
  header();
  const ns = Math.max(40, Math.round(N_P / 2));
  const variants: Array<[string, Partial<Scenario>]> = [
    ["sniperBudgetMed x0.2", { sniperBudgetMed: SCEN_P.sniperBudgetMed * 0.2 }],
    ["sniperBudgetMed x5", { sniperBudgetMed: SCEN_P.sniperBudgetMed * 5 }],
    ["bundlerBudgetMed x0.2", { bundlerBudgetMed: SCEN_P.bundlerBudgetMed * 0.2 }],
    ["bundlerBudgetMed x5", { bundlerBudgetMed: SCEN_P.bundlerBudgetMed * 5 }],
    ["retailBudgetMed x0.2", { retailBudgetMed: SCEN_P.retailBudgetMed * 0.2 }],
    ["retailBudgetMed x5", { retailBudgetMed: SCEN_P.retailBudgetMed * 5 }],
    ["nRetail x0.2", { nRetail: SCEN_P.nRetail * 0.2 }],
    ["nRetail x3", { nRetail: SCEN_P.nRetail * 3 }],
    ["curvePow 1 (flat arrival)", { curvePow: 1 }],
    ["curvePow 6 (very front-loaded)", { curvePow: 6 }],
    ["snipers in every launch (R2 section 7: mean 10)", { sniperPresence: 1, nSniper: 9 }],
    ["sniper exit median 600 s (R3 p90)", { sniperExitMedS: 600 }],
  ];
  for (const [name, patch] of variants) {
    const sc = { ...SCEN_P, ...patch };
    for (const spec of [
      { mech: "pump" as const, sc, label: name },
      { mech: "dbc_typ" as const, sc, label: name },
      { mech: "uniform" as const, sc, label: name },
      { mech: "uniform" as const, sc, label: `${name}; sniper bids fair value`, auction: { sniperBid: "oracle" as const } },
    ]) {
      const c = runCell(spec, seedRange(SEED, ns));
      all.push(c);
      row(c);
    }
  }
}

const worst = Math.max(...all.map((c) => c.maxLedgerResidualRel));
console.log(`\nQuote-conservation check: worst relative residual over every run = ${worst.toExponential(2)}`);
console.log(`Elapsed ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (flag("json")) console.log(JSON.stringify(all, null, 1));
