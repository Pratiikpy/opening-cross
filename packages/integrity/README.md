# @opening-cross/integrity

Integrity analysis: who holds a token and how the holders are connected, which bidders are tied to the issuer, an organic-volume interval, supply and backing checks, an open rating with its track record, and a cited brief whose claims can be checked.

| Module | Answers |
|---|---|
| `readHolders`, `labelOwner` | The largest holders, each labelled with the fact that justifies the label (mint authority, a pool authority constant from a protocol's IDL, an account owned by a protocol program, a burn address, a signed team list) |
| `traceFunding`, `clusterByFunding` | Where a wallet's first SOL came from; wallets that share a funder or funded one another. Funders that fund many wallets are services and are ignored, and listed |
| `findConflicts` | Bidders that are the issuer, its payee, funded by the issuer or sharing its funder, with the evidence |
| `organicVolume` | Version 0, experimental: a lower bound (shown independent) and an upper bound (not shown inorganic), never a single score |
| `coordinationLinks`, `bundleOf`, `jitoTipAccounts` | Orders placed in one transaction, or in a Jito bundle one of the two bidders paid for, link their owners (ADR-0950). The tip accounts are derived, never typed; the explorer keeps about seven days, and older is `unknown`, never clean |
| `organicGuard`, `organicTier`, `quoteVolume` | `pass`, `hold` or `fail` over the interval, and the lower bound in quote atoms for the graduation charter; the policy is data with a version |
| `analyzeCross` | The whole analysis of one cross, orders in and guard decision out, over injected sources |
| `pacedRpc`, `FileFundingCache`, `traceWallets`, `fundingBursts` | The mainnet funding trace as a job that finishes and resumes (below); wallets funded the same amount by different funders within minutes |
| `ovsBar`, `ratingBar`, `agentBar`, `aiBar`, `auc`, `ece` | The release-bar measurements (ADR-0954); `scripts/release-bars.ts` prints PASS, FAIL or PENDING for each bar and says which have no feature |
| `reconcileSupply`, `checkBacking` | A signed supply declaration against the mint and what crosses sold; a signed backing attestation for age, coverage and signer |
| `rateCross`, `trackRecord` | A published formula with unfitted weights; how ratings fared against outcomes, including "does not beat chance" and "insufficient sample" |
| `buildBrief`, `parseClaims`, `verifyClaims` | A brief of templates over cited facts; claims checked supported, contradicted or unverifiable. No language model |

Everything states its basis and its limits; an unlabelled wallet is a wallet, not a proven individual, and a wallet that is not flagged is not proven independent. Served by `services/api/src/routes/integrity.ts`. Evidence: `docs/evidence/W2A-F-integrity.md`; decision: `docs/adr/0302-integrity-analysis.md`.

## Tracing a mainnet token

`scripts/mainnet-holders.ts` labels the holders of a mainnet token and traces the funding of the wallets among them. It is read-only and finishes under public rate limits because it is paced, and resumable because every funding found is appended to a file the moment it is known.

```
pnpm exec tsx scripts/mainnet-holders.ts --mint <mint> --cache funding.jsonl --interval 700   --endpoint <paid endpoint> --endpoint https://api.mainnet-beta.solana.com
```

- Public endpoints refuse `getTokenLargestAccounts` or `getSignaturesForAddress` for some callers (the public mainnet-beta endpoint rate limits; publicnode answers 403 for the former; the Tatum public gateway answers anonymous callers some methods and refuses others). Put a paid endpoint first, then the public ones; `FailoverRpc` moves to the next on a refusal. Exit code 3 means some wallets are still untraced: run it again, it repeats no call.
- A wallet with a long history needs `--max-pages` raised (1000 signatures a page); with a Helius endpoint, `--ascending` reads the oldest transactions in one call instead (`getTransactionsForAddress`, `sortOrder: "asc"`; the request shape is from Helius's documentation and is NOT VERIFIED against a live key, HUMAN_TASKS H26).
- A funding found is final. "History too long" is not: a later run with a deeper `--max-pages` reads it again.
- The report names `fundingBursts`: wallets that each received exactly the same amount of SOL from different funders within minutes. First-funder tracing cannot see that pattern; it is a signal beside the clusters, never merged into them.

The Jito evidence has its own live check: `pnpm exec tsx scripts/jito-live.ts 40` compares the derived tip accounts with the block engine's and resolves live bundles back to themselves.
