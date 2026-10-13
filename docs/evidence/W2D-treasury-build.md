# W2D: treasury extension, build, size, compute and test record

Status 2026-10-13: **proved on LiteSVM; devnet proof pending funding.** Nothing was deployed. Not audited.

## What was built

The `treasury` program gained 20 instructions, 5 account types and 20 events on top of its six original instructions, as an extension tail on the existing `Treasury` account plus new PDAs (ADR-0470 to ADR-0476). Rows: E1/E2, E3/VM8, E4, A6, E5, E6, E7, E8, V3/Y6; K4 and V6/R8 are decided in ADR-0476. Each row has its own file: `W2D-E1.md`, `W2D-E3.md`, `W2D-E4.md`, `W2D-E5.md`, `W2D-E6.md`, `W2D-E7.md`, `W2D-E8.md`, `W2D-V3.md`, `W2D-K4.md`, `W2D-V6.md`.

## Binary

| | Bytes | sha256 |
|---|---|---|
| Deployed on devnet (v1, `tests/fixtures/treasury_v1_devnet.so`) | 274,184 | `ce6b2b6174622a77d3767f8e5fe5542b1fac537e944cd169e53155a7317cee2c` |
| This build (`cargo build-sbf`, Agave 4.0.2, platform-tools v1.53, Rust 1.96.1 host) | 769,016 | recorded by `scripts/deploy-batch-2.sh` after the final build; the build is not yet a Docker verifiable build (NOT VERIFIED that the Docker image reproduces it) |

Devnet rent in this cluster is 5,080 lamports per byte (`solana rent` on 2026-10-13). Extending the program account by 494,832 bytes costs **2.514 SOL**; the upgrade buffer for the new binary holds 3.907 SOL while the deploy runs and is returned to the authority when it lands. Peak need on the operator key for this one program: about **6.45 SOL**, net cost about 2.52 SOL.

## Compute units (LiteSVM, `treasury-compute.test.ts`; bound in the test: 65,000)

init_ext 30,782 · propose 24,704 · vote 26,142 · execute_proposal 25,522 · reclaim_vote 20,803 · nav_redeem 34,992 · stake 39,279 · deposit_distribution 23,555 · claim_distribution 34,139 · unstake 38,681 · pay_round 45,755 · mark_missed 18,297 · create_grant 26,592 · release_milestone 25,495 · post_disclosure 7,067 · request_disclosure 8,558 · expire_grant 18,225. Largest: 45,755 (`pay_round`). Each fits one transaction with a wide margin.

## Commands run (WSL, Ubuntu-22.04)

| Command | Result |
|---|---|
| `cargo fmt -p treasury --check` | clean |
| `cargo clippy -p treasury --all-targets -- -D warnings` | clean |
| `cargo test -p treasury` | 13 passed (maths: `mul_div` against a 128-bit reference, NAV never dilutes, distributions never overpay, stream releases bounded and complete, quorum and majority, rounding) |
| `cargo build-sbf` in `programs/treasury` | builds, no warnings |
| `anchor idl build` then Codama (`packages/treasury-client`) | regenerated; `tsc --noEmit` clean for the client, `tests/core`, `services/indexer` |
| `vitest run` on `test/treasury.test.ts`, `treasury-ext`, `treasury-gov`, `treasury-dist`, `treasury-grants`, `treasury-compute` | 4 + 8 + 8 + 16 + 8 + 1 = **45 passed** |

## Mutation checks (the tests fail when the rule is broken)

Each of these was applied to the program, the program rebuilt, the relevant test file run, and the change reverted:

- NAV payout rounded up instead of down: `treasury-gov` "never dilutes the holders who stay" fails.
- The disclosure guard removed from `guard_team_outflow`: `treasury-grants` "a holder request starts a clock" fails.
- The stream not advanced before an unstake: `treasury-dist` "a coin staked just before a deposit and withdrawn just after earns almost nothing" fails.

## Upgrade compatibility

`treasury-ext.test.ts` operates a treasury with the deployed v1 binary, swaps in the new binary at the same program id, and continues (ADR-0470, Evidence). Account layout is unchanged for un-extended treasuries.

## Not covered

Devnet (pending the upgrade and funding; `tests/devnet/src/treasury-ext-proof.ts` is written and typechecks but **has not been run**); a Docker verifiable build of the new binary; an external audit; fuzzing beyond the property tests above; a real revenue attester or counsel; indexer, API and web support for the new accounts and events; the 180-day wind-down sweep on a real clock.
