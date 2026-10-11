# ADR-0016: "Is this real?" token authenticity check

Status: accepted (2026-10-11)

## Context

A cross, a pool and a wallet all show a name and a ticker, and a name is the one thing an imitator can copy for free. A new token that calls itself `TSLAx` is not Backed's `TSLAx`, and a quote token that calls itself `USDC` is not Circle's. PRODUCT_FEATURES [F7] asked for a verified-original badge; this ADR defines what that badge is allowed to mean.

Alternatives considered:

| Option | Why not |
|---|---|
| Trust a token list (Jupiter strict, Solana token list) | Third-party curation, review lag, and a list entry says nothing about who holds the mint authority |
| Compare names and logos | Both are free to copy |
| The issuer's own list only | A listing cannot outrank the chain: a mistyped or compromised listing would produce a false pass |
| Issuer list **and** the issuer's keys on chain | An imitator can copy a name and an address shape but cannot hold the issuer's mint, freeze, pause and permanent-delegate authorities. Chosen |

## Decision

A package, `@opening-cross/authenticity`, with a registry snapshot, a pure classifier, a chain observer, API endpoints and a panel on the cross page.

**Registry** (`data/registry.json`, rebuilt by `pnpm --filter @opening-cross/authenticity refresh`). Built only from the issuers' own published sources, each stamped with its URL, fetch time and the SHA-256 of the response:

- xStocks (Backed): every page of `api.xstocks.fi/api/v2/public/assets`, the asset's Solana deployment: 1,319 mints on 2026-10-11.
- Ondo Global Markets: the token CSV linked from `docs.ondo.finance/addresses`, the "Solana Deployed Address" column: 451 mints.
- Canonical addresses: USDC and EURC (Circle docs), USDT (Tether), PYUSD (Paxos), each checked to appear on the issuer's page the run reads.

The refresh reads every listed mint on mainnet and fails if any is not a token mint. From those reads it derives each family's **rule**: the holders of the issuer powers (mint, freeze, pause, permanent delegate, scaled-UI-amount and transfer-hook authorities) across the family. On 2026-10-11 all 1,319 xStocks share one mint authority, one freeze/pause authority, one permanent delegate and one multiplier authority; all 451 Ondo mints share one authority for mint, pause, permanent delegate, multiplier and hook, with two freeze authorities.

**Verdicts** (identity only, never safety):

- `GENUINE`: the issuer lists the address **and** the chain's authorities match the family rule. A listed address whose authorities do not match is `UNKNOWN` (`CHAIN_CONTRADICTS_LISTING`): a listing never outranks the chain.
- `FAMILY_UNLISTED`: not listed, but held by the issuer's own keys on every power: likely a listing newer than the snapshot.
- `IMPERSONATOR`: unlisted, and its symbol is a genuine symbol or a marked form of a genuine ticker (`TSLA-x`, `TSLAon`, `xTSLA`), or its name copies an issuer's token name. Case, punctuation, other-script letters and invisible characters are folded first, and a fold that was needed is reported (`DISGUISED_CHARACTERS`).
- `ADDRESS_LOOKALIKE`: unlisted, and the first and last six characters match a listed mint (address poisoning).
- `UNVERIFIED_STOCK_TOKEN`: names the same company as a listed stock token with a generic stock word (`Common Stock`, `Tokenized`) but not the issuer's marker. A live sweep found a Backpack Securities token for Trump Media: another real issuer, not a copy, and not one the registry covers. It is reported as unverifiable, not accused.
- `UNRELATED_TOKEN`, `NOT_A_MINT`.

Guards against false accusations, each from a measured failure: symbols of three characters or fewer must match letter for letter (Ford's xStock is `Fx`; a coin `FX` is not a copy); a symbol that differs from a genuine one only by I/l or 0/o is a resemblance note, not a copy (`ALON` and `AIon`); a bare ticker is a collision note.

**Network.** The registry describes mainnet. On any other network the API returns `comparable: false` instead of a verdict that would call every devnet mint unrelated.

## Consequences

- The check is as good as the issuers' lists and key hygiene. If an issuer rotates its keys, its genuine mints fall to `UNKNOWN` until the registry is refreshed, which fails safe.
- Coverage is two stock issuers and four canonical stablecoins. Anything else is `UNRELATED_TOKEN`, and the page says what it checked, not that the token is safe.
- Redistribution terms for the issuers' lists are NOT VERIFIED (HUMAN H15). The snapshot is currently used only to answer the check.

## Verification

`packages/authenticity`: 24 tests, including every listed mint passing with its family fingerprint, every listed symbol caught when copied by an unlisted token, and a live mainnet pass over ten real issuer mints plus the top 100 organic tokens on Jupiter with no impersonator or lookalike flagged. `services/api/test/authenticity.test.ts` exercises the endpoints over HTTP against mainnet reads.
