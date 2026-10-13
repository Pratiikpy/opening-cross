# Devnet proof — treasury read side: indexer, API, rights cards and the disclosure feed (X2 / A5 read side, E5)

Run: 2026-10-13T09:33:54.059Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/treasury-live-proof.ts`. A real devnet treasury is created, indexed from finalized chain data by `services/indexer/src/treasury-main.ts` into a real Postgres, and served by `services/api/src/routes/treasury-dev-server.ts` (the main.ts wiring plus `registerTreasury`) pointed at devnet. Every API figure is compared with an independent chain read made by this script.
The treasury uses production-shaped terms: a 1,000-quote allowance per 30-day period and a 7-day grace. The auditor, team and holders are throwaway keys, so this proves the mechanism and not any real audit process. The disclosure update it posts is a devnet test and says so in its own signed text.

Not covered: a mainnet treasury (none exists); a lapse, liquidation or redemption driven by this script (those are covered by `A5-treasury-devnet.md`, and the API reads the earlier proof treasuries here); the wrong-sequence and forked-chain refusals over a live cluster (covered by `services/api/test/treasury.test.ts` against a real Postgres, with an injected transaction reader); the web pages (screenshots are recorded separately in this file by the web run).

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| create | a treasury with a 1,000-quote allowance per 30-day period and a 7-day grace exists on devnet, with a live attestation and 250 quote already spent | PASS | [3gkkHL8X…](https://explorer.solana.com/tx/3gkkHL8XviUu1FzNBzQpbJWzoCPTFRMcXGjua9GpWE5TXRgszwyo5VcDzdHPZhC9bwk7A69LX3pxiDche9JfEJmf?cluster=devnet) | treasury 2nzeG7PuWGKFoZ8dR3WSeZD6XmeWBLAmCqW2ewh7pdKQ, vault C2DAwsKPhRhyeM923iLY8QVSaeRNhH9cKimr41qGCokS holds 9750000000, attestation GFqNrkvABbDxXh1VrKxeYoJoJYgqUEUV6YMgaeGA88S expires 1794907999 |
| attest-and-spend | the attestation and the spend are on chain | PASS | [htqAKcLc…](https://explorer.solana.com/tx/htqAKcLcvyMorBhpvZimEBtANbJtG42EDVq93uMqBFsWpL28HQMNKgPd6nPszKB65XMfu6GmKcrh98bYhZVtt8A?cluster=devnet) | spend moved 250000000 quote atoms to the team |
| indexer | the treasury indexer (finalized commitment) projected the creation and the spend into Postgres | PASS | — | 1 pass(es); events TreasuryCreated, Spent; created_at 1791883994; 8 treasuries indexed in total (earlier proof runs included) |
| api-detail | GET /v1/treasuries/:address returns the terms, spend window, vault, supply and attestation exactly as an independent chain read does | PASS | — | vault 9750000000 (chain 9750000000); remaining 750000000; attestation GFqNrkvABbDxXh1VrKxeYoJoJYgqUEUV6YMgaeGA88S live=true expiry 1794907999; mint authority null; indexed=true |
| api-upgrade-authority | the program upgrade authority the API reports is read from the loader accounts | PASS | — | reported DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC (program account is 36 bytes) |
| rights-cards | the API returns the rights cards with live lines; every card cites an enforcement or states an absence | PASS | — | 16 cards; spend-cap: 750 quote of 1,000 quote is left this period; the allowance is whole again at 2026-11-12 09:33 UTC. |
| api-list | GET /v1/treasuries lists this treasury and the earlier proof treasuries with their live state | PASS | — | 8 treasuries: Active, Active, Active, Active, Active, Liquidating, Active, Liquidating |
| api-liquidated | an earlier proof treasury that was liquidated and redeemed reads as Liquidating with its snapshot and a redemption history | PASS | — | H1ecYsGnTYSo12XYSzKBTVsemeEARC3ey9aPQr4ThQFg: snapshot {"vault":"8000000001","supply":"1000000000"}, redemptions 2, paid 8000000000 |
| api-refusals | an address that is not a treasury answers 404 and junk answers 400 | PASS | — | 404 no treasury of this program at that address; 400 address must be a base58 Solana address |
| update-posted | the owner CLI signs an update, anchors its id in a Memo signed by the treasury authority, and the API stores it | PASS | [3uTKf7Xp…](https://explorer.solana.com/tx/3uTKf7XpvvsKhwsVRafwsLXZgj1QT62eyQXzrnxewL7doLApUENcZoHZobWvUTYYHm6VeV6BkWVkZhyrcQvnSRMB?cluster=devnet) | update 7e7a1375936a85930435a68ecb7f48e62db78dab15c3e339c98b82d8a30660d2; memo text read back from chain: opening-cross/treasury-update/v1 treasury=2nzeG7PuWGKFoZ8dR3WSeZD6XmeWBLAmCqW2ewh7pdKQ seq=1 id=7e7a1375936a85930435a68ecb7f48e62db78dab15c3e339c98b82d8a30660d2; block time 1791884026 |
| update-spend-check | the update's declared spend is compared with the program's own Spent events for the span it covers | PASS | — | declared 250000000, on chain 250000000 |
| disclosure-state | the treasury page now reports the reporting clock running from the anchored update | PASS | — | {"updateCount":1,"state":"current","basis":"last-update","basisAt":1791884026,"requestedAt":1794476026,"overdueAt":1795080826,"note":"The latest update is within one allowance period."} |
| updates-list | GET /updates returns the stored update unchanged | PASS | — | 1 update, sequence 1 |
| refuse-replay | posting the same update again changes nothing | PASS | — | HTTP 200, duplicate=true |
| refuse-tamper | an edited body no longer matches its id and is refused | PASS | — | HTTP 400: the update does not verify: ID_MISMATCH |
| refuse-stranger | a key that is not the treasury authority cannot post an update, even with a valid signature and a real Memo | PASS | — |   if (!res.ok) throw new Error(`the API refused the update (${res.status}): ${out.error ?? JSON.stringify(out)}`); |
| refusals-store-nothing | none of the refusals stored anything | PASS | — | 1 update stored |
| cleanup | unused devnet SOL returned to the promiser key | PASS | — | 173751040 lamports returned |

## Web pages (run separately from the script above)

`/treasury` and `/treasury/2nzeG7PuWGKFoZ8dR3WSeZD6XmeWBLAmCqW2ewh7pdKQ` (the treasury created by this run, with its devnet test update) were rendered by the Next.js app against the local API process above, which read devnet, with `apps/web/e2e/visual.mjs`: light and dark, 1440 and 390 wide. Result: 12 of 12 pass (axe WCAG 2.1 AA clean, zero console errors, no failed requests, no horizontal overflow). The first mobile run found a 52 px overflow from unbroken addresses; it was fixed and re-run. Screenshots are in `docs/evidence/screens/treasury/` and were read: the list shows eight devnet treasuries (two liquidated and closed, two from the earlier proof that are honestly marked "Update overdue", four active and current); the detail page shows live balances, terms, the disclosure clock, the update with its anchor and the spend check ("They match"), the rights cards and the program events.

Not covered by the web run: the live site (https://opening-bell-psi.vercel.app) and live API, which do not have these routes until the server.ts line is added and both are deployed.
