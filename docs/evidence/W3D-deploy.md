# W3D-deploy: sizes, SOL and deploy order for the Wave 3D programs

Status 2026-10-14: **nothing deployed** (H27: the operator holds about 2.86 SOL). Sizes are from the local `cargo build-sbf` binaries in `target/deploy`. Rent is estimated as `(size + 45 + 128) x 6,960 lamports`, the devnet rate; the scripts print the exact figures from the cluster before they spend anything. NOT VERIFIED on a cluster.

## Batch 2 (`scripts/deploy-batch-2.sh`): upgrades of programs already on devnet

| Program | New size (bytes) | Change |
|---|---|---|
| `cross_core` | 1,191,512 | fifth rule flag `FLAG_GOVERNED_GRADUATION` (ADR-0656) |
| `cross_settle` | 796,552 | governed-graduation gate on every seeding path, `seed_futarchy_dao` (ADR-0657), `open_fixed_price_presale` (ADR-0663) |
| `treasury` | 769,016 | unchanged by Wave 3D, listed because the batch carries it |

The script reads the local sizes at run time, so it needs no edit. The permanent cost is the extension, `(new size - on-chain size) x 6,960` lamports per program, plus a buffer for the largest binary that is returned when the upgrade lands; the script prints both and refuses to start when the balance is short. A full-rent upper bound for the three, if every byte were new: 8.29 + 5.55 + 5.35 SOL.

## Batch 3 (`scripts/deploy-batch-3.sh`): first deployment of seven new programs

| Program | Size (bytes) | Rent (SOL) |
|---|---|---|
| `cross_mandate` | 368,576 | 2.57 |
| `cross_conviction` | 270,408 | 1.88 |
| `cross_basket` | 263,424 | 1.84 |
| `cross_listing` | 322,720 | 2.25 |
| `cross_bounty` | 277,992 | 1.94 |
| `cross_backing` | 208,288 | 1.45 |
| `cross_graduate` | 329,576 | 2.30 |
| Total | 2,040,984 | 14.21 |


Permanent rent about 14.21 SOL; the largest buffer (`cross_mandate`, about 2.57 SOL) is held during its deploy and returned, so the peak is about 16.8 SOL plus fees. Add the batch 2 extension: the operator needs more than H27's 11 SOL to run both (NOT VERIFIED against live rent). Order: batch 2 first (the gate in `cross_settle` is what `cross_graduate` outcomes feed), then batch 3, then the devnet proof `pnpm --filter @opening-cross/devnet-proofs dp:w3d` (phase 2 a day later).

## Mutation checks for `tranche.rs` (B4)

Each change was applied, `cross_settle` rebuilt, `presale-tranche.test.ts` run, and the change reverted:

| Change | Result |
|---|---|
| `q_price` pin replaced by `true` | caught (refusals test fails) |
| presale-mode check replaced by `true` | caught |
| creator check removed | caught |
| floor changed to a ceiling in `q_price` | caught (both tests fail) |

## Local-validator proof

`docs/evidence/W3D-programs-local-validator.md`: 32 steps PASS on `solana-test-validator` with the programs loaded from `target/deploy` (basket mint and redeem, listing, bounty, mandate fill and exits, backing halt, conviction lock and badge mint, governed graduation gate and vote). Real transactions; the exits that wait days are not covered there and are proved on LiteSVM with a set clock. Run by `scripts/w3d-local-validator.sh`; phase 2 (conviction exit) needs a validator that has run a day and was not run.
