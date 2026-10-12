# Submission packs

Three complete packs for the three targets, written 2026-10-12 from the local verbatim captures (`Colosseum Worldsfair.md`, `research/SIDETRACKS.md`, `JUDGE_PSYCHOLOGY.md`, `PRODUCT_BASE.md`), re-checked against the live pages the same day. Nothing in them is invented: every figure is listed with its source in [`figures-register.md`](figures-register.md), and everything only the founder can supply is marked **HUMAN**.

**Time:** Colosseum closes 11:59pm PT 12 Oct 2026; both Superteam listings close 2026-10-13T06:59:00Z. These are the same instant (12:29 IST, 13 Oct). Start with [`checklist.md`](checklist.md).

| File | What it is |
|---|---|
| [`colosseum-pack.md`](colosseum-pack.md) | Colosseum Crypto World's Fair: every field, long description, chains and tools, team slots, pre-existing-code disclosure, GTM, demand validation, criteria-to-evidence table, Accelerator notes |
| [`meteora-dbc-pack.md`](meteora-dbc-pack.md) | Meteora DBC sidetrack: nine form fields, description, instruction-level Meteora depth with devnet transactions, limits, criteria table |
| [`superteam-india-pack.md`](superteam-india-pack.md) | Superteam India track: eligibility point by point, nine form fields, description, criteria table |
| [`video/pitch-script.md`](video/pitch-script.md) | Pitch video, 2 to 3 minutes, shot list tied to the film and the live site |
| [`video/demo-script.md`](video/demo-script.md) | Demo video, at most 3 minutes, exact pages, commands and transactions |
| [`video/meteora-demo.md`](video/meteora-demo.md) | Meteora cut for the sidetrack's video link |
| [`video/india-addon.md`](video/india-addon.md) | Optional 20-second India add-on |
| [`video/weekly-update.md`](video/weekly-update.md) | Weekly one-minute update outline, with the first update's content sourced |
| [`video/footage-plan.md`](video/footage-plan.md) | What the Remotion film already covers, what to edit, and the footage a human must record |
| [`faq-for-judges.md`](faq-for-judges.md) | Hard questions with evidence-backed answers and the honest limits |
| [`figures-register.md`](figures-register.md) | Every figure and its source |
| [`checklist.md`](checklist.md) | The final ordered checklist; which steps are human-only |
| `assets/` | `logo-1024.png`, `logo.svg` (from `apps/web/src/app/icon.svg`), `og-1200x630.png` (live site share card) |

## Live re-check of the rules (2026-10-12, about 13:00 UTC)

Method: Superteam listing API (`https://superteam.fun/api/listings/details/<slug>`), Colosseum rules PDF downloaded and text-extracted, `colosseum.com/worldsfair` and `colosseum.com/hackathon` fetched and compared with the capture.

| Item | Result |
|---|---|
| Colosseum rules PDF | **Identical** to the captured text, word for word (3,903 words; only dash encoding differs). Contest ends 11:59pm PT 12 Oct 2026; winners by 5 Dec 2026; eligibility, prizes, judging criteria unchanged. India is not on the excluded list. |
| Colosseum FAQ (submission fields, judging factors, weekly updates) | **Unchanged** apart from whitespace around links. |
| Colosseum main page | Prizes, tracks and "Submissions due October 12, 2026" unchanged. **Changes:** a "Hyperliquid 101 Workshop" (Oct 9) was added to the workshop list; the builder counter now shows 117,949 (a platform-wide total from the page data; the capture's 8,325 was the hackathon's own counter, so the two are not comparable); the call to action points at `/arena/hackathon`; Eternal shows "Paused". None affects the submission. |
| Meteora listing | **Fields unchanged** (nine, same questions and required flags); deadline 2026-10-13T06:59:00Z unchanged; prizes 10,000 / 5,000 / 3,000 / 1,500 / 500 USDC unchanged; listing text unchanged; still `HUMAN_ONLY`, status OPEN. **Changes:** submissions now 116 (28 at capture); the API now carries a `commitmentDate` of 2026-10-31T15:59:59Z; the comments endpoint returned an empty list (14 comments at capture): NOT VERIFIED whether comments were removed or the endpoint changed. |
| Superteam India listing | **Fields unchanged**; deadline unchanged; prizes 2,500 / 1,500 / 1,000 USDG unchanged; eligibility and judging text unchanged. **Changes:** submissions now 39 (8 at capture); `commitmentDate` 2026-10-28T18:29:59Z; comments endpoint empty (2 at capture). |
| Portal form behind login | Not readable from outside: NOT VERIFIED beyond the FAQ list. |

No change was found in fields, deadlines or eligibility.

## Defects found while preparing the packs (not fixed here: other workstreams own the code)

1. **Landing page shows 0 for crosses that did not print.** `services/api/src/server.ts` computes `crosses_no_print` as `state = 'NoPrint'`, but a cross that finalizes without a price stays `Finalized`. The live API (2026-10-12) has 10 finalized crosses with no clearing price, and the verifier confirms `24X89kV5CULdgXLxWD99ZN2uQSzC6asUwNXbxct8AhR4` as a no-print (BelowMinimumVolume). The tile "crosses that did not print and refunded everyone" is therefore wrong, in the direction that flatters the product. Suggested fix: count `state = 'NoPrint' OR (state = 'Finalized' AND clearing_price IS NULL AND orders_committed > 0)`, with a test. Until fixed, do not show or quote the tile.
2. **The film's `Launch` caption says "Measured against Meteora's mainnet DBC program"**, while the proof ran on devnet (see `video/footage-plan.md`).
3. **`docs/evidence/W2-live-deployment.md` is out of date**: it says the backend VM does not exist and the web app points at a gone tunnel; the live API now answers at `https://98-87-59-136.sslip.io` and the site shows live data (latest commit: AWS backend, Vercel web). Update that file.
4. **Premium monitor**: `/v1/premium/summary` returns medians that are implausible for a real premium (for example 351,509 and 2,809,326 in units of basis points x 100); already noted in the W2 evidence and unfiltered.
5. **Repository links 404 for strangers** (the site footer, `/developers`): H21.

## What was and was not covered

Covered: every requirement in the three listings and the rules, field by field; 17 devnet transactions cited in the Meteora pack were looked up on devnet (all finalized, no error), and the `open_dbc_pool` transaction's logs were read to confirm that it calls both DBC instructions named in the packs; the live site pages (home, status, two settled cross pages) and API endpoints (`/v1/health`, `/v1/stats`, `/v1/crosses`, `/v1/accuracy`, `/v1/premium/summary`, proof of one cross) were fetched.

Not covered: the Colosseum and Earn submission forms themselves (behind login); screens of the live site were not newly captured (existing captures were used; no browser was run); no video was recorded or edited; the evidence files of other workstreams that may have landed after 2026-10-12 13:00 UTC; any claim that depends on the repository being public.
