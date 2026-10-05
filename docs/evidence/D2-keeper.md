# D2 — Keeper evidence (2026-10-05)

`services/keeper`: a pure planner (`plan.ts`) decides the next permissionless step for a cross
from its on-chain state and the cluster clock — settle (merge shards, clear), abandon an expired
deferred-mint settlement, claim every open order (fills or refunds, always paid to the owner),
finalize. `runOnce` re-reads every account before acting, re-plans each cross until it stops
moving, and isolates failures per action. Discovery is the indexer (`fromIndexer`) or a
`getProgramAccounts` scan (`fromProgramAccounts`); neither is trusted.

## Local (LiteSVM)
`tests/core/test/keeper.test.ts` — two keepers with different payers race over a printed sealed
cross with an unrevealed bid, a no-print, and a deferred-mint launch whose settler never binds:
nothing happens before the reveal windows end; afterwards all reach Finalized, every order
account is closed, the unrevealed bidder, the no-print bidder and the abandoned-launch bidder are
refunded to the atom, the revealed buyer receives base, and two further passes find nothing to
do. A refused step (oracle-guarded cross with no price update) is reported while the rest of the
pass completes. Full suite: 17 files, 88/88 passed.

## Devnet
`services/keeper/scripts/devnet-pass.ts` discovered both devnet crosses through
`getProgramAccounts` and planned `finalize` and `settle`; devnet refused both with
`AccountOwnedByWrongProgram` (accounts `base_mint`, `shard`). Cause: the cross_core deployed on
devnet (slot 507686092) predates the current account layout, so crosses it created do not match
today's program. Upgrading needs a ~3.9 SOL buffer; the key holds 0.80 SOL and the CLI faucet is
rate-limited — HUMAN_TASKS H10. Devnet chaos run: PENDING H10.

## Scope notes
- Calendar sessions are not keeper work: creating a cross is the issuer's signed action, and
  `cross_calendar` binds it at creation (ADR-0011).
- Default-reveal decryption arrives with the encrypted-reveal path (Arcium, decision 3), which is
  not built yet; until then an unrevealed sealed bid is refunded in full, as tested above.
