# ADR-0474: withdraw-only wind-down window

Status: accepted (2026-10-13) · PRODUCT_FEATURES E7

## Decision

When a liquidation is triggered the extension stamps `wind_start`. Redemption (ADR-0014) stays open for the whole `window_secs` (at least 180 days, enforced when the treasury is extended). During it the treasury is withdraw-only: stakes, deposits, proposals, grants and spends are refused, while `redeem`, `unstake`, `reclaim_vote` and `claim_distribution` keep working. After the window anyone calls `sweep_unclaimed`, which moves what holders never redeemed to the `recovery` account named when the treasury was extended, once; `redeem` is then refused (`WoundDown`). The distribution vault is not swept: stakers' settled rewards stay claimable.

## What this is not

- The row says funds are "pushed back". The program cannot push: a redemption burns the holder's coins, which needs the holder's signature, and the program does not know who holds what. The sweep is the closest thing that is safe: the money leaves the vault only after a window long enough for every holder to act. NOT BUILT: pushing to holders.
- The recovery account is chosen by the team. It should be a holder-controlled multisig or a burn address; a team-controlled address would let the team collect what holders left unclaimed. The window and the account are visible in the tail before anyone buys.
- The "tested runbook" is the LiteSVM test (`treasury-dist.test.ts`, wind-down block). The devnet script covers everything but the 180-day wait, which no devnet run can compress.
