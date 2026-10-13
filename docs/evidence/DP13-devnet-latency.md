# Devnet landing latency and settlement (DP13)

Run: 2026-10-13T04:26:06.763Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/latency-proof.ts`

Overall: **FAIL**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| endpoint-floor | the confirmation time of the public endpoint itself, measured with a plain self-transfer in the same way as a bid | PASS | — | n=20, p50 4555 ms, p90 17057 ms, p99 18043 ms, max 18043 ms |
| latency-sequential | sequential bids confirm within five seconds at the 90th percentile | FAIL | — | n=40, p50 4933 ms, p90 17105 ms, p99 18135 ms, max 18135 ms; 0.15 bids/s including build and read |
| throughput-concurrent | bids sent ten at a time all land | PASS | — | n=40, p50 32568 ms, p90 47664 ms, p99 48151 ms, max 48151 ms; 0.24 bids/s with ten in flight; 0 failed |
| settle | settling 80 bids took 5 transactions and the clearing price equals the independent reference | PASS | — | n=5, p50 1252 ms, p90 9410 ms, p99 9410 ms, max 9410 ms; P* 1000000 (reference 1000000), matched 3960000000 (reference 3960000000), total 15.4 s |

## Reading of the 2026-10-13 run

The target in `docs/ROADMAP.md` DP13 is bid confirmation at p90 of 5 s or less. **Not met on the public devnet endpoint (p90 17,105 ms), and NOT VERIFIED on a paid RPC** (none is configured; `docs/HUMAN_TASKS.md` H7, H17).

The new `endpoint-floor` step times a plain one-lamport self-transfer exactly as a bid is timed (blockhash, sign, send with preflight, poll to `confirmed`). It gave p50 4,555 ms and p90 17,057 ms. A bid gave p50 4,933 ms and p90 17,105 ms: 378 ms and 48 ms above the floor. Latency of a bid on this endpoint is therefore the endpoint's confirmation time; the program and the client add under 0.4 s at the median. A run earlier the same day (p50 4,653 ms, p90 5,297 ms) and the previous one (2026-10-11: p50 2,561 ms, p90 17,652 ms) show the same endpoint swinging between about 1 s, 5 s and 17 s per confirmation. The other two steps pass: 40 of 40 concurrent bids land, and settling 80 bids takes 5 transactions and prints the reference price (1,000,000) and matched volume (3,960,000,000).

The run costs about 0.4 SOL of the operator key. This section is written by hand; re-running the script rewrites the table above and not this text.
