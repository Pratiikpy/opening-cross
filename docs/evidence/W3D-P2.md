# W3D-P2: the claim path for partner trading fees (HD4), re-verified

Status 2026-10-14: **the claim path HD4 asked for is built; this file re-ran its tests.** Row P2 (share of trading fees via Meteora partner fees and fee sharing). No new program: `HD4` ("add a `claim_partner_fee` instruction to `cross_settle`") was built in wave 2D (`W2D-D7.md`, ADR-0480, ADR-0481), after `FEATURE_STATUS.md` row "P2 claim path for paid products" was written, so the row is stale.

## What was checked

`tests/core/test/settle-partner.test.ts` against the real Meteora DBC binary: **4 passed**. A buy of 100,000,000 atoms on a live pool at 1% fee accrued 1,000,000 atoms of fees; `claim_partner_fee` paid the partner's share exactly to the fee recipient's quote account; the settler PDA held nothing before or after; a second claim paid nothing; a destination owned by anyone but the fee recipient is refused (`WrongDestination`); a pool of another cross is refused; surplus and migration-fee withdrawals are refused before the curve completes. `cross_settle` contains `claim_partner_fee` (programs/cross_settle/src/lib.rs).

## FEATURE_STATUS row wanted

`| P2 claim path for paid products | PARTIAL | `cross_settle::claim_partner_fee` signs DBC's partner fee claim as the settler PDA and pays only to the fee recipient; 4 LiteSVM tests against the real DBC binary (`W2D-D7.md`, `W3D-P2.md`, ADR-0480, ADR-0481) | The upgrade that carries it is not deployed (H27); the creator-side bridge to a fee-sharing vault needs no program but is not wired; no keeper claims on a schedule; the fees of the paid API products (x402) are a separate off-chain ledger (`W2A-X6-x402-api.md`) |`

## Not covered

Devnet (the instruction is in the wave 2D `cross_settle` binary, which is not deployed); the pool-creation fee claim (built, not exercised: the test config has a zero creation fee); a positive partner surplus.
