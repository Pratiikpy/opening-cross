# W3C: the holder screens for the Wave 2D features

Date: 2026-10-14. Workstream W3C (holder and investor side). ADRs 0600 to 0604. The extended programs are proved on LiteSVM and a local validator and are NOT deployed to devnet (H27). Every action below builds its transaction through the real W3A routes and is judged by decoding what the wallet signed; none of it has run against a program that has the new instructions.

## What was built

| Surface | What a person gets |
|---|---|
| Cross page, Rules tab | Every rule of the cross in plain language from `GET /v1/crosses/:address/rules`, the draw state, a recurring series note, and what the connected wallet can take (four allocation classes, each with the reason when it cannot). A cross without rules says so, and says whether the network runs the first release. |
| Order ticket | Class choice, lock length, per-wallet limits, cancel cutoff and ending window checked before the wallet is asked. A blocked order disables the button and says why with the figures; a closed cancel cutoff or an order in the extension needs an acknowledgement. Orders on a cross with rules go through `/v1/tx/place-order-ext`; in an ending period the build waits for the next window when the current one is about to end. |
| Ending period | Hero shows `/indicative` (nearest of eight bands, a direction); the Book, Orders and Replay tabs, the order preview and the worked example hold the exact figures back, and say that this is a display rule and not secrecy. |
| Settle panel | Begin or finish the draw a cross's rules owe, instead of a settle the API would refuse. |
| After the clear | Locked fills with release, insider challenges (list, file, close an unanswered one), settled-order outcomes in words, refund-only rows that say a keeper may refund first, and a failed claim whose order is already gone from chain shown as paid out. |
| No-print, proof, receipt, replay | All fourteen no-print reasons in words; fairness proof v2 (checks on the rules, draw, allocation, what it does not establish); receipt v2 (ADR-0601; v1 unchanged); the eleven new events in the replay. |
| Treasury page | Holder actions of the extension (ADR-0603): position, stake and unstake, claim distributions, vote, reclaim, execute, redeem at NAV (preview then sign), mark a round missed, release a grant milestone, burn an expired grant, request a disclosure. Offered only when the deployed program has the extension, the treasury was extended and the team switched the feature on; otherwise the page says which is missing. |
| `/orders` | Locked fills across crosses; outcomes; refund-only note; paid-out handling. |
| Release detection | `GET /v1/programs` (ADR-0600) reads the deployed release from the program's bytes. |
| Mobile | Rules card, class choice and checks in the order ticket, ending-period coarse figures, cancel cutoff, draw steps, refund-only note and paid-out handling in the claim center. Shared pure core in `apps/mobile/src/lib/rules.ts`. |

## Verification run

| Check | Result |
|---|---|
| `apps/web` vitest | 48 files, 527 tests passed (new: `holder-rules` 32, `holder-treasury` 13, `holder-receipt-v2` 12) |
| `apps/mobile` vitest | 5 files, 64 tests passed (new: `rules.test.ts`, 30) |
| `services/api` `test/holder-programs.test.ts` | 9 passed |
| `tsc` web, mobile | clean |
| `next build` (one, at the end, `NEXT_DIST_DIR` so no other server's output was touched) | succeeded; every route listed |
| Browser, first full run | 155 passed, 4 failed (see defects below) |
| Browser, after the fixes | classes, ending, cleared, no print and pushed refunds, treasury actions and NAV: 91 passed, 0 failed. Plain cross, draw, release states (first release for both programs, extended for both) and the visual matrix: 74 passed, 0 failed |

The browser run is `apps/web/e2e/holder-w3c-flow.mjs` against `services/api/test/holder-w3c-harness.ts`: the real `buildServer` over in-memory accounts, PGlite for the index, and a JSON-RPC endpoint that records every signed transaction and decodes it (`GET /__sent`: instruction, arguments, accounts). One isolated context and one derived disposable wallet per person (`e2e/holder-keys.mjs`, derived from public labels, holding nothing). Transactions asserted: `commit_order_ext` (class 2, 45-day lock in seconds, class book account), a plain `commit_order` naming the shard of its ending window, `draw_begin`, `release_locked` (naming the lockup account), `claim`, `challenge_insider` (naming the next challenge account and the subject typed), `claim_distribution`, `stake` (50 coins), `vote` (yes, 25 coins, proposal 1), `execute_proposal`, `reclaim_vote` (proposal 2), `mark_missed`, `request_disclosure`, `release_milestone` (the grant account) and `nav_redeem` (100 coins; the payout shown before signing is 1,000 quote, the program's arithmetic over a 10,000 vault and 1,000 supply).

### Defects the run found and fixed

1. The Overview's "worked example, if the call closed now" gave the exact price during the ending period, defeating the coarse display. It is held back now (checked by the run).
2. A treasury page showed the position of "no wallet" (0% of the supply) for the first moments after a wallet connected, and told a holder of 0.3% that it held 0%. The page now waits for the read made for the connected wallet.
3. `GET /v1/crosses/:creator/series` for every cross made by a person produced a console 404 on every cross page. The page now asks the list of series first.
4. The receipt of a cross with rules would have written `proofSchema: fairness-proof/v2` into a document whose published schema fixes v1, and would have left out the rules checks (ADR-0601).
5. The test harness's cleared cross had no merged shards, so its proof correctly said "did not verify"; the fixture now merges them.

## Screenshots read

`docs/evidence/screens/w3c/`: rules, ending, cleared, treasury and orders, light and dark, 1440 and 390, each full page and each with the part under test cut out (`*-part-*`), plus the action states (class 2 ticket, draw, lockups, challenges, NAV preview, no-print proof, first-release treasury). Read for layout, wrapping, overflow, contrast and wording. axe (WCAG 2.0 to 2.2 A and AA plus best practice) clean on every page and state; zero console errors, page errors, failed requests and HTTP errors for every person.

## Not covered

- No new instruction has run on any cluster. The harness does not execute programs, so state does not advance after a transaction: the run proves the transaction a person signs, not what the program then does.
- The treasury fingerprint of `GET /v1/programs` on the real extended `treasury` binary: NOT VERIFIED (no `treasury.so` on disk; no Rust build allowed here). The cross fingerprint was checked on `target/deploy/cross_core.so` (all four extension discriminators present) and on the program deployed on devnet on 2026-10-14 (`set_rules`, `commit_order_ext`, `draw_begin` absent, `create_cross` present; treasury: `init_ext`, `vote`, `nav_redeem`, `stake` absent, `spend` present). `server.ts` does not register the route yet (orchestrator).
- `draw_finish` as a browser action, the `waiting` state of a draw and the extension reopen were not driven (they need a slot the harness does not model); `draw_begin` was.
- Sealed crosses with rules, class 1 as a lottery lot in the browser (unit-tested), class 3, a declared insider placing an order, and the sponsored-order refusal for crosses with rules were not driven in a browser.
- Team and depositor actions of the treasury (propose, deposit, pay a round, create a grant) have no screen here.
- Mobile: type-checked and unit-tested (rules core, 30 cases); not run on a device or an emulator, as before.
- Not looked at: the calendar, live board, alerts and crosses list do not mention the rules.
