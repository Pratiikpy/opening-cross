# W3D-F6: automatic pause on missing backing (`cross_backing`), proved on LiteSVM

Status 2026-10-14: **program, client and tests built; proved on LiteSVM against the real `cross_core` halt machinery; not deployed (H27).** Not audited. ADR-0655. Row F6 (per-asset pause).

## What was built

A new program `HThrduwqRFvjHKPiQiRitsSw5yuGkXmAPkykAvMRQYkp` (208,288 bytes), 3 instructions (`create_policy`, `attest`, `check`), 3 events, 5 errors, and the client `@opening-cross/cross-backing-client`. The watchdog PDA `["watchdog", mint]` is the asset's venue signer in `cross_core`'s halt state; `check` (anyone) halts the asset when its attested backing is missing, older than the issuer's limit, or below the issuer's committed coverage of the live supply.

## Tests

- `tests/core/test/backing.test.ts`: **9 passed**. Opt-in needs the halt state's authority and a halt state that names the watchdog as venue signer (`Unauthorized`, `WatchdogNotVenueSigner`), coverage outside 1% to 200% and an age outside one minute to thirty days are refused, a policy is permanent. An asset nobody attested for is halted by a stranger's call; a fresh statement that covers the supply to the atom is not halted (`Backed`), one atom of new supply and it is; 150% coverage is measured against the live supply; a statement is stale one second past its age, not at it, and a fresh statement does not lift the halt; only the named attester can attest and the time is the chain's; another mint's accounts are refused. End to end: an ordinary cross for the halted mint ends `NoPrint(Halted)`, and a resume cross run by the issuer prints and lifts the halt.
- `cargo test -p cross_backing`: 3 passed (coverage exact at the boundary at several ratios, age checked before coverage, a future timestamp is not fresh).
- Mutation checks: staleness ignored -> 1 fails; coverage `<` changed to `<=` -> 3 fail; the stale boundary moved by one second -> 1 fails; the authority check removed -> 1 fails; the venue-signer check removed -> 1 fails; the attester check removed -> 1 fails; the live supply replaced by zero -> 2 fail.
- `cargo fmt --check`, `cargo clippy -D warnings`: clean.

## Compute units (LiteSVM)

create_policy 25,404 · check (with the halt call) 22,396 · attest 14,628.

## Size and deploy cost

208,288 bytes; program account rent 1.059 SOL (permanent) and a returned buffer.

## Not covered

Devnet; an existing halt state created with another venue signer (it cannot use the watchdog: the venue signer is set at creation); proof that a custodian holds what the attester signed (not claimed; the attester is the operator decision H32); a keeper that calls `check` on a schedule (not written); an audit.

## FEATURE_STATUS row wanted

`| F6 backing attestations | PARTIAL | A signed attestation from a trusted attester is checked for signature, mint, age and coverage; a monitor check reports an unverified token (`W2A-F-integrity.md`); a `cross_backing` program halts an opted-in asset on chain, on anyone's call, when its attested backing is missing, stale or below the committed coverage of the live supply; 9 LiteSVM tests against the real halt machinery (`W3D-F6.md`, ADR-0655) | Which attesters count is an operator decision (H32); nothing proves a custodian holds what the attester signed; not deployed (H27); no SDK builders, indexer projection, API route or keeper that calls `check`; an asset must name the watchdog as its halt venue signer when its halt state is created; not audited |`

## What the app layers must add

SDK: builders for the three instructions and the "name the watchdog as the venue signer" step in the halt-state creation (`findWatchdogPda`). Keeper: call `check` for every opted-in asset on a schedule shorter than the shortest policy age; the attester service calls `attest`. Indexer: project `PolicyCreated`, `Attested`, `BackingFailed` and the `Policy`, `Attestation` accounts. API and web: show an asset's policy, last statement, coverage and "halts itself" on the cross and token pages. Diagnose: add the 5 errors.
