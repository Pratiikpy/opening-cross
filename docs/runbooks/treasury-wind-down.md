# Treasury wind-down runbook

Scope: what an operator, a holder or an outsider can do to bring an ownership-coin treasury to an end and return the vault to holders.
Everything here is read from the program source (`programs/treasury/src`: `lib.rs`, `ext.rs`, `ops.rs`, `dist.rs`, `gov.rs`, `grants.rs`), not from
the design documents. It lists only steps the program supports. What it does not support is in the last section, so nobody plans around a feature that
is not there.

Two programs are described, and the difference matters:

- **The first release** (`HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd`, ADR-0014) is the one deployed on devnet. Six instructions: `create_treasury`, `spend`,
  `record_lapse`, `record_attested`, `trigger_liquidation`, `redeem`. A treasury it created is wound down by the steps below and **has no withdraw-only window
  and no sweep**: redemption never closes.
- **The extension** (ADR-0470 to ADR-0476) adds `init_ext` and the withdraw-only window with `sweep_unclaimed` (ADR-0474, row E7). It is built and proved on
  LiteSVM (`treasury-dist.test.ts`) and is **not deployed to devnet** until the operations key is funded (docs/HUMAN_TASKS.md H27); `GET /v1/programs` reports
  which release a cluster runs. A treasury has the window only if its team called `init_ext` with `windowSecs` above zero before holders relied on it.

Status: not audited, no mainnet deployment. The first-release steps were exercised on devnet with short test parameters in `docs/evidence/A5-treasury-devnet.md`
(allowance period 90 s, grace 45 s). Production-length parameters are the same code path with larger numbers and have not been run to completion. The window
cannot be run on a real clock short of 180 days; the LiteSVM test moves the clock.

## How a treasury can end

There is exactly one way, and the team cannot start it alone.

```
attestation stops being live  ->  anyone records the lapse  ->  grace period passes
  ->  anyone triggers liquidation  ->  every holder redeems  ->  (extended, with a window) anyone sweeps the rest
```

Nothing in the program lets the treasury authority (the team) end the treasury, pause it, or
liquidate it. The party that controls the first step is the one that issues the attestation, the
auditor (the holder of the Solana Attestation Service credential named in the treasury).

## Steps

Read the live state at any point from `GET /v1/treasuries/<treasury>` or the page
`/treasury/<treasury>`: state, recorded lapse and grace end, the attestation account and whether it is
live, vault balance, and the snapshot once taken. For an extended treasury `GET /v1/treasuries/<treasury>/ext` adds the terms and the window.

1. **The attestation stops being live.** The auditor either lets it expire or closes it. A treasury
   cannot be forced into this by the team or by holders. While the attestation is live the team can
   keep spending its allowance and nobody can record a lapse (`record_lapse` fails with
   `StillAttested`). The attestation is the account derived from `[credential, schema, treasury]`
   under the SAS program; its address is on the treasury page. Expiry `0` never expires.
2. **Anyone records the lapse.** Any wallet calls `record_lapse` with the treasury and the
   attestation account. It succeeds when the attestation is expired, closed or not owned by SAS, and
   stores the time once (later calls do not move it). From this moment the team cannot spend
   (`spend` fails with `NotAttested`). Client: `getRecordLapseInstruction` in
   `@opening-cross/treasury-client`.
3. **The grace period runs.** `grace_secs` is fixed at creation and shown on the page. If the auditor
   issues a new live attestation in this window, anyone may call `record_attested`, which clears the
   lapse and the treasury continues as before. Liquidation is refused until the grace has fully
   passed (`GraceNotOver`), and refused when no lapse is recorded (`NoLapse`).
4. **Anyone triggers liquidation.** After `lapsed_since + grace_secs`, any wallet calls
   `trigger_liquidation`. The program stores the vault balance and the coin supply at that moment as
   the snapshot and sets the state to `Liquidating`. From here spending is closed for good: `spend`,
   `record_lapse` and `record_attested` all fail with `Liquidating`, and a new attestation cannot
   revive the treasury.
5. **Holders redeem.** Each holder calls `redeem` with an amount of coins. The program burns them and
   pays `floor(snapshot_vault x amount / snapshot_supply)` quote atoms from the vault to the holder's
   quote token account. There is no registration. Rounding dust stays in the vault. In a first-release
   treasury there is no deadline. In an extended treasury with a window the deadline is below.
   Client: `getRedeemInstruction`; API: `POST /v1/treasuries/<treasury>/tx/redeem { holder, amount }`
   (409 `NOT_LIQUIDATING` before step 4, 409 `WOUND_DOWN` after step 6); a worked call is `redeem` in
   `tests/devnet/src/treasury-proof.ts`.

## The withdraw-only window (extended treasuries)

Set by the team once, in `init_ext` (`windowSecs`, `recovery`), and fixed from then on. The program refuses `init_ext` unless `windowSecs` is 0 (no window) or at
least 180 days (`MIN_WINDOW_SECS`) and `recovery` is not the default address. `POST /v1/treasuries/<treasury>/tx/init-ext` checks both before it builds anything
(`TERMS_INVALID`), and `GET /v1/treasuries/<treasury>/ext` shows the window and the recovery account (`terms.windDown`) before anyone buys.

What `trigger_liquidation` does to an extended treasury, in addition to the snapshot:

- the snapshot supply is the coin supply **minus the team grants not yet released** (`grants_unreleased`); anyone may burn those unreleased grant coins with
  `expire_grant`, which the program allows while the treasury is `Liquidating`, so no holder's share is left behind them;
- `wind_start` is set to the trigger time, and the NAV window (`nav_open`) is closed.

During the window (`wind_start` to `wind_start + windowSecs`) the program **refuses** with `Liquidating`: `stake`, `deposit_distribution`, `propose`,
`execute_proposal`, `nav_redeem`, `pay_round`, `release_tranche`, `create_grant`, `release_milestone`, `spend`, `record_lapse`, `record_attested` and `init_ext`.
It **keeps working**: `redeem`, `unstake`, `reclaim_vote`, `claim_distribution` (stakers' settled rewards come from the distribution vault, which the sweep never
touches), `mark_missed` and `expire_grant`. `vote` has no state check of its own, but no proposal can be executed any more.

6. **Anyone sweeps what holders never redeemed.** From `wind_start + windowSecs` any wallet calls `sweep_unclaimed` with the treasury, the quote mint, the
   treasury vault, the quote token program and a token account whose **owner is the recovery account fixed in `init_ext`** (anything else fails with
   `WrongRecovery`). It moves the **whole current balance of the treasury vault** to that account, once. Before the window ends it fails with `WindowOpen`; for a
   treasury without a window with `Disabled`; before liquidation with `NotLiquidating`; a second time with `AlreadySwept`.
   API: `POST /v1/treasuries/<treasury>/tx/sweep-unclaimed { payer }`, which answers 409 `WINDOW_OPEN` with `opensAt` while it is early, 409 `ALREADY_SWEPT`,
   409 `NOT_LIQUIDATING`, 422 `DISABLED`.
7. **After the sweep `redeem` is refused** with `WoundDown`, whatever the holder holds (the API answers 409 `WOUND_DOWN` with the recovery account). The
   leftover is the recovery account's, not the holders'.

Read the window from the API: `GET /v1/treasuries/<treasury>/ext` gives `terms.windDown` (`windowSecs`, `recovery`) and, once liquidating, `live.windDown`
(`start`, `sweepOpensAt`, `swept`).

## For the operator, in order

- Before step 1, tell holders in the disclosure feed (`POST /v1/treasuries/<treasury>/updates`, see
  the owner CLI in `services/api/src/routes/treasury-update-cli.ts`) that the treasury is winding
  down and what the auditor has been asked to do. The feed is a signed statement, anchored in a
  Memo; it has no effect on the program.
- Make sure the vault holds what the holders are owed before step 4. The snapshot is the vault at
  that moment.
- Do not send quote tokens to the vault after step 4: they are not part of the snapshot and nobody can redeem them. In a first-release treasury nothing moves
  them; in an extended treasury the sweep sends them, with the rounding dust, to the recovery account.
- Extended treasuries: the recovery account is the team's choice and the program does not constrain it. It should be controlled by the holders or be a burn
  address; an address the team controls lets the team collect what holders left unclaimed. Choose it before coins are sold, because `init_ext` runs once.
- Extended treasuries: tell holders the window's end date (`wind_start + windowSecs`) the day liquidation is triggered, and again before it closes. The program
  gives no further notice: after the sweep their coins can no longer be redeemed.
- After step 4, check `GET /v1/treasuries/<treasury>`: `state` is `Liquidating`, `snapshot` matches
  what you expect, and the `redeem-pro-rata` rights card reads "Open".

## What the program does not support today

Not in the six first-release instructions, nor in the extension's twenty (`init_ext`, `propose`, `vote`, `reclaim_vote`, `execute_proposal`, `nav_redeem`,
`stake`, `unstake`, `deposit_distribution`, `claim_distribution`, `pay_round`, `mark_missed`, `release_tranche`, `create_grant`, `release_milestone`,
`expire_grant`, `post_disclosure`, `request_disclosure`, `record_assignment`, `sweep_unclaimed`). Several are program changes, not operations.

- **Withdrawing before liquidation.** The window starts at `trigger_liquidation`. Before it there is no period in which spending is closed and holders can
  withdraw while the treasury stays open; the only early exit is the NAV window of an extended treasury (`nav_redeem`, capped per period, closed again at
  liquidation). Spending stops at the recorded lapse, but redemption at the snapshot starts only at liquidation, after the full grace period.
- **Pushing funds to holders.** A redemption burns the holder's coins, which needs the holder's signature, and the program does not know who holds what. The
  sweep is the nearest safe thing: money leaves the vault only after a window long enough for every holder to act, and it goes to the recovery account, not to the
  holders.
- **A window in a first-release treasury, or in an extended one whose team set `windowSecs` to 0.** Redemption then never closes and nothing sweeps.
- **Shortening, extending or moving the window,** or changing the recovery account, after `init_ext`.
- **A team-initiated or holder-initiated wind-down.** Neither can start step 1. A holder vote to liquidate does not exist.
- **Early or partial redemption** at the snapshot, or redemption before it.
- **A second snapshot.** Funds that arrive after liquidation are not in the snapshot (see the operator notes for where they end up).
- **Closing the treasury or vault accounts** to recover their rent after redemption.
- **Changing the authority, the allowance, the period, the grace or the attestation credential** at any time. Moving to a new auditor means a new treasury.
- **Pausing** the treasury.
- **Anything about the quote token itself.** If its issuer can freeze the vault or a holder's account, the program cannot prevent that.

Legal, tax and regulatory treatment of a wind-down is outside this runbook and the program.
