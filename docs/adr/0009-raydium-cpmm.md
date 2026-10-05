# ADR-0009: Raydium CPMM adapter

Date: 2026-10-05 · Status: accepted · Builds on ADR-0007

## Decision
`cross_settle::seed_raydium_cpmm` lets the cross creator open a Raydium constant-product (CPMM) pool for the cross's market after it clears. A CPMM pool's opening price is the ratio of its two initial deposits, so the adapter accepts the deposit only if `quote = base · P* / price_scale` rounded either way, i.e. the pool prices the base at P\* to within one quote atom. Raydium orders the pool's mints by key, so the base may be token 0 or token 1; the adapter maps amounts accordingly. Fee tier (AMM config) and open time are the issuer's choice.

## Evidence
LiteSVM against the mainnet `raydium_cp_swap` binary plus Raydium's mainnet AMM config (index 0) and pool-fee receiver accounts, dumped at test time (`tests/fixtures/fetch.sh`): vault balances price the base at exactly P\*; a real `swap_base_input` of 10 tokens returned 11.93 quote against 12.00 at P\* (0.25% fee plus impact); a skewed deposit and non-creators are refused.

## Lesson
The first run failed with "Instruction references an unknown account" because the SPL Token program ID had been hand-typed wrongly in two places, which derived a non-existent LP-token account (and made `token-safety` reject every classic SPL mint). Both now import the ID from `@solana-program/token`, and a live USDC read covers it (ENGINEERING_PRINCIPLES §3.8).
