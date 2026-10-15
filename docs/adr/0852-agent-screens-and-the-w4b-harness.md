# ADR-0852: What the browser offers an owner and an agent, and how the screens are proved

Status: accepted (2026-10-15) · Builds on ADR-0650, ADR-0801

## Decision

- **The agent's key in a browser is the agent's.** On a mandate page the agent's wallet is offered place-order and cancel-order and nothing else; the owner's wallet is offered fund, change limits, withdraw, withdraw SOL and revoke (always visible, permanent, with the sentence that says so); anyone is offered the sweep. Controls that belong to the other party are not rendered, and a connected wallet that is neither says who may do what.
- **The guard has a page.** `/agents` runs `POST /v1/mandates/check-transaction` on a pasted draft and shows each instruction and every issue. It states, as ADR-0801 does, what the guard cannot see.
- **Prices are checked against the cross's grid before a wallet is asked.** An order at a price that is representable but off the grid is named on the form; a sealed cross shows a fresh salt to keep for the reveal.
- **Proof.** The screens are driven in a browser against `services/api/test/w4b-harness.ts`: the real API over an in-memory chain, every unsigned transaction built by the real routes, signed by a real Ed25519 test wallet, verified and decoded by the harness so a test asserts the instruction, the signer, the accounts and the arguments. The harness emulates the cluster (no program runs) and has two modes, `new` (the seven programs and the batch 2 build present) and `absent` (the cluster as it is today). Every suite runs both. Effects on accounts are not applied: a screen is proved for the transaction it signs, not for the state afterwards; that is what the LiteSVM suites prove.

## Not covered

No instruction ran on a cluster. The phone app is type-checked and unit-tested, not run on a device.
