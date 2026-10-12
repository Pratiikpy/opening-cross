# Final submission checklist

Legend: **HUMAN** = only Prateek can do it (account, identity, voice, face, legal, money, the act of submitting). **READY** = documented and needs no one. Order matters: Colosseum first (Superteam asks for it), repository access before any form.

Hard time: Colosseum registration and upload close **11:59pm PT 12 Oct 2026**; both Superteam listings close **2026-10-13T06:59Z** (12:29 IST 13 Oct), which is the same moment. Check the countdown on colosseum.com and superteam.fun before starting; times were read on 2026-10-12.

## A. Shared prerequisites

| # | Step | Who | Detail |
|---|---|---|---|
| A1 | Repository access (H21) | HUMAN | Either make `Pratiikpy/opening-cross` public after a final secret scan (`gitleaks`, `git status`, check no `.keys/`, `.secrets/`, `deploy/.env`, personal paths), or add read access for `hackathon@colosseum.com` and GitHub user `dannxbt`. Confirm by opening the URL in a logged-out browser. |
| A2 | Register on Colosseum, country India, team "Opening Bell"; every member registers and the leader adds them (H3) | HUMAN | Rules section 6: unregistered members are disqualified after the deadline. |
| A3 | X account (H7) and first post | HUMAN | Optional fields, but Colosseum recommends building in public. |
| A4 | Fill team, background, location, role, AI-assistance sentence | HUMAN | Colosseum pack sections 4 and 5. |
| A5 | Demand validation additions (H8), if any are true | HUMAN | Colosseum pack section 7. Never add what is untrue. |
| A6 | Confirm the live site and API are healthy | READY | `https://opening-bell-psi.vercel.app/status` all OK; `GET https://98-87-59-136.sslip.io/v1/health` `"ok":true`. Re-check immediately before submitting and after. |
| A7 | Re-read live rules for changes in the last hours | READY | Listing API and Colosseum pages, as in README "Live re-check". |
| A8 | Re-read `docs/FEATURE_STATUS.md` and `docs/evidence/` for changes by other workstreams; update packs only with PASS evidence | READY | Particularly Meteora pack section 3.2 and the figures register. |

## B. Videos

| # | Step | Who | Detail |
|---|---|---|---|
| B1 | Record on-camera founder segments and voice-over | HUMAN | `video/pitch-script.md` |
| B2 | Record live-site, explorer, terminal and wallet footage | HUMAN | `video/footage-plan.md` F3 to F6 |
| B3 | Fix the film captions listed in `footage-plan.md` section 2 and re-render (needs the Remotion project) | READY (code work, not done here) | `video/src/scenes/` |
| B4 | Edit and export: pitch 2:00 to 3:00, demo at most 3:00, Meteora cut at most 3:00 | HUMAN | Check each length in the file's properties |
| B5 | Upload; use links that open without login; test in a private window | HUMAN | |
| B6 | Weekly update video 1 | HUMAN | `video/weekly-update.md` |

## C. Colosseum (do first)

| # | Step | Who |
|---|---|---|
| C1 | Open the submission portal from the platform dashboard (`colosseum.com/arena/hackathon`) | HUMAN |
| C2 | Paste every field from `colosseum-pack.md` sections 1 to 6 (name, pitch, descriptions, chains and tools, team, location, logo from `assets/logo-1024.png`, repository, videos, GTM, validation, disclosure) | HUMAN |
| C3 | Note any portal field not in the pack and add it to `colosseum-pack.md` (the form behind login is NOT VERIFIED here) | HUMAN |
| C4 | Submit as team leader before 11:59pm PT; copy the project URL and your profile URL | HUMAN |
| C5 | Screenshot the confirmation | HUMAN |

## D. Meteora DBC (Superteam Earn)

| # | Step | Who |
|---|---|---|
| D1 | Ask Meteora whether a devnet-only project is eligible and whether `dannxbt` read access is enough; record the answer (`meteora-dbc-pack.md` section 3.4) | HUMAN |
| D2 | Log in at superteam.fun with a human account (the listing is HUMAN_ONLY) | HUMAN |
| D3 | Paste the nine fields from `meteora-dbc-pack.md` section 1; field 7 is Yes only after C4; add the Colosseum links | HUMAN |
| D4 | Submit before 2026-10-13T06:59Z; screenshot the confirmation | HUMAN |

## E. Superteam India (Superteam Earn)

| # | Step | Who |
|---|---|---|
| E1 | Confirm Colosseum profile country is India (eligibility) | HUMAN |
| E2 | Paste the nine fields from `superteam-india-pack.md` section 2 | HUMAN |
| E3 | Submit before 2026-10-13T06:59Z; screenshot the confirmation | HUMAN |

## F. After submitting

| # | Step | Who |
|---|---|---|
| F1 | Do not change the repository's history or take the repository private again while judging runs | HUMAN |
| F2 | Keep the live site and API running; check `/status` daily | HUMAN or READY |
| F3 | Post weekly update videos; engage with judges on X before judging (`JUDGE_PSYCHOLOGY.md`) | HUMAN |
| F4 | Prepare for the 15-minute Zoom with [`faq-for-judges.md`](faq-for-judges.md) | HUMAN |
| F5 | Winners: Prize Acceptance Documents and due diligence; prizes go to the team leader's wallet; taxes are the winner's (Rules sections 13 and 15). Never handle a real seed phrase in chat. | HUMAN |
