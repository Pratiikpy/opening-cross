# ADR-0321: Reference adapters plan from live facts, simulate before they send, and refuse what is not theirs to decide

Status: accepted (2026-10-13) · Row W15 · Code `examples/adapters` · Evidence `W2A-W15-adapters.md`

## Decision

1. **An adapter is a pure planner plus an executor.** The planner (reopen, halt-resume, tender, block sale) takes facts and returns the cross it would create, with an explanation in plain sentences and warnings for what it did not set (no oracle guard, no calendar). The executor runs in **shadow mode by default**: the cluster simulates the transactions and nothing is sent; `--send` is explicit and needs a keypair.
2. **Timing is derived from the market**, not typed: a reopen closes before the market trades again, leaving time to clear and reveal, and refuses a session that is too close.
3. **A halt resumes through a call, not through the first trade that prints**, on a grid twice as wide as a reopen, and only when the token is no longer halted and the pair has printed before.
4. **A tender is a securities question before it is a mechanism.** The planner refuses unless the caller acknowledges that counsel was asked (HS4); it prints the allowlist Merkle root the gate needs and a minimum window that is a placeholder for counsel to set.
5. **A block sale for a multisig prints the unsigned create transaction** (the vault is its only signer) and the sell order to place after it.
6. **Shadow mode says which transactions it could not check** (those that need the cross to exist), as inconclusive, not failed.

## Alternatives rejected

- Adapters that send by default: the first run of an example should be harmless.
- Typing times and prices into each adapter: the wrong number goes to chain.

## Consequences

The adapters are examples, tested on plans and run on devnet in shadow mode; none was sent. They are a template for an integrator's own code.
