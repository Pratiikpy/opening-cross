# Threat model

Scope: the on-chain programs (`cross_core`, `cross_gate`, `cross_settle`, `cross_calendar`), the
off-chain services that read and drive them (`services/indexer`, `services/keeper`,
`services/api`), and the web app. Each threat names its mitigation and the test that shows it.
Open gaps are listed at the end. They are not hidden in the rows above them.

## Assets

- Escrowed quote and base tokens in each cross's vaults.
- Mint authority of minting crosses (only the cross may create supply, and only at the clearing price).
- Integrity of the clearing price and of every fill.
- Sealed bids' confidentiality until reveal.
- Eligibility passes for gated crosses.
- Protocol and integrator fees.

## Actors

| Actor | Capability |
|---|---|
| Bidder | Signs their own orders, cancels and reveals. |
| Issuer | Creates a cross with fixed parameters and supplies base, or the mint authority. |
| Anyone | May merge, clear, claim (paid to the owner), abandon an expired settlement, finalize. |
| Protocol admin | Sets the fee schedule for **new** crosses and can pause; holds the calendar admin role behind a 7-day timelock. |
| Guardian | Can pause new crosses and orders. |
| Upgrade authority | Can replace program code. Today this is one devnet key (see gaps). |
| Settlement adapter (`settler`) | The only account allowed to bind a deferred base mint. |
| Off-chain operators | Run the indexer, keeper and API. They hold no protocol authority. |

## Threats and mitigations

| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T1 | Order outside the call window | `commit_order` checks `open_ts ≤ now < close_ts` | adversarial: "refuses orders before the call opens and after it closes" |
| T2 | Under-collateralised order | Escrow must cover `ceil(q·p/scale)` for buys and `q` for sells; prices must be on the grid | adversarial: "refuses prices off the grid and escrow that does not cover the order" |
| T3 | Book spam / compute exhaustion | `max_orders` cap; sharded books merged in separate transactions; compute measured | adversarial: "enforces the order cap"; `compute.test.ts` |
| T4 | Front-running a sealed bid | Only `sha256(cross‖owner‖nonce‖side‖price‖qty‖salt)` is on chain until the reveal window | adversarial: "rejects a reveal that does not match the commitment, and reveals outside the window" |
| T5 | Revealing or cancelling someone else's order | Owner signature required; order PDA bound to the owner | adversarial: "nobody else can reveal or cancel your order" |
| T6 | Clearing on a partial book | Clear requires every shard merged, after the reveal window; a shard merges once | adversarial: "cannot clear before every shard is merged, or merge a shard twice"; "cannot merge before the reveal window ends" |
| T7 | Wrong clearing price | `clearing-core` (ADR-0003) is the only clearing path. It is checked against an exhaustive reference (proptest), an independent TypeScript implementation, and 525 conformance vectors run on the program itself | `crates/clearing-core/tests/properties.rs`; `tests/core/test/conformance.test.ts` (523/523 on chain) |
| T8 | Paying a claim twice, or to the wrong account | The claim closes the order account and pays only the owner's token accounts; a stranger may crank it | adversarial: "a claim pays the owner even when cranked by a stranger, and only once" |
| T9 | Vault insolvency through rounding | Buys round up, sells down; a dust bond covers per-order rounding; vaults empty exactly at finalize | properties: "conserves every atom, empties the vaults" (25 randomized crosses); proptest `vault_never_short` |
| T10 | Issuer minting outside the cross | A minting cross must hold the mint authority; at finalize it is revoked (printed) or returned to the creator (no print) | adversarial: "mint mode requires the cross to hold the mint authority"; dbc: "mint authority revoked" |
| T11 | Deferred-mint settler never binds | Anyone may abandon after `settle_deadline_ts`; every order is refunded in full | deferred: "abandoned settlement refunds every bidder after the deadline, never before" |
| T12 | A rogue settler binds a mint | Only the registered `settler`, and only a mint whose authority is the cross | deferred: "only the registered settler can bind, and only a mint the cross controls" |
| T13 | Admin raises fees on a live cross | Fees are copied into the cross at creation; the schedule applies to new crosses only; protocol share ≤ 20% of total fees | fees: "a fee change never touches live crosses, and cancels and refunds are free"; "never above 20%" |
| T14 | Pause used to trap funds | Pause blocks new crosses and orders only; reveals, clears, claims and refunds always work | adversarial: "blocks new orders but never claims or refunds" |
| T15 | Ineligible wallet trades a gated cross | `cross_gate` pass required (allowlist, SAS attestation or Merkle proof); revocable when an attestation expires or is closed | gating: "only wallets holding a cross_gate pass may place orders"; `sas.test.ts` |
| T16 | Manipulated or stale oracle price on a reopen | Feed id pinned; both Pyth receivers checked; full verification and staleness required; out-of-band P* does not print | oracle: all five cases |
| T17 | Calendar changed at short notice | Every update and admin handover is behind a timelock of at least 7 days; the admin can cancel | calendar: all four cases |
| T18 | Settlement adapter opens a pool at a different price | Pool price derived from P* (Q64.64 sqrt price, DLMM bin) and checked before deposit | dbc, damm, dlmm, raydium tests (real mainnet binaries) |
| T19 | Indexer shows a state the chain does not have | The indexer ingests only finalized transactions; the reconciler compares every cross and order with chain accounts and records drift | `indexer.test.ts` (simulated lost event → 3 drift rows) |
| T20 | API serves a forged "cross" | Accounts are decoded only if owned by cross_core with the right discriminator | `api.test.ts` (byte-for-byte forged account → 404) |
| T21 | API used to steal funds | The API holds no keys and returns unsigned transactions; the wallet shows what it signs | design (D3); `api.test.ts` signer lists |
| T22 | Keepers racing each other | Every keeper action is permissionless and idempotent; duplicates fail harmlessly | `keeper.test.ts` (two racing keepers, each owner paid once) |
| T23 | Lost sealed-bid salt | The salt is stored before signing (or nothing is sent), and a downloadable backup is offered; an unrevealed bid is refunded in full | `investor-flow.mjs` (backup restore after storage wipe) |

## Open gaps (must close before mainnet)

1. **No external audit.** L2, HUMAN_TASKS H6.
2. **Single-key upgrade authority.** It must move to a Squads multisig with a timelock (L3) before L4.
3. **Public API rate limiting and abuse controls** are not implemented. They belong to the hosted deployment (L4), along with a WAF.
4. **Encrypted default reveal (Arcium)** is not built (decision 3). Until then, an unrevealed sealed bid is refunded rather than revealed by default.
5. **Oracle availability.** Reopen crosses with an oracle guard need fresh Pyth pull updates. Hermes requires an API key (H11).
6. **Devnet deployment** predates the current account layout and needs an upgrade (H10).
