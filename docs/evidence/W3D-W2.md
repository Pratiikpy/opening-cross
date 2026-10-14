# W3D-W2: the upgrade timelock (decision: checked from the chain; the single step is H13)

Outcome: **HUMAN (H13), tool built.** ADR-0660. Row W2, V-E.

`scripts/check-upgrade-timelock.mjs` reads the upgrade authority of every program in `Anchor.toml` on a cluster and, given the Squads multisig, checks that the authority is that multisig's vault 0 and that its time lock is at least `max-open-days` plus 72 hours. It reads only.

Run against devnet on 2026-10-14 (`node scripts/check-upgrade-timelock.mjs --cluster devnet`, exit status 1):

- `treasury`, `cross_gate`, `cross_core`, `cross_settle`, `cross_calendar`: upgrade authority `DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC` (the operations key), no time lock: FAILS.
- `cross_mandate`, `cross_conviction`, `cross_basket`, `cross_listing`, `cross_bounty`, `cross_backing`: not deployed.

That is the gap the row describes, measured. The multisig path (check the multisig address, the vault, the time lock) is exercised by the LiteSVM rehearsal (`governance.test.ts`, ADR-0013) and by the script's multisig branch on the same account layout; the script has not been run against a real Squads multisig because none exists yet (H13).

## FEATURE_STATUS row wanted

`| W2, V-E `cross_settle` adapters | PARTIAL | `open_dbc_pool` plus `bind_dbc_mint`, `seed_damm_v2`, `open_dlmm_pair`, `seed_raydium_cpmm`, and (wave 3D) `seed_futarchy_dao`; the upgrade timelock is checked from the chain by `scripts/check-upgrade-timelock.mjs` (ADR-0660), which reports today that all five deployed programs have a plain-key authority | The timelock is not enforced by a program, by decision (ADR-0660): the step is H13, the Squads handover, after which the script is the proof; [rest of the existing gap text] |`

Not covered: a run against a real multisig; the Squads handover itself.
