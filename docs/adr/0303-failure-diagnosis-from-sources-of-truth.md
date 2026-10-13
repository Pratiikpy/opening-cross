# ADR-0303: Failure diagnosis is generated from the sources of truth and checked against the program's own log

Status: accepted (2026-10-13) · Row L5 · Code `packages/diagnose` · Evidence `W2A-L5-diagnose.md`

## Decision

1. **No error table is typed by hand.** `scripts/generate.ts` builds `src/tables.generated.ts` from the IDLs in the repository (Meteora DBC, DAMM v2, DLMM, Met Lock, Zap, Raydium CPMM, the five Opening Cross programs), from Anchor's own `ErrorCode` enum (82 errors; the number in each variant's doc comment must equal the computed code, so a parse slip fails the build), and from the generated error files of the SPL Token, Token-2022, System and Associated Token clients.
2. **The innermost failing program is blamed.** The logs are walked with a call stack; the first `Program X failed` is the frame that failed, so a router that calls a pool names the pool and the top-level instruction it sits in.
3. **The table is compared with what the program itself logged.** If the program logged `Error Code: X. Error Number: N` and the table disagrees, the IDL on file is older than the deployed program: the diagnosis says so and trusts the program's log.
4. **An error it cannot place is "unmapped", with the evidence.** It never guesses a name for another program's code.
5. **Every diagnosis states that a failed transaction changed nothing but the fee.**
6. **Categories** (slippage, balance, account, authority, compute, blockhash, state, math, program-rule) come from the error's name; the names real swap programs use for "output below your minimum" (`TooLittleOutputReceived`, `MinReturnNotReached`, `InsufficientOutAmount`) are slippage.

## Why check against mainnet

Tables from an IDL can be stale against a deployed program. Failed mainnet transactions carry the program's own error name, which is ground truth, so agreement can be measured: 69 of 69 failures inside DBC (19), DAMM v2 (39), DLMM (1) and Raydium CPMM (10) agreed.

## Consequences

"Version-matched docs" is not built; a diagnosis names the IDL version of its table and links to no documentation. Programs outside the list are explained only if they log an Anchor error.
