# Footage plan: what exists, what is reusable, what a human must record

## 1. What exists (`video/`, built with Remotion; see `video/README.md`)

- `video/out/opening-bell-1080p.mp4` (160.0 s, 1920 x 1080), `opening-bell-4k.mp4`, `opening-bell-60s.mp4` (60.1 s). Silent: no narration or music. Built from real captures in `video/public/shots/{site,trust,w3,w4}` plus labelled illustrations.
- Scenes and nominal start times (from `video/src/Root.tsx`): Problem 0:00, Cross 0:10, Sealed 0:26, Promises 0:37, Premium 0:53, Authenticity 1:06, TrustScreens 1:20, Launch 1:31, Verifier 1:45, Developers 1:57, Investor 2:09, Issuer 2:22, Close 2:31 (ends 2:40).
- Existing still screenshots (light and dark, 1440 and 390): `docs/evidence/screens/` (home, crosses, cross, developers, issue, status, trust pages, w2-live run).

## 2. Reuse, with the edits each scene needs before it goes in a submission video

| Scene | Reuse in | Needed edit or caveat |
|---|---|---|
| Problem | Pitch 0:20 | Already labelled "Illustration". Keep the label. |
| Cross | Pitch | Data are real figures (1.50 · 1,200 matched) from a local-validator run: label "recorded on a local validator" in the caption, or say it is an example cross. |
| Sealed | Pitch | Hashes and quantities are from a real sealed run; caption must say local validator if kept. |
| Promises | Pitch | Real run on a local validator (signer `C688U582…pytR`). The live signer is `6LUKWfWtb7vHNtfoxKwKH7fR13WJZ3qRDuB8EKibGBXi` (`/v1/promises/signer`). Prefer a fresh capture of a live cross page. |
| Premium | Optional | Live mainnet quotes at a closed-market time; the caption already says the reference is a perpetual. Re-check the numbers against `/v1/premium/summary` before use: some medians are implausible (see README, defects). |
| Authenticity | Optional | The impersonator is a constructed test token; the caption says so. Keep it. |
| Launch | Pitch 1:00, Meteora cut | Replace the caption "Measured against Meteora's mainnet DBC program" with a devnet statement (the proof in `A1` ran on devnet). |
| Verifier | Pitch 1:20 | Counts 525 and 523 match `D5-conformance.md`. The terminal text is a local run; add a live devnet verifier capture. |
| Developers | Pitch | "Open source, Apache-2.0" is true of the licence but the repository is private until H21: use after H21. "MCP, 17 tools" matches `W2-live-deployment.md`. |
| Investor, Issuer | Demo | Captures are from the local validator harness; replace with live-site captures (below). |
| Close | Pitch end | Counts 100,000, 525, 33 match `DP13-scale.md` and `D5-conformance.md`. Repository line valid only after H21. |

If scene text changes, edit `video/src/scenes/*.tsx` and re-render (`pnpm render:1080` inside `video/`, per its README); that work is not done in this documentation pass.

## 3. Footage a human must record (none of it exists)

| # | Footage | Why a human | How |
|---|---|---|---|
| F1 | On-camera founder segments for the pitch (0:00 to 0:20 and 2:02 to 2:42) | Judges expect a human narrator; content is the founder's own story and commitments | Plain background, good audio, one take per segment |
| F2 | Voice-over for the film scenes | Same | Record against the 1080p film or the scripted table in `pitch-script.md` |
| F3 | Terminal capture of the verifier on a live devnet cross | Needs the (private) repository cloned and the founder's terminal | `pnpm --filter @opening-cross/verifier verify <cross> --rpc https://api.devnet.solana.com`; use the A1 cross `8U6z…ppDx` from the demo script |
| F4 | Live-site capture of the settled cross page, `/crosses`, `/accuracy`, `/premium`, `/developers`, `/status` | Screen recording of the live URL (Recordly for polish, or Playwright `recordVideo` for reproducible footage) | https://opening-bell-psi.vercel.app, check `/status` is green first |
| F5 | Explorer captures of the A1, A2, A3 transactions | Browser capture of public explorer pages | Links in `meteora-dbc-pack.md` section 3.1 |
| F6 | A wallet bid and claim on an **open** devnet cross | Needs a Wallet Standard wallet extension with devnet SOL and the quote token; the scripted version is `apps/web/e2e/live-devnet.mjs` (its header lists the exact environment: `SEED`, `ISSUER_KEY`, `BUYER_KEY`, `API_URL`, `BASE_URL`, `OUT`). That script uses a test wallet and writes screenshots to `docs/evidence/screens/w2-live/`; for the video, run it with Playwright video recording on, or repeat the steps by hand with a real wallet | The cross must open at least 2 minutes after it is created and stay open for the 12-minute window the script uses; the keeper must include the issuer in `KEEPER_CREATORS` |
| F7 | Weekly update video 1 | Founder on camera | `weekly-update.md` |
| F8 | Upload all videos and put the links in the three forms | Accounts and links | Public or unlisted links that open without login |

Existing scripted captures from the harness (`docs/evidence/screens/w2-live/01..04*.png`) may be used as stills only with a caption saying what they are.

Recordly is not installed on this machine (CLAUDE.md global note); install it only if you want zoom and cursor polish. A scripted Playwright recording is reproducible and every frame comes from the real system.
