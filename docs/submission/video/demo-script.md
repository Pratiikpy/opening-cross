# Product demo video script (Colosseum: at most 3 minutes)

Colosseum FAQ: "A product-demo video of no more than three minutes explaining how the product works." This is a screen recording with narration; show the real product, real devnet transactions and one command a stranger can run. Target 2:50. Record at 1440 x 900, light or dark (pick one), cursor visible, no cuts that hide a loading state.

Live product: https://opening-bell-psi.vercel.app (web on Vercel, API on AWS at `https://98-87-59-136.sslip.io`, network devnet). Before recording, check `GET /v1/health` answers `"ok":true` and `recentDriftAlerts` is 0.

| Time | Screen (exact) | Narration | What proves it |
|---|---|---|---|
| 0:00 to 0:12 | Home, `/` | "This is Opening Bell, running on Solana devnet. One price for everyone: orders collect, then every filled order pays one clearing price." | The footer states devnet and no offer of securities; leave it visible |
| 0:12 to 0:35 | `/crosses` list, then open the settled cross `8U6zdtjTiJaoc2StMuEaf8jVwG3EJSEvVbzHxEJAppDx` | "This cross cleared at 1.5, with 2,500 tokens traded at that one price. Two orders, none open, closed on 12 October." | The page shows "Settled", clearing price 1.5, 2,500 tokens, orders 2 (live, read 2026-10-12); A1 evidence step `clear` |
| 0:35 to 1:05 | Terminal: `pnpm --filter @opening-cross/verifier verify 8U6zdtjTiJaoc2StMuEaf8jVwG3EJSEvVbzHxEJAppDx --rpc https://api.devnet.solana.com` ending `"verified": true` | "I don't ask you to trust the page. This command rebuilds the result from the on-chain order book with a second implementation, and prints a fairness proof. On-chain price and recomputed price match." | `D5-verifier-devnet-sweep.md` lists this cross as VERIFIED, P* 1,500,000 with 2,500,000,000 atoms matched. Recorder needs the repository cloned (private, H21) |
| 1:05 to 1:45 | Explorer (devnet) for the A1 run: the `open_dbc_pool` transaction, then `bind_dbc_mint`, then the swap (links in [`meteora-dbc-pack.md`](../meteora-dbc-pack.md) section 3.1) | "After the clear, the settlement program opens a Meteora bonding-curve pool. Its start price is read back from chain and equals the clearing price. The mint authority moves to the cross, winners claim at that price, and at finalize the mint authority is revoked. A trade on the live pool then runs our transfer hook." | `A1-dbc-continuation-devnet.md`: pool `sqrt_price` equals expected; compute units 152,915 and 56,129; mint authority None |
| 1:45 to 2:15 | A wallet flow on an **open** cross (see footage plan): connect a Wallet Standard wallet, place a bid, see the escrow line, then claim after the close | "As an investor I connect any Solana wallet, bid at the most I'd pay, and the money sits in escrow. After the close I claim: I get my tokens at the clearing price and the rest back." | Outcome read from chain after the claim (token balance), as in `apps/web/e2e/live-devnet.mjs` |
| 2:15 to 2:35 | A cross page's "Signed price band" panel, then `/accuracy`, then `/premium` | "Before the close we signed an estimate of the price; afterwards the chain graded it. The track record says it claims no coverage yet. And the premium monitor shows what a real stock-token swap costs, by size and session." | `T-trust-devnet.md`; `/accuracy` and `/premium` as served by the API |
| 2:35 to 2:50 | `/developers` | "Everything the app does is an API: an SDK, a Rust CPI crate, REST and WebSocket, and an MCP server for agents. It's Apache-2.0. It's devnet only, with no audit yet." (Say "Apache-2.0, open" only if H21 is done.) | `D4-sdk-and-cpi.md` |

## Pre-flight

1. API health: `curl -s https://98-87-59-136.sslip.io/v1/health`.
2. Open the cross page and confirm "Settled" and price 1.5 (if the page shows an unavailable state, the API is down: do not record).
3. Run the verifier command once off camera; if the public devnet RPC answers 429 it retries with backoff and exits 2 with one line when it cannot read the cross (D5 sweep note), so a second attempt is fine.
4. Prepare the open cross for the wallet segment per [`footage-plan.md`](footage-plan.md): it must open at least 12 minutes before you need it.
5. Clear the tab bar and notifications. No keys, seed phrases or `.secrets` paths on screen.

## What not to show or say

- Do not say mainnet, "live users", "volume" or "audited".
- Do not show the landing tile "crosses that did not print and refunded everyone" (reads 0 while no-print crosses exist, see README).
- Do not call the auction first or only (DP10).
