# Treasury wind-down runbook

Scope: what an operator, a holder or an outsider can do today, with the deployed treasury program
(`HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd`, source `programs/treasury/src/lib.rs`, ADR-0014), to
bring an ownership-coin treasury to an end and return the vault to holders. It lists only steps the
program supports. What it does not support is in the section after the steps, so nobody plans around
a feature that is not there.

Status: the treasury program runs on devnet, is not audited, and has no mainnet deployment. The
steps were exercised on devnet with short test parameters in `docs/evidence/A5-treasury-devnet.md`
(allowance period 90 s, grace 45 s). Production-length parameters (for example a 30-day period and a
7-day grace) are the same code path with larger numbers and have not been run to completion.

## How a treasury can end

There is exactly one way, and the team cannot start it alone.

```
attestation stops being live  ->  anyone records the lapse  ->  grace period passes
  ->  anyone triggers liquidation  ->  every holder redeems
```

Nothing in the program lets the treasury authority (the team) end the treasury, pause it, or
liquidate it. The party that controls the first step is the one that issues the attestation, the
auditor (the holder of the Solana Attestation Service credential named in the treasury).

## Steps

Read the live state at any point from `GET /v1/treasuries/<treasury>` or the page
`/treasury/<treasury>`: state, recorded lapse and grace end, the attestation account and whether it is
live, vault balance, and the snapshot once taken.

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
   quote token account. There is no deadline and no registration. Rounding dust stays in the vault.
   Client: `getRedeemInstruction`; a worked call is `redeem` in `tests/devnet/src/treasury-proof.ts`.
   The web app shows the snapshot and the redemption history but does not yet build a redeem
   transaction, so redemption today is by script or SDK.

## For the operator, in order

- Before step 1, tell holders in the disclosure feed (`POST /v1/treasuries/<treasury>/updates`, see
  the owner CLI in `services/api/src/routes/treasury-update-cli.ts`) that the treasury is winding
  down and what the auditor has been asked to do. The feed is a signed statement, anchored in a
  Memo; it has no effect on the program.
- Make sure the vault holds what the holders are owed before step 4. The snapshot is the vault at
  that moment.
- Do not send quote tokens to the vault after step 4: they are not part of the snapshot and the
  program cannot distribute them.
- After step 4, check `GET /v1/treasuries/<treasury>`: `state` is `Liquidating`, `snapshot` matches
  what you expect, and the `redeem-pro-rata` rights card reads "Open".

## What the program does not support today

Each of these is absent from the six instructions (`create_treasury`, `spend`, `record_lapse`,
`record_attested`, `trigger_liquidation`, `redeem`). Several are program changes, not operations.

- **A withdraw-only window.** There is no period in which spending is closed and holders can
  withdraw while the treasury stays open or before liquidation. Redemption opens only after
  `trigger_liquidation`. Adding one is a program change (a new state and instruction), and the
  program's upgrade authority would have to ship it. Until then, spending stops at the lapse, but
  redemption starts only at liquidation, after the full grace period.
- **A team-initiated or holder-initiated wind-down.** Neither can start step 1. A holder vote to
  liquidate does not exist.
- **Early or partial redemption,** or redemption before the snapshot.
- **A second snapshot.** Funds that arrive after liquidation, and the rounding dust, stay in the
  vault with no instruction that moves them.
- **A sweep of unclaimed funds,** or any deadline after which redemption closes.
- **Closing the treasury or vault accounts** to recover their rent after redemption.
- **Changing the authority, the allowance, the period, the grace or the attestation credential** at
  any time. Moving to a new auditor means a new treasury.
- **Pausing** the treasury.
- **Anything about the quote token itself.** If its issuer can freeze the vault or a holder's
  account, the program cannot prevent that.

Legal, tax and regulatory treatment of a wind-down is outside this runbook and the program.
