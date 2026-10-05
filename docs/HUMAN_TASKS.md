# Human tasks

Steps only a founder can take (legal, money, identity, accounts, outreach, on-camera). Each lists exactly what to do and what it unblocks. Engineering continues around every item.

| ID | Task | Exact steps | Unblocks | Status |
|---|---|---|---|---|
| H1 | Incorporate the company | Choose jurisdiction with counsel (India Pvt Ltd + offshore holding is the common pattern for crypto; ODI/FEMA rules apply to Indian residents investing abroad). Register the entity and open a bank account. | Audits, contracts, mainnet with public money | OPEN |
| H2 | Engage securities/crypto counsel | Brief counsel on: recurring crosses for ownership coins, tokenized-stock reopen crosses, revenue-share tokens, KYC/sanctions duties, India FIU-IND registration. Ask for a written opinion per asset class. | L5, any public-money mainnet cross | OPEN |
| H3 | Register on Colosseum | colosseum.com → create account → country **India** → create team "Opening Bell" → every member registers. | G1 | OPEN |
| H4 | Record videos | Pitch (2–3 min, on camera) and demo (≤ 3 min) once M5 W3 is live on devnet. Script will be in `docs/pitch/`. | G1 | OPEN |
| H5 | Submit to Superteam Earn | Meteora DBC listing and Superteam India listing; fields listed in internal notes; links from H3/H4. | G1 | OPEN |
| H6 | Engage and pay auditors | Request quotes from two Solana auditors once L1 is ready. | L2, L4 | OPEN |
| H7 | Accounts and domains | Buy the domain; create X account; Apple/Google developer accounts; paid RPC with Yellowstone gRPC (e.g. Helius/Triton) — share API keys via `.secrets/`, never chat. | W2 hosting, D1 at scale, MO2 store release | OPEN |
| H8 | Users and issuers | Recruit 5–10 named external testers and one first issuer for L6. | L6, traction | OPEN |
| H9 | Meteora Token Badge for gated mints | Ask Meteora (Discord dev channel / Telegram @meteora_dev) to issue DAMM v2 Token Badges for our gated (Default Account State) mints, citing ADR-0004 and the DP8 evidence. | Gated assets graduating to DAMM v2 | OPEN |
| H10 | Top up the devnet operations key | Send ~20 devnet SOL to `DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC` (faucet.solana.com with GitHub sign-in, or any devnet faucet). The CLI faucet is rate-limited for this key. | Further devnet deploys/upgrades of cross_core (each full deploy costs ~5 SOL of rent) | OPEN |
| H11 | Pyth API key | Sign up at Pyth Terminal (https://pythdata.app/signup — free trial, paid plans for ongoing use), create an API key, and save it as `PYTH_API_KEY=...` in `C:\Users\prate\col\.secrets\pyth.env` (git-ignored). Since 26 Aug 2026 Hermes requires it, and stock tokens have no sponsored Pyth push accounts, so reopen crosses must post fresh pull updates. Then run `pnpm --filter @opening-cross/devnet-proofs dp:oracle-pull`. | Oracle-guarded reopen crosses (C3), DP15 pull proof | OPEN |
