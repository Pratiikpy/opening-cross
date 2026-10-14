# ADR-0551: The treasury console

Status: accepted (2026-10-14). Builds on ADR-0470 to ADR-0476 and ADR-0505.

## Decision

`/issuer/treasury/[address]` reads a treasury through `GET /v1/treasuries/:address` and `/ext`, `/proposals`, `/grants`, `/rounds`, `/positions/:owner`, and builds every action through `POST /v1/treasuries/:address/tx/<action>`: extend once, propose, vote, reclaim a vote, run a proposal, NAV proposals, deposit to the distribution, claim, pay a round, mark a round missed, release a tranche, create a grant, release a milestone, burn an expired grant, post a disclosure, record the assignment, trigger a liquidation, sweep. Each is signed in the wallet.

- **Extension terms** are typed in days, hours and percent. Only the preset named `flagship` is built by the API; the other presets send every term. The program's own `checkExtParams` runs when the request is built, so the page shows its `refused` reasons and its `advice` (accepted but the treasury would be unusable) before anything is signed; advice needs an explicit acknowledgement. A term set that is certain to be refused (a wind-down with no recovery account) is said on the field and no request is made. `FLAGSHIP_FACTS` is held equal to `flagshipExtParams` by a test.
- **A feature the treasury was extended without** is a sentence, not a dead button, and says it cannot be added now.
- **Not the authority**: the buttons that need it are off with the reason beside them; the API refuses them as well.
- **Errors are the API's words** (`NOT_ATTESTED`, `LOCKED`, `NOT_LAPSED`, ...), shown where the action is, with nothing signed.
- A read that fails is named as unread, never shown as empty.

## Not covered

Staking and unstaking (holder side, workstream 3C). The allowance spend of the first release. State after an action: the harness records the transaction and does not apply it.
