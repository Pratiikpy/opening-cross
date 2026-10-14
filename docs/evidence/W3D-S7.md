# W3D-S7: conviction reputation (`cross_conviction`), proved on LiteSVM

Status 2026-10-14: **program, client and tests built; proved on LiteSVM against the real Token-2022 program; not deployed (H27).** Not audited. ADR-0651. Row S7.

## What was built

A new program `JAWUTTDhBQQ97w9YiPMv5sjsDxZab7AsSnc9L57zJjz6` (270,408 bytes), 5 instructions (`lock_tokens`, `unlock`, `init_badge`, `claim_badge`, `close_lock`), 4 events, 12 errors, and the client `@opening-cross/cross-conviction-client`.

Tokens go into a vault only the program moves, until a time the holder chose (one day to four years). Nothing moves them early. After the time the holder takes them back and can mint a soulbound badge: a Token-2022 mint with the `NonTransferable` extension, one per holder and token, in an amount of `floor(amount * seconds / (86,400 * 10^decimals))` token-days, once per lock.

## Tests

- `tests/core/test/conviction.test.ts`: **8 passed**. The vault holds the tokens; the holder cannot unlock early, a stranger cannot unlock, a direct token transfer out of the vault fails; exactly the locked amount returns at the unlock time and the vault is closed; a second unlock fails. A zero amount, a lock under a day, one over four years and a reused nonce are refused. Another holder cannot unlock someone else's lock. The badge: 100 tokens for 30 days mints exactly 3,000; a claim before the time, by a stranger and a second claim for the same lock are refused; two locks add up (1,000 + 1,000); the badge **cannot be sent** (Token-2022 answers "Transfer is disabled for this mint") and a stranger cannot burn it while its holder can; a lock too small for one token-day gets no badge but still comes back; a badge mint for another token cannot stand in. `close_lock` needs both exits and returns the rent.
- `cargo test -p cross_conviction`: **4 passed** (token-days round down, scale with decimals, never overflow into a wrong answer, equal a 128-bit reference over a grid).
- Mutation checks: early-unlock guard removed -> 1 test fails; "badge once per lock" removed -> 1 fails; rounding down changed to up -> 1 fails; the one-day minimum removed -> 1 fails.
- `cargo fmt --check`, `cargo clippy -D warnings`: clean.

## Compute units (LiteSVM)

lock_tokens 44,993 · claim_badge (with `init_badge` and the account creation in one transaction) 55,816 · unlock 16,862 · close_lock 2,033.

## Size and deploy cost

270,408 bytes; program account rent 1.375 SOL (permanent) and a buffer of the same size returned after the deploy.

## Not covered

Devnet; a Token-2022 locked token with a transfer hook or a transfer fee (the code forwards remaining accounts and credits only what arrived, neither is exercised); a MetadataPointer on the badge mint (wallets show a mint address, not a name); a `cross_gate` rule that reads the badge (ADR-0651 says why it is left to an identity-pass route); an audit. The program's upgrade authority could replace the code; the vault guarantee is the program's, and the Squads handover (H13) is what makes it an assumption about a multisig instead of a key.

## FEATURE_STATUS row wanted

`| S7 conviction reputation | PARTIAL | A `cross_conviction` program: tokens locked with no early exit and a soulbound Token-2022 badge (NonTransferable) that measures the token-days held locked, once per lock; 8 LiteSVM tests against the real Token-2022 and 4 unit tests (`W3D-S7.md`, ADR-0651) | Not deployed (H27); no SDK builders, API route, indexer projection, "Lock to earn conviction" action or portfolio badge; the badge mint has no name or image; no `cross_gate` rule reads it; not audited |`

## What the app layers must add

SDK: builders for the five instructions (the client generates the PDAs `findLockPda`, `findBadgeMintPda`, `findBadgeAuthorityPda`); the claim transaction is `init_badge` (idempotent) + create the holder's badge account (idempotent) + `claim_badge`, as in the test helper `claimIxs`. Indexer: project `Locked`, `Unlocked`, `BadgeCreated`, `BadgeClaimed` and the `Lock` account. API: a conviction read per wallet (locks, token-days claimed, badge balance) and unsigned-transaction routes. Web and mobile: "Lock to earn conviction" on a holding and the badge on the portfolio. A gate (`cross_gate` priority pass, an attester) can read the badge balance. Diagnose: add the 12 errors.
