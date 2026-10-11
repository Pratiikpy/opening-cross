# Devnet proof — volatility-aware DBC trading fees (ADR-0018)

Run: 2026-10-11T16:22:05.433Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/volatility-fee-proof.ts`
Design: base 100 bps fixed; the dynamic layer may add up to 100.00 bps once the price has moved 3% (filter 10 s, decay 30 s, variableFeeControl 114134, max volatility accumulator 2960000).
The fee of each swap is the change in the pool's three fee counters (protocol, partner, creator) divided by the amount in.

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| config | the config on chain carries the designed dynamic-fee parameters | PASS | [5bJcppUr…](https://explorer.solana.com/tx/5bJcppUr2HjFZ8QazugT1LYFJ5PwjRo9e3uy2EwiehYxDzGDWNFzC4G5dmDSi5ZRu2dzPoe4YyoCUoecqtJxTVQ7?cluster=devnet) | on chain: filter 10, decay 30, reduction 5000, variableFeeControl 114134, max accumulator 2960000 |
| calm | a tiny swap on a calm pool pays the base fee, within 0.5 bps | PASS | [2qjVGiSB…](https://explorer.solana.com/tx/2qjVGiSBqkC4oksvN851zCcBqCN748ZH2MjFWDxjTt5VvsmCkF74VUSibZp7ro7Sg1UrPfcrvLU6vkbY5fzVVBsC?cluster=devnet) | 100.00 bps against a base of 100 |
| burst-rises | during a burst that moves the price the fee rises above the base | PASS | [2EkZAD9Q…](https://explorer.solana.com/tx/2EkZAD9QYcZWVJjLDTn9Gh5eZE4SdubQMkANvfZi7XFbuCNPvWh1yVG7j1JjTU1Kn85vaKeH9kLKAja6nGRqG8wr?cluster=devnet) | peak 200.00 bps after the price moved 8511 bps in total |
| burst-grows | the fee grows as volatility accumulates within the burst | PASS | — | first 103.84 bps, last 200.00 bps |
| cap | no swap ever pays more than base plus the designed cap | PASS | — | highest 200.00 bps against a ceiling of 200.00 |
| decay | after the quiet period the volatility is reset, so the next swap pays close to the base fee | PASS | [2m4JM8a1…](https://explorer.solana.com/tx/2m4JM8a1yftEuYPKq5PAymcsviuvmfH6MCNMSVfgLJXmjAVFbYCsRSzfHACzrNYERx5m5Hsrs4T3hedtwStMH3NU?cluster=devnet) | second swap 101.66 bps (peak was 200.00); accumulator 2960000 before the quiet period, 380000 after |
| model | every swap paid base + dynamic fee at the accumulator stored before it, within 0.2 bps | PASS | — | 7 swaps, largest difference 0.012 bps |
| lag | finding: a swap pays for the volatility earlier swaps left behind, not for its own move; after a quiet period the first swap still pays the old rate | PASS | — | the swap that first moved the price paid 103.84 bps; the first swap after 30 s of quiet paid 200.00 bps (stored accumulator 2960000) and the next paid 101.66 bps |
