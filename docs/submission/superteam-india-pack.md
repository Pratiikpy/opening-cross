# Pack 3: Superteam India track (Superteam Earn)

Listing: https://superteam.fun/earn/listing/colosseum-crypto-worlds-fair-hackathon-superteam-india-track · "Colosseum Crypto World's Fair Hackathon | Superteam India Track" · 5,000 USDG across 3 winners (2,500, 1,500, 1,000, plus a Member role in Superteam India) · deadline 2026-10-13T06:59:00Z (12:29 IST, 13 Oct). Region India, agent access HUMAN_ONLY (a person must submit; an agent cannot). The listing text and fields were re-read live on 2026-10-12 and are unchanged from the capture; the commenter-confirmed prize is 5,000, not 10,000.

## 1. Eligibility, point by point

| Requirement (listing) | Status | What to do |
|---|---|---|
| Built on Solana | Met. Every program, client and service targets Solana. The product uses no other chain. | Nothing. Say "Solana only" in the description. |
| Team based in India | HUMAN. The builder is based in India per the project's `CLAUDE.md`; the form of proof (city, entity, ID) is not stated by the listing. | State the city. |
| Registered on Colosseum with "India" selected as country | HUMAN (HUMAN_TASKS H3). | Register at colosseum.com, country India, team "Opening Bell", every member registered. |
| Submitted to both the Colosseum portal and Superteam Earn | Colosseum first (deadline 11:59pm PT 12 Oct), then Earn here, before 12:29 IST 13 Oct. | See [`checklist.md`](checklist.md). |
| Eligible under the official global rules | India is not on the excluded list; 18 or older; one team per person; English content. | Confirm everyone is 18+. |
| Solana-only pool | The hackathon is multichain; this pool is Solana only. | Say so explicitly. |

## 2. Form fields (final text)

Nine fields, identical to the Meteora listing's form.

| # | Field | Required | Final value |
|---|---|---|---|
| 1 | Project Name | yes | `Opening Bell` |
| 2 | Project Description | yes | Section 3 |
| 3 | Project Github Link | yes | https://github.com/Pratiikpy/opening-cross (private today: **H21**; make it public before submitting, or the link returns 404 to reviewers) |
| 4 | Project Website | no | https://opening-bell-psi.vercel.app |
| 5 | Project X Link | no | HUMAN: none exists yet (H7); leave blank rather than invent |
| 6 | Link to pitch deck or Loom/video | yes | HUMAN: the Colosseum pitch video, [`video/pitch-script.md`](video/pitch-script.md); if you want an India-specific opening, record the 20-second add-on in [`video/india-addon.md`](video/india-addon.md) |
| 7 | Did you submit to the official Crypto World's Fair on Colosseum? | yes | `Yes`, only once true |
| 8 | Link to Colosseum project | no | HUMAN: URL after Colosseum submission |
| 9 | Link to your Colosseum profile | no | HUMAN |

## 3. Project description (paste)

> Opening Bell is a Solana-only market-opening layer from an India-based team. Orders for a new asset (a token launch, a tokenized stock after a weekend) are escrowed on chain; when the call closes, every filled order pays one clearing price, and the market opens on Meteora at that price. The protocol underneath, Opening Cross, is open source (Apache-2.0), so other Solana venues can call it with an SDK or a single CPI. Every result can be recomputed from chain data by an independent verifier. It is proved on Solana devnet with five deployed programs; there is no mainnet deployment, no external audit and no external users yet.

## 3b. Judging criteria mapped to evidence

| Criterion (listing) | Our case | Evidence | Honest limit |
|---|---|---|---|
| Ecosystem Impact: real value to Solana through infrastructure, tooling or a product people need | Infrastructure and tooling: an open auction protocol, SDK, Rust CPI crate, REST and WebSocket API, MCP server, independent verifier and 525 conformance vectors that any other venue can reuse; it sends liquidity to Solana-native Meteora, Raydium and SAS rather than away | `D4-sdk-and-cpi.md`, `D5-conformance.md`, `A1`, `A2`, `A3`, `A4` evidence files | The ecosystem benefit is potential: no other venue has integrated yet |
| Product-Market Fit: clear problem, defined user, early signs of traction | Problem: nobody agrees the first price of a new market. Users: issuers opening a market and investors bidding in it. Early traction: **none**. Devnet activity is our own test runs (the live indexer, 51 crosses opened, 38 with a clearing price on 2026-10-12). | live `/v1/stats`, `W2-live-deployment.md` | State "no external users" in the video. A named pilot would change this (HUMAN, H8) |
| Growth Potential: brings new users to Solana or deepens engagement | Deepens engagement: each cross escrows, claims and refunds on chain and seeds a Meteora pool; reopens of tokenized stocks bring a recurring weekly event. Not measured. | `FEATURE_STATUS.md` rows X1, V2 | Weekly generator not built; no growth data |

## 4. Why a Solana-only, India-team entry is credible (and what is not claimed)

- Solana-only claims are checkable: `programs/` holds five Anchor programs; `Anchor.toml` and the deployed ids are Solana devnet (README "Programs" table).
- The India link is the team and the registration, nothing in the product pretends to be India-specific. Do not add India-market claims (UPI, rupee, regulation) unless built; none is.
- Regulatory exposure for Indian residents (FIU-IND, ODI/FEMA for offshore holding) is an open legal item (H1, H2) and must not be glossed over if a judge asks.

## 5. Video

Use the Colosseum pitch video as the single link. The optional India add-on script is [`video/india-addon.md`](video/india-addon.md) (20 seconds, on camera, HUMAN content). Footage still to be recorded: [`video/footage-plan.md`](video/footage-plan.md).

## 6. Submit checklist for this target

See [`checklist.md`](checklist.md), section "Superteam India".
