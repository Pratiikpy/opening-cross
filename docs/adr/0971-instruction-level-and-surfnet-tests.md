# ADR-0971: The programs are tested one instruction at a time on Mollusk and whole flows on a Surfpool surfnet, against the binaries in `target/deploy`

Status: accepted (2026-10-16) · Row Q2 · Code `tests/mollusk`, `tests/surfpool` · Evidence `W5-1H.md`

## Decision

1. **Mollusk covers the surface and the single instruction.** Beyond `cross_core`'s admin instructions: (a) every program's IDL is read and checked against its binary: discriminators equal Anchor's derivation (with four interface instructions named as exceptions), each instruction the binary routes reaches its handler, an unknown discriminator is refused by name, each binary refuses any address but the one its IDL names; (b) `cross_backing` is run with a real call into `cross_core` whose protocol and halt state are made by `cross_core`'s own instructions; (c) `cross_core`'s halt machinery is run on accounts built byte for byte as their owners lay them out (a Token-2022 pausable mint, Pyth price updates).
2. **A discrepancy between an IDL and its binary is a finding that is pinned, not hidden.** `target/deploy/cross_gate.so` routes 17 of its IDL's 34 instructions. The test lists the 17 and fails when the binary is rebuilt, so the list has to be emptied by someone who knows why.
3. **Surfpool covers whole flows with a movable clock.** The binaries are written to their real addresses (`surfnet_writeProgram`), transactions go over JSON-RPC, and a test moves the clock with `surfnet_timeTravel` to cross a seven-day timelock or a call window without waiting. Two whole crosses (open and mint mode; sealed and escrow mode) are driven through create, place, cancel, commit, reveal, clear, claim and finalize and compared with the independent reference implementation, with every refusal between the steps read by number from the node's own simulation.
4. **The numbers are read from the chain, not assumed.** A refusal's expected error is pinned only after the real error was observed (an open-book cancel after the call is `NotInCallWindow`, not `CancelClosed`).

## Alternatives rejected

- Hand-written account fixtures for the whole cross state machine in Mollusk: reproduces the program's layout by hand and drifts from it; the Surfpool run uses the real accounts the program creates.
- Running the tests against devnet: the public endpoint rate-limits, cannot move time, and cannot be repeated.
- Skipping a program whose binary is stale: hides the finding that matters most.

## Consequences

Mollusk needs the nightly compiler and a separate workspace (README). Neither suite was mutation-tested (NOT VERIFIED beyond the observed passes). `cross_gate` needs a current binary before its instructions can be exercised at all. The Surfpool suite assumes a surfnet is running; it says so and how to start one, and does not start one itself.
