# ADR-0450: Extension tail, `set_rules`, and how `cross_core` grows without breaking what is deployed

Status: accepted (2026-10-13). Builds on ADR-0005. Governs ADR-0451 to ADR-0460.

## Context

Devnet runs `cross_core` with about 57 cross accounts and their orders. Every row of the specification that is still partial (print guards, a hard-to-game ending, identity limits, allocation classes, lockups, insider neutrality, halts, recurring series, referrals) needs state that `Cross` and `Order` do not have. Three constraints:

1. An account written by the deployed program must stay readable and settleable by the upgraded one, with no migration transaction.
2. The generated clients, the SDK, the API, the web and mobile apps, the keepers and the indexer decode these two accounts. Changing the shape of an existing instruction's account list or of `CreateCrossParams` breaks every one of them at once.
3. A rule must be impossible to bypass. A caller must not be able to skip a rule by leaving an account out.

## Options considered

- **A. Append fields to `Cross` and `Order` and migrate.** Anchor cannot deserialize a shorter account into a longer struct, so every live cross would need a migration instruction, and every Codama decoder would throw on old accounts.
- **B. A rules account per cross.** The rule can be bypassed by passing another account unless every instruction takes it as a required account, which changes every instruction.
- **C. A fixed-size tail after the struct, in the same account.** `Account<Cross>` reads and writes only the struct's own bytes (Borsh ignores trailing bytes, and `exit` serialises only the prefix), so the tail is invisible to it and to every decoder generated from the IDL. An account without the tail is a cross with every rule off.

## Decision

Option C for state that belongs to one cross or one order; new PDAs for state that is shared or unbounded.

- `Cross` and `Order` are unchanged. A cross created by this version is allocated `8 + Cross::INIT_SPACE + CrossExt::INIT_SPACE` bytes (`CROSS_SPACE`). `CrossExt` (versioned Borsh, `ext.rs`) holds the rules and the runtime state of every feature. `ext::read` returns the default (every rule off) when the account is shorter than the tail, when the version byte is not 1, or when `rules_set` is false. `ext::write` refuses an account without room, so a cross made by the deployed program can never be given a rule it was not created with (`LegacyCross`).
- Rules are set once. `set_rules` is a new instruction; `create_cross` keeps its arguments and accounts. Only the creator may call it, only in the slot in which the cross was created, only before any order exists, and only once. A bidder therefore always sees the final rules before the first order, and the creator cannot change them under a bidder. A client sends `create_cross` and `set_rules` in one transaction.
- Existing instructions keep their account lists. Whatever a rule needs beyond them (the applicant record, the class book, the lock vault, the halt state, the oracle accounts, the referrer's token account) is passed in `remaining_accounts`, in an order the stored rules define, and each is verified (owner, derivation, mint) in the handler. Because the need for an account comes from stored rules and not from the caller, a missing account is an error and never a skipped rule. `tests/core/test/rules-safety.test.ts` leaves out each of them and checks the refusal.
- Refunds need nothing the rules add: `claim` asks for the lock accounts only for a fill that is locked, so a client that knows nothing of rules can always collect a refund (ADR-0454).
- New `NoPrintReason` variants are appended after the existing six, so every stored value keeps its meaning. The new errors are appended too.
- `Order` gets a tail (`OrderExt`: epoch, ending bucket, class, lock, ticket, placement time) only when the cross's rules need one.
- Addresses of everything new are PDAs of `cross_core` derived from the cross, so an indexer finds them from the cross alone.

## Evidence

- `tests/core/test/rules-ext.test.ts` creates a cross with the **deployed binary** (the baseline saved from `target/deploy` before this work), places sealed orders, swaps in the new binary in LiteSVM and continues: reveal, merge, clear, claim, finalize all work on the account with no tail. It also checks that `set_rules` on that cross is refused, that rules are refused after the creating slot, after an order, from a stranger and twice, and that inconsistent rules are refused.
- The full pre-existing `tests/core` suite passes against the new binary.

## Consequences

- **A deploy needs no migration**, but it does change the program size (see `docs/evidence/W2D-cross-core-build.md`): the program account is extended once.
- A new cross costs the rent of the tail (about 0.005 SOL) more than before. Crosses without rules pay only that.
- Consumers decode `Cross` as before. To read the rules they use `readCrossExt` from `@opening-cross/cross-core-client` (`src/ext.ts`), which also computes the remaining accounts each instruction needs.
- The tail is not an IDL account. Its types are in the IDL because `log_ext` emits them, so the generated decoders exist.
- A layout change inside the tail is a version bump with a reader for the previous version. Nothing in the tail is reordered.

## Not decided here

Whether `cross_core` is frozen before mainnet. It is not frozen: there is no audit (H6).
