# W2D-VM7: issuer neutrality (VM7)

Outcome: **HUMAN** (everything is built; naming the arbiter is the founder's). Design: ADR-0454.

Built: up to eight declared insiders; their buys tallied apart, flagged, locked, and their allocation (an upper bound) excluded from the minimum volume, raise and float; a bond posted at `set_rules` and held in the quote vault; a challenge window after the clear; `challenge_insider` (deposit plus evidence hash), `resolve_challenge` by the arbiter (upheld: half the slash to the challenger, half to the protocol, deposit back; rejected: deposit to the protocol), `expire_challenge` after 14 days so an absent arbiter cannot hold the proceeds back; `finalize` waits for the window and for no open challenge, then returns the surviving bond.

Tests: `rules-insiders.test.ts` (4), `rules-safety.test.ts` (expiry, refund needs no lock accounts), `rules-verifier.test.ts`. A bug found by these tests and fixed: the lock record's rent was credited before its allocation CPI and the runtime refused it (ADR-0454).

The human step: name the arbiter (a person or body that weighs off-chain evidence of a funding link) with `set_arbiter` from the protocol admin (HUMAN_TASKS H28). The program cannot detect a funding link; a challenge is a judgement.

FEATURE_STATUS.md row wanted: `| VM7 issuer neutrality | HUMAN | Declared insiders excluded from the raise and locked, a bond, challenges, an arbiter ruling and a 14-day expiry (`W2D-VM7.md`, ADR-0454); 6 LiteSVM tests | The arbiter must be named (H28); undeclared insiders are found only by challenge; devnet proof pending funding; not audited |`
