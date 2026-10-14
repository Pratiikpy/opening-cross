# ADR-0751: The arbiter's ruling screen

Status: accepted (2026-10-14). Builds on ADR-0454 and ADR-0701.

## Decision

`/arbiter` is open to read and shows who the arbiter is (the registry account, a PDA of the seed `arbiter`, read through the RPC), the challenges waiting for a ruling and how those that were ruled on ended. It is a page of its own and not part of the issuer area: the arbiter is named by the protocol admin and is not the issuer.

The arbiter, and only the arbiter, gets the ruling form: reject (the deposit goes to the protocol, nothing is slashed) or uphold with a slash of at most the bond still held (half to the challenger, the rest to the protocol, the deposit returned). The form says in one sentence what the chosen ruling does with the money before the wallet is asked, refuses a slash above the bond and a rejection that names a slash, and reads the amount exactly. Anyone may close a challenge that has waited 14 days; the page says the program refuses it earlier. When no arbiter has been named (HUMAN_TASKS H28) the page says that nobody can rule and shows no ruling form. The protocol admin names the arbiter from the same page.

Challenges are looked for on the cleared crosses the index lists (up to 60) and on any cross named by address, because a challenge must be answered before `finalize`. `GET /v1/arbiter` and `GET /v1/crosses/:address/challenge-state` exist since W3E; `challenge-state` carries the open challenges of one cross, but there is no route that lists open challenges across crosses, which would be the better source and is the one change this page would take.

## Not covered

The evidence document itself: only its hash is on chain, and the page says so. No notification reaches the arbiter when a challenge is filed.
