# ADR-0552: A dry run before every signature, and the settle page

Status: accepted (2026-10-14). Builds on ADR-0480 to ADR-0487 and ADR-0505.

## Decision

1. **Dry run.** `IssuerAction` builds the unsigned transaction through the API, simulates the first one on the cluster (`simulateTransaction`, signatures not checked), and only then asks the wallet. A program that lacks the instruction answers `InstructionFallbackNotFound` (error 101, as the deployed programs do: `W3A-builders-devnet.md`); the page says that program is the first release and nothing was signed. Another program error is shown with its message. A cluster that cannot simulate gives "unknown", never a pass. This covers `cross_settle`, which `GET /v1/programs` does not report.
2. **Release notices** (`ProgramNotice`) say, from `/v1/programs`, whether the extension is live, is not live yet (and which step makes it live), or cannot be confirmed (the API does not answer, could not read the program, or does not report it). Only a read first release switches buttons off.
3. **`/issuer/settle`**: a table of what is live on devnet today against what comes with the upgrade; the issuer's crosses (or an address); the venue and partner payouts the indexer saw; the four partner payouts; the fees of protected liquidity (seven addresses); the greenshoe (create, place a level with a fresh limit-order key that signs next to the wallet and is never stored, settle a level, finish). The destination of a payout is the one the program fixed and the page shows it.
4. Open-pool instructions (batch-opened pools, Alpha Vault, Met Lock, locked continuation opening, badged pair) have no API route; the page says they are built with the SDK and offers no button.

## Needed from others

`GET /v1/programs` should also report `crossSettle`. `/issuer/settle` is not in `app/sitemap.ts`.
