# ADR-0951: The mainnet funding trace is a paced, resumable job, and says what it could not read

Date: 2026-10-16 · Status: accepted · Implements PRODUCT_FEATURES [F3] and [F8]; builds on ADR-0302

## Context
Holder labels and conflict flags were proved on devnet and on one mainnet token's holders, but the funding trace on mainnet stopped at a rate limit (HUMAN_TASKS H26). A trace is one `getSignaturesForAddress` and up to four `getTransaction` calls per wallet, so a cross with hundreds of bidders is thousands of calls against endpoints that refuse bursts and some methods outright. Re-running from scratch each time, or silently treating a wallet that could not be read as independent, would make the numbers wrong in the flattering direction.

Probed on 2026-10-16 against the token from the latest Meteora DBC transaction: the public mainnet-beta endpoint rate limits; publicnode answers HTTP 403 to `getTokenLargestAccounts`; the Tatum public gateway answers `getTokenLargestAccounts` but refuses `getSignaturesForAddress` to anonymous callers part of the time; Ankr, dRPC, OnFinality, Helius, NOWNodes and BlockEden need a key or a paid plan.

## Decision
1. `pacedRpc` serialises calls at a minimum interval shared by all workers and retries rate limits, timeouts and "no endpoint could answer" with a doubling wait; an error waiting cannot fix is thrown at once.
2. `FileFundingCache` appends each funding as it is found. A funding found is final; the one answer that is not is "history too long", which records how many pages were read (`pagesTried`) and is read again when a later run allows more pages. A torn last line costs one line.
3. `traceWallets` traces many wallets under a time budget, a few at a time, and returns which wallets are traced, which are unknown by history (not independent) and which are untraced with the reason. An untraced wallet is never an input to "independent".
4. `traceFunding` can ask for the oldest transactions in one call (`ascending`, Helius `getTransactionsForAddress` with `sortOrder: "asc"`) and falls back to paging when the method is not offered. The request shape is from Helius's documentation; it has not been run against a live key.
5. `fundingBursts` reports wallets that received exactly the same amount of SOL from different funders within a window, as a signal beside the clusters and never merged into them.
6. `scripts/mainnet-holders.ts` is the documented runbook (README): endpoints in order of preference, exit code 3 for "run again", the flags.

## Alternatives considered
- **A hosted indexer (Helius enhanced transactions, Dune, Flipside) as the primary source.** Faster, but a paid dependency whose output we cannot check against the chain; the trace reads the chain's own history and an indexer can be added as a faster first source behind the same interface.
- **Treat a wallet with a long history as independent.** A long-lived wallet is more likely a real user, but "more likely" is not a fact the interval may use. It stays unknown.
- **Retry forever.** A job that never ends hides which wallets it failed on; a budget and a named list do not.

## Consequences
- With public endpoints only, wallets with histories beyond a few thousand signatures stay untraced (measured: 4 of 12 holders of the test token; the Tatum gateway refused deep paging to anonymous callers and mainnet-beta rate limited it). A paid endpoint, or `--ascending` with a Helius key, is the human step (H26) and the only thing missing; the path is complete without it.
- Funding bursts will have false positives where many unrelated buyers fund fresh wallets with a round amount at a launch; that is why they are not clusters.

## Evidence
`docs/evidence/W5-1F.md`: a real run on mainnet token `9FkD18...` (12 largest wallet holders): 8 traced, each with a funder, of which 7 received exactly 1 SOL from seven different funders within 216 seconds (first-funder clustering found no cluster among them), and 4 untraced and named; a second run repeated no call (`fromCache 10`); `packages/integrity/test/ovs-guard.test.ts` covers pacing, retry, resume, torn lines, the time budget, deeper reads and the ascending path.
