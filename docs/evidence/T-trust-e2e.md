# Trust layer end to end (T1, T2, T3, T5 surfaces)

Run: 2026-10-11, WSL Ubuntu 22.04, Agave 4.0.2 local validator with the freshly built `cross_core` and `cross_gate`, Postgres 17, indexer + API + promiser + premium service + the production build of the web app, Chromium via Playwright.
Command: `MODE=trust CALL_SECS=150 sh tests/e2e/run-all.sh` (needs `AGAVE_BIN`, `DATABASE_URL`, `CHROME`).

## What ran

1. A fresh validator, a seeded open-book launch (the issuer offers 1,000 tokens at 1.20 and 1,000 at 1.50) and two buyers' real orders placed on chain (`tests/e2e/src/trust-seed.ts`).
2. The promiser signed bands while the call was open; the premium service measured nine real stock tokens on **mainnet** (Jupiter quotes against the HIP-3 oracle), independent of the local validator.
3. Browser pass, open phase (`apps/web/e2e/trust-flow.mjs`, **20/20** on the final run): the cross page shows the signed band and says in words why no coverage is claimed yet; the identity panel says plainly that the registry covers mainnet mints only; `/accuracy` totals equal the API; `/premium` coverage and a median equal the API; no horizontal overflow at 1440 and 390 px in light and dark; zero console errors, page errors or failed requests.
4. **A stranger's check, following the published instruction literally** (`pnpm --filter @opening-cross/promises verify <api>/v1/promises/<id> --signer … --inputs …`): the id and signature are valid for the published signer, the published book hashes to `inputsHash`, and the recomputed point equals the promised tick.
5. The cross was settled on chain (clearing price 1.5, 1,200 tokens matched). The promiser graded the band against the cross account.
6. Browser pass, settled phase (**24/24**): the page reports "The final price was exactly this estimate"; the track record counts the graded band and shows that a band that claimed no coverage is scored, never counted as a hit or a miss.
7. The verifier again with `--rpc`: `GRADE SCORED: cleared at tick 10, error 0 ticks, claimed [10, 10]`, read from the cross account on chain.

## What the first run found (fixed before this one)

- The signed band showed the raw machine reason (`NEED_9_SAMPLES_FOR_A_BOUNDED_BAND (have 0); SAMPLES 0<30; …`) to visitors; it now reads as a sentence, and the record keeps the code verbatim in the signed document.
- Three empty time buckets on the track record each printed a grid of dashes; an empty bucket is now one line.
- On a phone the premium tables clipped their right-hand columns; they now fit, and the multiplier column moves to wider screens.
- A zero-tick result read "0 ticks from this estimate"; it now says the final price was exactly the estimate.

## Not covered

- A calibrated band (30 graded crosses over two days are needed): the run produced one graded cross; the calibration path is covered by `tests/core/test/promiser.test.ts` (16 crosses with a scaled-down policy).
- The identity panel in its mainnet state is rendered by the real page from a recording of the real API's verdicts for a genuine xStock and an unrelated token (`apps/web/e2e/fixtures/authenticity-mainnet.json`), because no cross exists on mainnet. The API itself is tested over HTTP against mainnet reads (`services/api/test/authenticity.test.ts`).
- Premium sessions other than `closed` (Sunday).

Screenshots: `docs/evidence/screens/trust/` (cross, accuracy, premium × open/settled × desktop/mobile × light/dark).
