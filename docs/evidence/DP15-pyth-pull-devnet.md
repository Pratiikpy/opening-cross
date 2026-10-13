# DP15 — Pyth pull update posted on devnet

Run: 2026-10-13T04:28:30.192Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/oracle-pull.ts`; Hermes https://pyth.dourolabs.app/hermes (API key); receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`

Overall: **FAIL**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| pull-post-nvda | fresh, fully verified 24/7 NVDA price posted and parsed exactly as cross_core will read it | FAIL | — | Hermes refused the equity feed: HTTP error! status: 403, body: Not entitled: feed a470c4ac46f44b547b2cba52338f311fb642b79375ce5f0cfd5cb5b99227b852 (no grant accepts this gated feed; it requires access to one of the following groups: ["pyth-indices"]) |
| pull-post-btc | fresh, fully verified BTC/USD (a feed the key is entitled to; proves the pull path itself) price posted and parsed exactly as cross_core will read it | PASS | [5MGTRQDc…](https://explorer.solana.com/tx/5MGTRQDcezfnGFrWPxwnPqCanMr9kNvNrkgAkWNNrxLCtEiVZdAhXUHTyq2pXJv8iadj6t1VKsiQZ9uE5cLKn9YU?cluster=devnet) | account EpJzBXjpigyz9WGEXqYcCEv9bCXneX5dwTHrB4vPCPwf; $83292.1415; age 3s; cross units (quote 6dp, token 8dp, scale 1e8) 83292141481 |

## Reading of the 2026-10-13 run

The 401 recorded on 2026-10-05 is gone: the script now reads the API key from `.secrets/pyth.env` and calls the upgraded Hermes endpoint `https://pyth.dourolabs.app/hermes`. The pull path itself works on devnet: a fresh Hermes update for BTC/USD was posted through the Pyth receiver, and `parsePriceUpdate` (the parser `cross_core` uses) read it back as owned by the receiver, full Wormhole verification set, the right feed id, age 0 s, and converted to cross units.

The 24/7 NVDA proof still **FAILS, for a reason outside the code**: Hermes answers HTTP 403 `Not entitled` for feed `a470c4ac…` because it needs the `pyth-indices` group, which this API key does not have. The same key was also refused (HTTP 403, "no grant accepts this feed") for the regular-hours equity feed `Equity.US.NVDA/USD` (`b1073854…`), the tokenized-stock feeds `Crypto.NVDAX/USD` (`4244d078…`) and `Crypto.NVDAON/USD` (`207ddea2…`), and the redemption rate `Crypto.NVDAX/NVDA.RR` (`b675c4e9…`); it is entitled to BTC/USD, SOL/USD, XAU/USD and EUR/USD (the ones tried). Fix: a Pyth Pro plan or grant that includes equity and index feeds (`docs/HUMAN_TASKS.md` H11), then re-run `pnpm --filter @opening-cross/devnet-proofs dp:oracle-pull`. The script needs no change for that; the NVDA step runs first and the BTC step stays as the mechanism check.
