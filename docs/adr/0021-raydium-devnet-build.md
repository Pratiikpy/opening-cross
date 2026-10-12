# ADR-0021: A devnet build of cross_settle for Raydium CPMM

Date: 2026-10-12 · Status: accepted · Builds on ADR-0009

## Context
`seed_raydium_cpmm` CPIs into Raydium's CPMM program, and the instruction pins that program with an address constraint (`raydium_program` = `CPMMoo8L…`, the mainnet deployment). Raydium has no deployment at that id on devnet; its devnet build (`devnet` cargo feature of raydium-io/raydium-cp-swap) is a different program, `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`, with a different pool-creation fee receiver (`3oE58BKV…`) and admin. The binary already deployed on devnet therefore refused every devnet attempt (recorded in the earlier version of `docs/evidence/A4-raydium-cpmm-devnet.md`), and the adapter could be proven only in LiteSVM.

## Decision
`cross_settle` gains a cargo feature, `devnet-raydium`, that changes exactly two things at compile time:

1. the Raydium program the constraint accepts (`RAYDIUM_CPMM_PROGRAM`: mainnet by default, `DRaycpLY…` with the feature);
2. the program's own id (`declare_id!`): `4nH5srCTtRFtJuHNmH2Q3x1TSMZ8w3VWBfX7PwwNMpJ5`, with the keypair in the git-ignored `.keys/cross_settle-devnet-raydium.json`.

The TypeScript builder takes a `RaydiumDeployment` (`RAYDIUM_MAINNET` by default, `RAYDIUM_DEVNET`), which carries the Raydium program, the fee receiver and the cross_settle id, and derives every Raydium PDA under the right program.

## Alternatives considered
- **Upgrade the deployed devnet program in place.** Costs no rent, but it replaces the binary that the DBC, DAMM v2 and DLMM proofs recorded, and it would make the devnet program differ from the mainnet source it is meant to mirror. Rejected: the proven record stays intact.
- **Store the Raydium program id in an account the issuer or an admin can set.** One binary for every network, but it turns the CPI target into mutable state, which widens the mainnet attack surface (the whole point of the constraint is that the target cannot be chosen by a caller). Rejected.
- **Leave Raydium to LiteSVM.** What shipped before. It proves the logic against the real binary but not the path on a live cluster (fee receiver, rent, clock, real swaps). Kept as the unit-level proof, now run for both deployments (`tests/core/test/raydium.test.ts`).

## Consequences
- The default build is unchanged in behaviour. It is not byte-identical to the binary deployed before this change, because the added lines shift the line numbers the compiler embeds: 35 bytes differ, measured by building the previous source and this one with the same toolchain. Mainnet must be built without the feature; a release check should assert that the feature is off.
- The devnet-raydium variant is a separate program (rent ≈ 1.83 SOL on devnet) and is upgraded separately.
- A pool created through it uses Raydium's devnet build; its figures say nothing about Raydium's mainnet fee receiver or admin, which `tests/core/test/raydium.test.ts` covers against the mainnet binary.

## Evidence
`docs/evidence/A4-raydium-cpmm-devnet.md` (live devnet run); `tests/core/test/raydium.test.ts` (6 tests: both deployments, each refusing the other's Raydium id).
