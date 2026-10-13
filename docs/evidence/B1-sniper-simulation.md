# B1: sniper gain share, bonding curves versus the uniform-price call auction

Date: 2026-10-13. Feature row B1. Status of the evidence: **a model result, not live data.** Nothing here observes a real call auction with snipers in it.

## 1. Verdict on the claim

The claim: *snipers capture about 0.03% of participants' gains under the uniform-price call auction versus about 10% on bonding curves* (project scenario), and 23-35% on curves in the memecoin scenario.

| Part of the claim | Original Python model | New TypeScript port (this document) | Verdict |
|---|---|---|---|
| Curves, project scenario, about 10% | pump.fun 10.5% [9.2, 12.0], DBC typical 10.4% [9.1, 11.8] | pump.fun 10.1% [8.6, 11.6], DBC typical 10.3% [8.8, 11.9] | **Reproduced**, CIs overlap |
| Curves, memecoin scenario, 23-35% | 22.7% / 26.5% / 34.6% (pump.fun / DBC typical / DBC anti-sniper) | 24.9% / 27.9% / 33.6% | **Reproduced**, CIs overlap |
| Uniform call auction, about 0.03% | 0.027% [0.010, 0.048] | 0.018% [0.004, 0.037] with the original clearing and assumptions; **0.22% [0.13, 0.32] under ADR-0003 quantity bids** | **Reproduced only under the original assumptions.** Not robust as a point value |
| Uniform is far below curves | yes | yes: at most 0.8% in every variant tested (section 6) | **Holds** |

So: the "about 10%" and "23-35%" curve figures hold. "About 0.03%" is the lowest value in a family of 0.02% to 0.8%; it depends on three assumptions that the original model makes and the documents do not evidence (section 5). What survives every variant is **"below 1%, one to two orders of magnitude under curves"**.

Proposed wording for PLAN.md, PRD.md and FEATURE_STATUS.md B1:

> In our agent-based launch model (research/R2_backtest.md, reproduced in packages/backtest/src/sniper), snipers and creator bundles capture about 10% of participants' gains on pump.fun and DBC-typical curves in the project scenario and about 25-34% in the memecoin scenario (mean of per-run shares; 5-12% weighted by dollars). Under a sealed uniform-price call auction they capture 0.02-0.4% in the base variants and at most 0.8% in every sensitivity case, because every winner pays the same clearing price. This is a model result, not an observation of live launches.

Do not keep "about 0.03%" as a headline figure. If a single number is wanted, use "under 1%".

## 2. What was in the repository, and whether it runs

FEATURE_STATUS B1 says the model "is not in the repository". It is: `research/scripts/sim/` holds `amm.py` (211 lines), `sim.py` (811), `mc.py`, `experiments.py`, `experiments2.py`, `quick.py`, `calib_*.py`, `diag_cca.py`; outputs are in `research/data/r2/` (`results_r3.json` is the current set).

- Python 3.11.9 is real (not a Store stub), numpy 2.4.6. No install was needed.
- `quick.py` (one seed, all mechanisms, both scenarios) ran in 3.6 s.
- A single-process rerun of seeds 0-199 (project) and 0-599 (memecoin) for pump, dbc_typ, dbc_as and uniform took 618 s and **reproduces `results_r3.json` exactly** (P|pump sniper gain share 0.10506873597819039 in both). So the stored outputs are what the code produces.
- What is correctly "NOT VERIFIED" is the model's relation to reality, not its existence.

Python reference output (not ported to TS: metadao, cca, `ours`): `packages/backtest/src/sniper/results/python-reference-seed0.json`, from `results/run_python_reference.py`.

## 3. The TypeScript model

Files in `packages/backtest/src/sniper/`:

| File | Content |
|---|---|
| `prng.ts` | xoshiro128** seeded through splitmix32; streams addressed by `(seed, ...ids)`; normal, lognormal, exact Poisson, exponential |
| `params.ts` | every parameter, one object per scenario, each with its source and a `sim.py:line` citation |
| `pool.ts` | constant-product pools with virtual reserves and fees, `cpCurve`, the DBC fee scheduler, a router (port of `amm.py`) |
| `clearing.ts` | ADR-0003 clearing on a tick grid in bigint atoms, the fill and payment-rounding rules, and the original model's budget-curve clearing |
| `population.ts` | latent value, issuer estimate, snipers, bundler, retail, informed, whales (port of `draw_launch`, `draw_population`) |
| `mechanisms.ts` | pump.fun, DBC typical, DBC anti-sniper, uniform call auction |
| `engine.ts` | sale then 30 days of hourly steps with event-driven trades, GBM fair value, flippers, holders, noise traders, arbitrageur; the metric; a quote-conservation ledger |
| `experiments.ts`, `stats.ts`, `run.ts` | cells, 95% percentile bootstrap, the runner |
| `sniper.test.ts` | 37 vitest tests |

**Metric**, as R2 section 2 defines it: sniper gain share = positive P&L of snipers and bundlers divided by the positive P&L of all participants, mark-to-market at day 30, per run; the cell value is the mean over runs with a 95% bootstrap CI (1000 resamples). Failed sales (raise below 30% of the issuer's estimate) are excluded, as in `mc.col(..., ok_only=True)`. The runner also prints the dollar-pooled ratio, the per-run median and the share of the sale the snipers hold.

**What the auction model does** (the structural point). A bidder can only bid. All winners pay one clearing price (tested per bidder: `spent / tokens` equals the price for every winner, snipers included). Nothing depends on arrival time (tested: shuffling the book changes neither the clearing nor any fill; equal marginal orders get equal fills). The creator bundle gets no early access. So a sniper's edge can only be (a) what it knows, expressed in its limit price, and (b) what it does with the allocation afterwards. The answer is not assumed: section 6 gives the sniper perfect information and a 30-day hold and still gets under 0.5% in the project scenario.

**Ported versus not.** Ported: pump, dbc_typ, dbc_as, uniform, both scenarios, the whole post-launch engine. Not ported: metadao, cca, `ours`, identity caps, late-whale and sybil switches (none enters the sniper metric for the four mechanisms compared). The PRNG is not numpy's, so runs are statistically comparable with the Python model, not bit-identical. Distribution check on the auction inputs over 3000 seeds: failed-sale rate 7.6% (TS) versus 8.4% (Python), median clearing price over fair 1.063 versus 1.063.

**Findings about the original model that the port exposed.**
1. The 0.03% is mostly driven by one assumption: in the auction, snipers bid `0.3-0.9 x` the issuer's estimate "hoping for a cheap clear" (`sim.py:387`), so they rarely win anything. Bidding at fair value roughly doubles the TS figure to 0.4%.
2. The creator bundle does not bid in the auction at all (`sim.py:266`, `sim.py:372`: bundlers are outside the buyer mask). The `bundlersBid` option lets it bid.
3. `farm_share=0.012` at `sim.py:82` sits inside a comment, so it is 0 in the original, as in the port.
4. R2 reports the uniform sale succeeding in 96.5% of runs. Over 3000 seeds the original population draw and clearing code gives 91.6% (253 failures; the TS port gives 92.4%). The 96.5% was a small-sample draw.
5. ADR-0003 as written does not "pick the lowest price at max volume" for a one-seller launch. Rule 2 (minimum imbalance) comes before rule 4 (lowest price), so against a single reserve seller the rule picks the highest tick that still sells out; "lowest" only breaks exact ties. Tests: `oversubscribed...`, `one large bid above supply...`, `exact match...`. Whether `clearing-core` and the on-chain program do the same was **not checked here**.
6. The mean of per-run shares and the dollar-pooled ratio differ a lot in the memecoin scenario (pump.fun 24.9% versus 5.2%): per-run shares are dominated by tiny launches where one bot is most of a very small total. Both are reported.

## 4. Parameters

Tags: R3 = `research/R3_wallet_behaviour.md`; R2 = `research/R2_backtest.md`; ASSUME = marked "ASSUME" in `sim.py` and listed as assumed in R2 section 10; FIT = from the original calibration scripts; PROTO = protocol constant. All `sim.py` lines are `research/scripts/sim/sim.py`. Everything lives in `params.ts` with the same comments. Any parameter whose source is ASSUME is a **sensitivity parameter**: no document gives an evidence base for the exact value.

| Parameter | Value | Source |
|---|---|---|
| Sniper presence | 18/35 launches | R3 section 4.1; `sim.py:52` |
| Snipers when present | 1 + Poisson(3.3) | R3, R2 section 0; `sim.py:52`, `121` |
| Sniper forced exit | lognormal, median 13.5 s, sigma 2.7 | R3 section 4.1 (73% < 60 s, p90 ~ 11 min); `sim.py:53` |
| Bundler probability, wallets | 0.5; 10 wallets, one identity | R2 section 2; `sim.py:56` |
| Bundler first swap on DBC anti-sniper | minimum fee | PROTO (R5); `sim.py:584` |
| Retail valuation | fair x exp(N(0.1, 0.6)) | R2 section 2; `sim.py:45` |
| Informed, whales | fair x exp(N(0, 0.1)), exp(N(0, 0.25)) | R2 section 2; `sim.py:49-50` |
| Project scenario value | median fair FDV $5M, sigma 1.0 | R2 section 1; `sim.py:73` (sigma ASSUME) |
| Flippers | 55% (project), 87.5% (memecoin), out within 24 h | R3 section 4.4, 4.1; `sim.py:46`, `79`, `549` |
| Holder hazard | 2.5%/day (project), 30%/day (memecoin) | R3 (62% in 7 d); `sim.py:65`, `85` |
| Retail fee tolerance, naive share | 5%, 20% | R2 section 2; `sim.py:48` |
| Issuer estimate | p* exp(N(0, 0.5)) | R2 section 2; `sim.py:68` |
| Auction | reserve 0.5 x estimate, 1% ticks, sale 25%, pro-rata at margin | R2 sections 2 and 8; ADR-0003 |
| Demand reduction | large bidders shade by market share | R2 section 2; `sim.py:381-386` |
| pump.fun | virtual 30 SOL / 1.073B, 793.1M on curve, 1.25% fee, then 0.3% pool | R2 section 2; `sim.py:226` (fee split ASSUME) |
| DBC typical | 0.25% fee, $5k to $75k mcap, 79% on curve, 0.2% migration | R1 (DATA), PROTO; `sim.py:234-254` |
| DBC anti-sniper | fee 99% to 1% over 15-60 one-second periods; project curve 0.25 to 2 x estimate | DATA (Jupiter Studio), R2 section 2; `sim.py:243`, `261` |
| Fair value after launch | GBM, drift -1%/day, 4%/day vol (project), 10%/day with decay (memecoin) | R2 section 2 (drift); vol ASSUME; `sim.py:62`, `83` |
| Horizon, step | 30 days, hourly | R2 section 2 |
| Retail budget | median $250 (project), $60 (memecoin), sigma 1.2 | ASSUME; `sim.py:44`, `79` |
| Retail count | 1500 (project); 60 x hype (memecoin) | ASSUME, FIT; `sim.py:73`, `78` |
| Informed / whale count and budget | 20 at $10k; 1 + Poisson(2) at $150k | ASSUME; `sim.py:49-50` |
| Sniper budget, take-profit steps, fee tolerance | $5k (project), $300 (memecoin); 0.3-2.0; 1-10% | ASSUME; `sim.py:54-55`, `82` |
| Bundler budget | $10k (project), $100 (memecoin) | ASSUME; R2 section 0 for the memecoin $100; `sim.py:56`, `82` |
| Curve arrival | t = 1 day x u^3 (project), u^10 (memecoin) | ASSUME; `sim.py:60`, `78` |
| Sniper bid in the auction | 0.3-0.9 x estimate | ASSUME; `sim.py:387` (varied here) |
| Auction clearing specification | quantity = budget / limit, ADR-0003 rule | ADR-0003 plus this port's reading; the original uses a budget curve (`sim.py:328-353`) |

Plausible ranges for the ASSUME parameters were varied one at a time at x0.2 and x5 around the original (retail count at x0.2 and x3). Those ranges are my choice and say nothing about the true values.

## 5. Commands

All run from the repo root. `packages/backtest` has no `package.json` (none was created, so the lockfile is untouched); the binaries come from the verifier workspace.

```
# tests (37 tests, about 15 s)
cd packages/verifier && ./node_modules/.bin/vitest run --root ../backtest src/sniper

# results table, seed 0, 200 project and 600 memecoin runs per cell, plus sensitivity grid (801 s here)
cd packages/verifier && ./node_modules/.bin/tsx ../backtest/src/sniper/run.ts --n 200 --nm 600 --seed 0 --sens

# typecheck with the repo TypeScript and tsconfig.base flags
cd packages/backtest && ../verifier/node_modules/.bin/tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --module NodeNext --moduleResolution NodeNext --target ES2023 --skipLibCheck --esModuleInterop --types node src/sniper/*.ts

# the original Python model, single process (about 11 minutes)
python packages/backtest/src/sniper/results/run_python_reference.py
```

`run.ts` flags: `--n`, `--nm`, `--seed`, `--sens`, `--json`. Seeds used: `seed + i` for run `i`, the same for every mechanism (common random numbers). Raw output of the run reported below: `packages/backtest/src/sniper/results/run-seed0-n200-nm600-sens.txt`. Environment: Node v22.17.0, Windows 11, vitest 5.0.3.

Not done: the `--sens` grid was not run in the memecoin scenario; the TS port was not run with other base seeds (the CIs describe sampling noise within seed 0..199 / 0..599).

## 6. Results (seed 0; project 200 runs, memecoin 600 runs per cell)

Sniper gain share, mean of per-run shares with 95% bootstrap CI. "Failed" counts sales that did not clear the minimum raise.

**Project scenario, median fair FDV $5M**

| Mechanism and variant | Failed | TS mean [95% CI] | Dollar-pooled | Median run | Sniper share of sale | Python original |
|---|---|---|---|---|---|---|
| pump.fun | 0 | 10.09% [8.64, 11.57] | 8.55% | 7.64% | 21.3% | 10.51% [9.18, 11.95] |
| DBC typical | 0 | 10.33% [8.77, 11.87] | 8.58% | 7.00% | 20.9% | 10.38% [9.09, 11.80] |
| DBC anti-sniper | 0 | 5.28% [4.03, 6.71] | 4.15% | 1.89% | 3.4% | 4.16% [3.38, 5.02] |
| Uniform, R2 assumptions, original budget-curve clearing | 20 | 0.018% [0.004, 0.037] | 0.016% | 0.00% | 0.3% | 0.027% [0.010, 0.048] |
| Uniform, R2 assumptions, **ADR-0003 quantity bids** | 33 | **0.219% [0.128, 0.322]** | 0.375% | 0.00% | 0.4% | not available |
| Uniform, sniper bids like an informed bidder | 33 | 0.425% [0.314, 0.549] | 0.505% | 0.00% | 0.7% | not available |
| Uniform, sniper bids exact fair value | 33 | 0.410% [0.280, 0.567] | 0.523% | 0.00% | 0.7% | not available |
| Uniform, fair-value bid + bundle bids + 30-day hold | 33 | 0.423% [0.268, 0.599] | 0.559% | 0.00% | 1.1% | not available |

**Memecoin scenario**

| Mechanism and variant | Failed | TS mean [95% CI] | Dollar-pooled | Median run | Sniper share of sale | Python original |
|---|---|---|---|---|---|---|
| pump.fun | 0 | 24.90% [21.95, 27.86] | 5.16% | 5.57% | 28.2% | 22.72% [19.86, 25.60] |
| DBC typical | 0 | 27.90% [24.73, 30.87] | 5.24% | 6.64% | 30.3% | 26.50% [23.63, 29.54] |
| DBC anti-sniper | 0 | 33.59% [30.29, 36.73] | 11.96% | 14.50% | 32.3% | 34.56% [31.59, 37.62] |
| Uniform, original clearing | 3 | 0.000% [0.000, 0.000] | 0.000% | 0.00% | 1.5% | 0.000% |
| Uniform, ADR-0003 quantity bids | 3 | 0.002% [0.000, 0.004] | 0.002% | 0.00% | 2.3% | not available |
| Uniform, sniper bids fair value | 6 | 0.093% [0.000, 0.235] | 0.002% | 0.00% | 1.6% | not available |
| Uniform, fair-value bid + bundle + 30-day hold | 6 | 0.181% [0.002, 0.503] | 0.010% | 0.00% | 2.3% | not available |

The wide variant spread in the project uniform rows is the point. Moving from the original clearing to ADR-0003 quantity bids lowers the clearing price (median price over fair 1.10 to 1.00; escrow of quantity times limit supplies less demand than a budget curve does), so more low-bidding snipers win. Giving snipers better information adds about 0.2 points. Nothing takes it above 0.6%.

**Sensitivity of the project scenario** (100 runs per cell; full table in the raw file). Curves stay between 6.7% and 16.1% across sniper budget, bundler budget, retail budget, retail count, arrival shape and sniper exit time x0.2 to x5; the highest uniform values are 0.79% (snipers in every launch, mean 10, as in R2 section 7) and 0.67% (retail budget x0.2, sniper bids fair value). Bundler budget does not move the uniform rows because the bundle does not bid by default (identical rows by construction). Curve arrival shape does not touch the uniform rows.

**Unit tests** (37, all pass; the clearing tests fail if the tie-break is changed, checked by mutation): PRNG determinism and moments; parameters equal the documented values; presence and count rule of the population draw; ADR-0003 on nine hand-computed books (oversubscribed, undersubscribed, exact match, one large bid, gap-tick infeasibility, no overlap, rationed sells), pro-rata dust (sum of fills + dust = supply, dust <= marginal orders) on 300 random books, order independence, payment rounding; the budget-curve clearing on a hand-computed pair; pump.fun full curve returns 793.1M tokens for about $12.75k; constant-product token and quote conservation over 2000 random trades; round trip loses money; graduation conserves quote; fee scheduler shape; one price for every auction winner; cost + refund = escrow; whole-run quote ledger balances to 2e-12 relative in every run of every mechanism (worst over the 11,000+ runs that cleared); same seed same output; common random numbers across mechanisms.

## 7. Limits and what is NOT verified

- **It is a model.** Participant behaviour is calibrated to aggregates from R1 and R3 (50 launches, 403 MetaDAO claimants); nothing in this repository observes a real call auction with snipers. Real snipers may behave in ways neither model has: coordinated sybil bidding across many wallets, bidding across several ticks, joining late through a different channel, or exploiting the commit-reveal reveal.
- **Calibration weaknesses carried over from R2 section 3 and 10:** pump.fun time to graduation 2x too slow; non-graduate tails overstated (25% trading on day 7 against 1.3% observed); MetaDAO survival not reproduced; valuations, budgets, issuer estimation noise and curve arrival are assumed; MEV, sandwiching, market-maker bots and vesting are not modelled; R3's bot flag is a lower bound and its sample is small.
- **The sniper share of tokens in R3 (23%) is a different measure** from the gain share; the model's sniper share of the sale (21% project, 28-32% memecoin on curves) is consistent with it but this is indirect, not a validation.
- **Time resolution.** Triggers run on arrival events and at hourly boundaries, so a 13.5 s exit executes at the next event, not at second 13.5 (inherited from the original).
- **The auction bid specification is not observed.** The ADR-0003 reading (one order per bidder, quantity = budget / limit) and the original budget curve are two bounds; how real bidders use `(limit, quantity)` orders on `cross_core` is NOT VERIFIED. Strategic bidding beyond the original's demand shading, and incentive compatibility, are not modelled (ADR-0003 itself says incentive compatibility is NOT VERIFIED).
- **Not checked:** that `clearing-core` and the program choose the same price as `clearAdr` on identical books (finding 5 in section 3). The TS port was not compared bit-for-bit with Python; agreement is statistical (overlapping CIs; one gap: DBC anti-sniper project scenario 5.3% against 4.2%, CIs overlap only between 4.0 and 5.0).
- **Not exercised:** seeds other than 0-599; the memecoin sensitivity grid; metadao, CCA and the recommended composite design (not ported); the `--json` output flag.
