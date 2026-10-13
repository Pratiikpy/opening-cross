# A9, T6, T5 issuer wizard: presets, auto-fill, concierge (2026-10-13)

Outcome: BUILT (auto-fill from a token only; see "Not covered").

## What exists

- `packages/presets/src/launch.ts` (export `@opening-cross/presets/launch`): five format presets, eight listing types, auto-fill rules, quote-mint ranking. 27 tests in `packages/presets/test` pass (`pnpm exec vitest run` in the package).
- `apps/web/src/lib/issuer-presets.ts` is now a thin wrapper over the package. `apps/web/test/issuer-readiness.test.ts` (existing preset tests) still passes unchanged.
- Auto-fill (`autofillFromToken`): from the chain it reads decimals, supply, mint and freeze authority, Token-2022 extensions and metadata, and proposes the supply mode, format and listing type that follow, each with the fact behind it. Blockers (a transfer hook, a transfer fee, non-transferable, an authority held by someone else) are named. With no wallet connected it says what the token allows and never that the wallet is wrong.
- Concierge (`lib/issuer-concierge.ts`, `components/issue-wizard/concierge.tsx`): an ordered checklist of 11 to 12 steps judged from the form and the chain. It is not a chat. The only time shown is how long the draft has been open.
- The draft is saved in this browser and restored (`lib/issuer-draft.ts`; round-trip and rejection tests in `issuer-concierge.test.ts`).

## Run

`apps/web/e2e/issuer-wizard.mjs`, Chromium against a local build and devnet (ADR-0350 for decisions):

- explore without a wallet: eight listing types, a type that needs a partner says what is missing and keeps Create off, an available type applies its format and says what it left alone
- a real devnet token read: its 6 decimals and existing supply shown, and "Connect the wallet that holds it" note with no wallet
- connected: the suggestions appear; every readiness item passes; Create produced cross `F3SsSoCb3s8p3AsX1bQrHR3vi4Chs765qE9kJq3xrntu`, whose mint authority is the cross on chain
- 390 px: no horizontal overflow; the checklist collapses to one line there
- scripted draft completion took under a minute of page time. That is not the 10-minute first-draft target measured with people, which is NOT VERIFIED.

Screens: `docs/evidence/screens/w2b/wizard-01-explore.png`, `wizard-02-simulator.png`, `wizard-03-ready.png`, `wizard-04-created.png`, `wizard-05-mobile.png`.

## Not covered

- Extracting a draft from a website or a deck (design brief F6): needs a model and an external fetch; not built, and the page does not claim it.
- The 10-minute first-draft target with real users (SUS, task success).
- Save and resume across devices: the draft lives in one browser.
