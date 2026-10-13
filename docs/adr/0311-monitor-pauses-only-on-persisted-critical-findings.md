# ADR-0311: The monitor pauses only on a persisted critical finding, never unpauses, and never pauses for one asset's backing

Status: accepted (2026-10-13) · Row Q3, F6 · Code `services/monitor` · Evidence `W2A-Q3-monitor-pause.md`

## Decision

1. **Dry run by default.** With `MONITOR_ARM` unset the monitor reports what it would have done. Armed (`yes`, with the guardian key) it may set the protocol paused: new crosses and orders are refused; claims and refunds never are (INVARIANT I11).
2. **A critical finding must persist for N consecutive passes (default 3) before the monitor acts.** A flap (the upgrade authority moved for one pass and back) raises a finding and a withdrawal and does nothing else. Proved on a local validator in both directions.
3. **It acts once.** After a pause it sends no second pause and never an unpause: lifting a pause is a person's decision.
4. **Only a confirmed state counts.** A pause is reported as done only if the chain reads `paused` afterwards; a failure to pause is itself reported (and opens an incident in the console, ADR-0305).
5. **The backing check never pauses.** The program has one pause and it is protocol-wide; pausing every market because one asset's attestation went stale is a larger harm than it answers. It reports a warning. A per-asset pause needs a program change.
6. **Demonstrated only on a local validator**, which the script enforces; an armed pause on a shared cluster was deliberately not done.

## Alternatives rejected

- Acting on the first critical pass: a transient read error or a flapping RPC would pause the market.
- Auto-unpause when findings clear: an attacker who can make findings clear could reopen the market.

## Consequences

The guardian key lives on the host that runs the monitor (custody is HUMAN). A compromised monitor host can pause the protocol (it cannot do anything else with that key).
