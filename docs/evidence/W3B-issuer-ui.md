# W3B: the issuer screens for the Wave 2D features

Date: 2026-10-14. ADR-0550, ADR-0551, ADR-0552. The extended programs are proved on LiteSVM and a local validator and are **not deployed to devnet** (H27). Nothing here ran against a cluster that has the new instructions.

## How it was tested

`services/api/test/helpers/issuer-harness.ts` is the real API (`buildServer`: the rules, treasury and settle routes, `GET /v1/programs`, a PGlite database with the real migrations) over an in-memory chain, plus a JSON-RPC endpoint the web app reads and sends through. Every unsigned transaction is built by the real route and the real SDK and client builders; the page's wallet signs with a real Ed25519 key and the harness verifies every signature before recording the transaction, decoded to program, instruction, accounts and arguments. `ISSUER_MODE` / `POST /__mode` switches the deployed programs between the extended build and the first release; in the first release the cluster answers the instructions it lacks with error 101 (the instruction set of the first release is read from the clients before commit 863d8cd), and `/v1/programs` reads the same program bytes. **Emulated: the cluster.** No program runs and a sent transaction's effects are not applied, so a page is checked for the transaction it signs, not for state afterwards.

Run: harness (`cd services/api && npx tsx test/helpers/issuer-harness.ts`), app (`NEXT_PUBLIC_API_URL=... NEXT_PUBLIC_RPC_URL=.../rpc next dev`), then `node e2e/issuer-w3b-wizard.mjs`, `-treasury.mjs`, `-settle.mjs`, `-visual.mjs` (see `issuer-w3b-lib.mjs`).

## Results (one run, after the last code change)

| Suite | Result |
|---|---|
| `e2e/issuer-w3b-wizard.mjs` | 67 checks pass |
| `e2e/issuer-w3b-treasury.mjs` | 60 checks pass |
| `e2e/issuer-w3b-settle.mjs` | 26 checks pass |
| `e2e/issuer-w3b-visual.mjs` | 9 states x 4 views (1440 and 390, light and dark) = 36 pass: axe WCAG 2.1 AA, no horizontal overflow, no console error, no failed request |
| `apps/web` vitest | 527 pass (new: `issuer-rules`, `issuer-treasury-console`, concierge rules step) |
| `services/api/test/issuer-rules-parity.test.ts` | 7 pass |
| `packages/presets` | typecheck clean, 27 pass |
| `apps/web` `tsc --noEmit`, `next build` | clean; `/issuer/settle` and `/issuer/treasury/[address]` are in the route table |

Defects found by the runs and fixed: the rules step marked done only with a wallet; a long address overflowed a card at 390; a scrollable table had no keyboard access; an extension request certain to be refused fired on page load and logged a 422; a refusal named "the program 2EVp...". Screenshots were read at 1440 (light) and 390 (dark) for the rules step, holder votes and distributions; the other 33 were checked by axe, overflow and console only (NOT read by a person).

## What each screen does, as checked on the decoded transaction

- **Rules step**: the ending preset signs `create_cross` and `set_rules` in one transaction (endingSecs 1800, buckets 6, randomEnd, cancelCutoff 1800, every other rule off); six insiders give two opening transactions (quote account and mint handover, then create plus rules) with the six insiders in `set_rules`; eight do not fit and Create is off; a half-landed creation is finished by sending only the rest; with no rules the cross is created by `create-cross` with no `set_rules`; a draft with its rules survives a reload; on the first release creating with rules is off and says why; with the release unreadable the dry run refuses it and nothing is sent.
- **Treasury console**: extend (governed preset, `init_ext` with 604,800 s and 2,000 bps), votes, execute, propose (with the SHA-256 of the description), NAV proposal, deposit, claim, pay round, mark missed, release tranche, create grant, release milestone, post disclosure, sweep; refusals shown in words (over the proposal cap, nothing locked to reclaim, grant locked, not expired, no attestation, not lapsed); another wallet is told it is not the authority; on the first release every extension action is off and the first-release action stays on.
- **Settle**: four partner payouts and the position's fee claim, greenshoe create (budget below 10% refused with the minimum), place a level (two signers, both verified), settle a level, finish refused while a level is open; on the first release a payout is refused by the dry run.

## Not covered

- Any new instruction on a real cluster (H27). The harness proves what the screens sign, not what the programs do with it.
- The half-landed creation's retry against a real mint whose authority already moved to the not-yet-created cross: NOT VERIFIED.
- Series (`create-series`, `spawn-next`) and the halt-state routes have no screen. Challenging an insider and the draw are holder-side (3C).
- Wizard Rules step as a separate wizard "step" screen: it is a section of the one-page form with its own checklist item, like every other part of the wizard.
- The web app's wallet-signing was tested with the Wallet Standard test wallet only, not a real extension.
- 33 of the 36 visual states were not read by a person.
- Refused terms still send one request that the browser logs as a 422; `init-ext` has no check-only mode that answers 200.
