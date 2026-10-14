# ADR-0600: The program release is read from the program's own bytes

Status: accepted (2026-10-14). Builds on ADR-0500 and docs/HUMAN_TASKS.md H27.

## Context

The rules, classes, lockups, votes, NAV redemption and distributions are built and proved on LiteSVM and a local validator, and are not deployed to devnet until the operations key is funded (H27). A screen must not offer an action the deployed program refuses (`InstructionFallbackNotFound`, Anchor error 101), and it must say plainly why. A cross or treasury of the first release carries no mark of what its program could do: a missing extension tail is also what a creator who set no rules produces. The W3A documents describe the refusal but give no way to ask which release a network runs.

## Decision

`GET /v1/programs` (services/api/src/routes/holder-programs.ts) answers, for `cross_core` and `treasury`, `{ address, deployedSlot, extended: true | false | null, checked, note }`.

The answer comes from the ProgramData account. An Anchor program loads each instruction's 8-byte discriminator with one `lddw` (opcode 0x18, the low four bytes in the first slot's immediate, the high four in the second's). `cross_core` is built with `no-log-ix-name`, so the instruction names are not in the binary and a text search would find nothing. The scan looks for `set_rules`, `commit_order_ext` and `draw_begin` (cross) and `init_ext`, `vote`, `nav_redeem` and `stake` (treasury). A control instruction every release has (`create_cross`, `spend`) must be found, or the scan is not trusted and the answer is `null`. Unreadable is never reported as "first release". A definite answer is kept for ten minutes.

The web app treats `null`, and a missing route, as "could not tell": it says so and offers nothing that depends on the extension, but it does not claim the first release.

## Evidence

`services/api/test/holder-programs.test.ts` (9 tests, in-memory ProgramData). The scan finds all four extension discriminators in `target/deploy/cross_core.so` (the extended build) and none of the three extension instructions in the program deployed on devnet, read on 2026-10-14: `docs/evidence/W3C-holder-ui.md`.

## Not covered

The extended `treasury` binary: no `treasury.so` is on disk and no Rust build is allowed here, so the treasury fingerprint is tested on synthetic ProgramData and on the deployed first release (extension absent, `spend` present), not on the real extended build. NOT VERIFIED until the upgrade lands. `server.ts` must call `registerHolderPrograms(app, { account, network, clock })`; until it does, the route answers 404 and the pages fall back to "could not tell".
