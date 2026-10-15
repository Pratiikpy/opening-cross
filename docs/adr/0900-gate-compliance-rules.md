# ADR-0900: Compliance rules in `cross_gate`

Date: 2026-10-16 · Status: accepted · Builds on ADR-0004 and ADR-0012 · Ports and revises the unverified work in commit `8f753df` (branches `wip-parallel-batch-quarry`, `wip/agent-batch-unverified`, ADR-0140 there) · Rows G4, G5, G2/V6

## Context

`cross_gate` knew one thing about a wallet: whether it holds a `Pass`. That cannot say where the holder is, what kind of investor they are, whether two wallets are one person, how many holders there are, or whether insiders may sell this month. The 8f753df branch designed all of that. It was never reviewed or merged. This ADR records what was ported, what was changed after review, and what was dropped.

## Decision

**Rules live in an extension of the existing `GateConfig` account.** `init_rules` reallocates the account and writes a magic byte plus a fixed-size `Rules` struct (481 bytes) after the original 172. Old readers see a prefix and keep working. While rules are active the original issuance and revocation paths refuse with `UseRulesPath`, so no permissionless path can skip a rule or let the holder counter drift.

**A pass carries terms.** `Terms` (`["terms", mint, owner]`) holds identity id, ISO 3166-1 numeric country, tier, flags (accredited, insider, sanctions-clear, KYC), per-person cap, source and expiry. `IdentityBinding` enforces one pass per identity, `Volume` holds an insider's rolling sold amount, `Denied` blocks a wallet.

**Four ways to get a pass, one issuance function.** SAS identity attestation (`claim_pass_attested`, optional separate accreditation attester as the only source of the accredited flag), terms-bearing Merkle allowlist, authority grant. All run the same checks: country allow or deny list, minimum tier, required flags, issuance window, holder cap, one identity one pass, denial.

**Enforcement.** At issuance and refresh for everything above. On every hooked transfer: the receiver's terms must not have lapsed and must still satisfy the current country, tier and flag rules, so a rule change bites on the next transfer and not only when someone calls `revoke_nonconforming`; a sender flagged as an insider is held to blackout windows (up to four) and a volume limit per window. After the fact, anyone can close a pass that expired, whose attestation is gone, that no longer conforms or whose wallet was denied. Resale locks: the rules' `lock_policy` is applied by `receive_locked` (callable only by a genuine cross) or by the named `lock_delegate` keeper through `set_lock`, which can only strengthen a lock.

## Changes made to the unverified branch

1. **The transfer-hook account list is opt-in.** The branch changed `init_hook_metas` to write the longer list for every mint. Token-2022 requires the caller to pass every account in the list, so every existing hooked-mint client (DBC swaps, settlement) broke: 10 tests in `tests/core` failed on the first full run. Now `init_hook_metas` still writes the three-account list; `update_hook_metas` (authority only, only after rules are on) writes the six-account list; a gate with rules and a stale list refuses transfers (`RulesAccountsMissing`) instead of skipping the rules. The client reads the list version from the chain (`detectHookListVersion`).
2. **The receiver's terms are checked at transfer time** (the branch checked only issuance and the sender's insider rules).
3. **`open_volume`** added: the branch had no way to create the volume account of a wallet that became an insider after issuance, so such a wallet could never transfer.
4. **The Ed25519 permit path was dropped.** It is not needed by any of the four rows, needs a hand-parsed instructions sysvar or two new dependencies in the shared lock file, and nothing calls it.
5. **The cross-account layout read was fixed.** The branch read `Cross.gate_mint` at a fixed offset (354). Borsh writes `None` as one byte, so the offset moves with the contents of the options before it; on the real `cross_core` binary it is 342. The program now reads only the base mint (offset 52, before the first option) from an account it has authenticated by owner and discriminator, and a test checks the offset against a cross `cross_core` created. The `WrongGate` check on `reserve_allocation` went with it.
6. The `sas_attestation::read_valid` helper the branch added to a shared crate now lives in `programs/cross_gate/src/attest.rs`.

## Consequences

- Program: 667,064 bytes against 364,032 deployed. Extending the devnet program needs rent for about 303 KB (HG5, not funded). NOT VERIFIED on devnet; verified on LiteSVM and on a local validator.
- `docs/spec/OCIP-1.md`, `idls/cross_gate.json` and `crates/opening-cross-cpi/idls/cross_gate.json` must be regenerated (`node scripts/ocip-sync.mjs`); until then `tests/core/test/ocip-spec.test.ts` "PDA seed constants" fails because the program gained seeds.
- Limits, by design: a Token ACL gate checks only the pass at thaw time; transfer-time rules stop when a token loses its hook (DAMM v2 pools reject hooked mints); insider limits are per wallet and are avoided by moving tokens to a wallet that is not flagged; the identity id is only as unique as the attester makes it; replacing the identity attester lets anyone close every SAS-sourced pass (they must be reclaimed under the new attester).
- `init_rules` takes the count of live passes issued before the rules from the authority, who is trusted anyway.
