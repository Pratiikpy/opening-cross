# Devnet landing latency and settlement (DP13)

Run: 2026-10-11T17:45:57.959Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/latency-proof.ts`

Overall: **FAIL**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| latency-sequential | sequential bids confirm within five seconds at the 90th percentile | FAIL | — | n=40, p50 2561 ms, p90 17652 ms, p99 17953 ms, max 17953 ms; 0.20 bids/s including build and read |
| throughput-concurrent | bids sent ten at a time all land | PASS | — | n=40, p50 33538 ms, p90 65669 ms, p99 68507 ms, max 68507 ms; 0.20 bids/s with ten in flight; 0 failed |
| settle | settling 80 bids took 5 transactions and the clearing price equals the independent reference | PASS | — | n=5, p50 916 ms, p90 17763 ms, p99 17763 ms, max 17763 ms; P* 1000000 (reference 1000000), matched 3960000000 (reference 3960000000), total 21.1 s |
