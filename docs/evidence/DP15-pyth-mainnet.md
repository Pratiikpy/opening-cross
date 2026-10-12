# DP15 — Pyth price accounts on mainnet

Run: 2026-10-05T10:40:06.257Z · RPC https://api.mainnet-beta.solana.com (header corrected 2026-10-12: the run read mainnet accounts; the earlier header printed the shared devnet constant)
Script `tests/devnet/src/oracle-mainnet.ts`; feed ids from Hermes `/v2/price_feeds?asset_type=equity`
Accounts = push-oracle PDA `[shard 0 (u16 LE), feed_id]` under the pre-upgrade (`pythWSn…`) and upgraded (`pyt2F4…`) programs; parsed with `@opening-cross/sdk`, same layout as `cross_core::oracle`
A stale or missing push account is a finding, not a failure: crosses use the pull model (fresh update posted by the keeper), which needs a Pyth API key (HUMAN_TASKS H11).

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| Crypto.SOL/USD (control, sponsored) / pre-upgrade | owned by a Pyth receiver, parses, feed id matches, fully verified | PASS | — | 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE: $120.5167, age 24s, cross units (6dp quote, 8dp token, scale 1e8) 120516666 |
| Crypto.SOL/USD (control, sponsored) / upgraded | owned by a Pyth receiver, parses, feed id matches, fully verified | PASS | — | 7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE: $120.5362, age 0s, cross units (6dp quote, 8dp token, scale 1e8) 120536221 |
| Equity.US.NVDA/USD / pre-upgrade | owned by a Pyth receiver, parses, feed id matches, fully verified | PASS | — | 2w1Tg1XTZbUib7srfRoStJ4v5JXVsK7roQEGMsMaGZFC: $211.0150, age 3437118s (STALE — not usable by the guard), cross units (6dp quote, 8dp token, scale 1e8) 211015030 |
| Equity.US.NVDA/USD / upgraded | push account state recorded | PASS | — | BpsV4NCkHxC3FzykhvwMqo3Xkntm2EyPWdC92fVum1Xh: no sponsored push account |
| Equity.Index.NVDA/USD (24/7) / pre-upgrade | push account state recorded | PASS | — | HKN7Vmi1goKo6fboWRjUkaSgL51wzySEW9kRW6WRvsMN: no sponsored push account |
| Equity.Index.NVDA/USD (24/7) / upgraded | push account state recorded | PASS | — | DrMQPTkUTAWNtgxcgLQQDHXqq667AHzMvvsnpsCcXtju: no sponsored push account |
| Equity.US.TSLA/USD / pre-upgrade | owned by a Pyth receiver, parses, feed id matches, fully verified | PASS | — | E8WFH8brgP58arcuW2wwsPHiomYrSvrgWTsRLZLAEZUQ: $365.2750, age 2025605s (STALE — not usable by the guard), cross units (6dp quote, 8dp token, scale 1e8) 365275000 |
| Equity.US.TSLA/USD / upgraded | push account state recorded | PASS | — | Ayoy1gwnhWiycXt31Jj14MDPwnmcERXEg6zTybju8kYo: no sponsored push account |
| Equity.US.SPY/USD / pre-upgrade | owned by a Pyth receiver, parses, feed id matches, fully verified | PASS | — | 9owhtgrdLiUMAH9JKxYFt5pUY4Luy4EzzLhdcWPVuDyy: $765.4793, age 3437118s (STALE — not usable by the guard), cross units (6dp quote, 8dp token, scale 1e8) 765479260 |
| Equity.US.SPY/USD / upgraded | push account state recorded | PASS | — | 2Gejay6wFavogtNP8HifRscSEi85erznugWAkAty5zjw: no sponsored push account |
