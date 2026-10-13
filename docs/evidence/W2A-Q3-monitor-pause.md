# W2A-Q3: monitoring with auto-pause, run end to end on a local validator

Date: 2026-10-13. Code: `services/monitor` (the checks and engine existed; new: `src/checks/backing.ts`, `scripts/local-pause-demo.ts`). The 27 earlier unit tests plus 3 new ones pass (30).

## What was run

`pnpm exec tsx scripts/local-pause-demo.ts` (a local validator only; the script refuses any other URL) against `solana-test-validator 1.18.26` under WSL on ports 18899, 18903 and 18904, started by `services/monitor/scripts/local-validator.sh`. The script deploys the real `target/deploy/cross_core.so` with the Solana CLI as an upgradeable program (upgrade authority: the admin key), creates the protocol with a separate guardian key, unpauses it, pins the program's executable hash and upgrade authority, and then plays the attack the monitor exists for: the program's upgrade authority is moved to a stranger.

Result, all 10 checks true:

1. Two clean passes: no findings, no decision.
2. A flap. The authority moves for one pass: `critical: the upgrade authority of F5k8EDDX... is Fjc5PV31...`; no pause. It moves back; the next pass has no findings; the protocol is still open and no pause was attempted.
3. The authority moves and stays. Passes one and two: critical, no action. Pass three, the third in a row: decision `paused`. The pause transaction `3x3HXRhQstUB564B...` is signed by the guardian `BYKVNGAT...` (the fee payer), read back from the validator with `getTransaction`; the protocol account then reads `paused: true`, with admin `DTB3Jtxb...` and guardian `BYKVNGAT...` unchanged.
4. Three more passes with the authority still moved: no second pause was sent (`pauseCalls` stays 1), the protocol stays paused, and the monitor sends no unpause.

The persistence rule (three consecutive passes, `MONITOR_CONSECUTIVE`) is what separates a flap from an incident; both paths ran.

## Backing and the pause

The new `backing-status` check turns a real-asset token whose signed backing attestation is stale, short or missing into a warning. It does not pause. The program has one pause and it is protocol-wide; pausing every market over one asset's attestation would do more harm than it prevents. A per-asset pause needs a program change, recorded as needs-program under F6.

## What this does not show

- The pause was proved on the local validator by reading the flag from the protocol account. That a paused protocol refuses new crosses and orders but never claims and refunds (INVARIANT I11) is covered by the program's own test suites, not re-proved here.
- Validator 1.18.26 is not the version the clusters run; programs deployed there with `--upgradeable-program` preloading cannot change authority on this version, so the script deploys through the CLI instead. Behaviour on current mainnet validators is as the devnet read-only run (`scripts/devnet-check.ts`, 109 crosses scanned, 0 shortfalls) showed for the read paths; an armed pause on a shared cluster was deliberately not done.
- No vault-shortfall pause was produced: creating a real shortfall needs a program defect. The check is covered by unit tests with constructed accounts.
- A webhook delivery to a real receiver, a real guardian key held in a signing service, and the on-call response are HUMAN (H33, H34).
