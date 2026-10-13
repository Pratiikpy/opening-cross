# @opening-cross/integrity

Integrity analysis: who holds a token and how the holders are connected, which bidders are tied to the issuer, an organic-volume interval, supply and backing checks, an open rating with its track record, and a cited brief whose claims can be checked.

| Module | Answers |
|---|---|
| `readHolders`, `labelOwner` | The largest holders, each labelled with the fact that justifies the label (mint authority, a pool authority constant from a protocol's IDL, an account owned by a protocol program, a burn address, a signed team list) |
| `traceFunding`, `clusterByFunding` | Where a wallet's first SOL came from; wallets that share a funder or funded one another. Funders that fund many wallets are services and are ignored, and listed |
| `findConflicts` | Bidders that are the issuer, its payee, funded by the issuer or sharing its funder, with the evidence |
| `organicVolume` | Version 0, experimental: a lower bound (shown independent) and an upper bound (not shown inorganic), never a single score |
| `reconcileSupply`, `checkBacking` | A signed supply declaration against the mint and what crosses sold; a signed backing attestation for age, coverage and signer |
| `rateCross`, `trackRecord` | A published formula with unfitted weights; how ratings fared against outcomes, including "does not beat chance" and "insufficient sample" |
| `buildBrief`, `parseClaims`, `verifyClaims` | A brief of templates over cited facts; claims checked supported, contradicted or unverifiable. No language model |

Everything states its basis and its limits; an unlabelled wallet is a wallet, not a proven individual, and a wallet that is not flagged is not proven independent. Served by `services/api/src/routes/integrity.ts`. Evidence: `docs/evidence/W2A-F-integrity.md`; decision: `docs/adr/0302-integrity-analysis.md`.
