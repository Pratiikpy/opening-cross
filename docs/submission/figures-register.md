# Figures register

Every number used in the submission packs and video scripts, with its source. A number not in this table must not be spoken or written in a submission. If a source file changes, update the figure everywhere it is used (search this directory for the old value). "Live" figures change; read them at the moment of recording.

| Figure | Value | Source |
|---|---|---|
| Programs deployed on devnet and equal to local builds | 5 (`cross_core`, `cross_gate`, `cross_settle`, `cross_calendar`, `treasury`) | `docs/evidence/L4-verifiable-build.md` section 3 |
| Conformance vectors | 525 generated; independent reference reproduces 525; program reproduces 523 on LiteSVM, 0 mismatches | `docs/evidence/D5-conformance.md` |
| Verifier sweep, devnet | 48 cross accounts: 38 verified, 0 mismatched, 10 not yet cleared (run 2026-10-12T03:54Z) | `docs/evidence/D5-verifier-devnet-sweep.md` |
| Compute per bid | 21,633 CU for each of 100,000 orders (LiteSVM) | `docs/evidence/DP13-scale.md` |
| Settlement of 100,000 orders | 33 transactions, 783,740 CU total, 116,476 CU largest instruction | `DP13-scale.md` |
| Devnet landing latency | p50 2,561 ms, p90 17,652 ms vs 5,000 ms target: FAIL, public RPC | `docs/evidence/DP13-devnet-latency.md` |
| `open_dbc_pool` / `bind_dbc_mint` compute | 152,915 / 56,129 CU | `docs/evidence/A1-dbc-continuation-devnet.md` |
| DBC pool start sqrt price | 22592555198148962256 equals expected | `A1` step `open-dbc` |
| DBC swap | paid 50,000,000 quote atoms, received 32,999,998 base atoms (expected 33,000,000) | `A1` step `swap` |
| DAMM v2 pool at P* 1.3 | sqrt price 21032524265936792269 equals expected; swap error vs model 0.0000% | `docs/evidence/A2-damm-v2-devnet.md` |
| DLMM pair | active bin 262, bin step 10; bin price 1.299356 vs P* 1.3, off 0.0495% | `docs/evidence/A3-dlmm-devnet.md` |
| Dynamic fee | base 100 bps, peak 200 bps, after quiet 101.66 bps; 8,511 bps price move; 7 swaps within 0.012 bps of model | `docs/evidence/DP-volatility-fee.md` |
| Lighthouse | mobile 97, desktop 100 (performance) | `docs/evidence/W1-W2-web-landing.md` |
| Live crosses, 2026-10-12 | 51 opened, 38 with a clearing price (none of those has zero matched volume) | live `GET https://98-87-59-136.sslip.io/v1/stats` and `/v1/crosses` |
| A1 demo cross | `8U6zdtjTiJaoc2StMuEaf8jVwG3EJSEvVbzHxEJAppDx`: Settled, price 1.5, 2,500 tokens, 2 orders | live site page and `D5` sweep row (P* 1,500,000, 2,500,000,000 matched) |
| Fee schedule | 30, 5, 15, 30 bps; protocol fee is the smaller of schedule and a quarter of integrator fee | `docs/adr/0010-fee-model.md`, `docs/FEATURE_STATUS.md` row W4 |
| Third-party market facts | Jupiter found no route for IBMx at $10,000, $100 or $1 against a $1,666 pool on 16 Sep; weekend volume "billions" | `docs/evidence/DP10-reopen-novelty.md` (their measurement, not ours) |
| Contest dates | 14 Sep 06:00 PT to 12 Oct 23:59 PT 2026; winners by 5 Dec 2026 | Rules PDF section 5 |
| Superteam deadline | 2026-10-13T06:59:00Z | live listing API |
| Prizes | Colosseum: $30,000 / 20 x $15,000 / $5,000 / $5,000 / Solana track 10 x $10,000; Accelerator $250,000. Meteora 20,000 USDC (5). India 5,000 USDG (3) | Rules PDF section 14; live listing API |
| Accelerator acceptance | about 0.7% | colosseum.com/accelerator |
| Repository | 68 commits by one account, first 2026-10-05 (count at time of writing) | `git log` |

Not usable as figures (NOT VERIFIED): sniper share 0.03% vs 10% (simulation not in repo), Arcium sealed-bid scale and cost (DP9 not run), any mainnet or user count (none exists), any revenue (none).
