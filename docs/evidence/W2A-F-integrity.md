# W2A-F: integrity analysis (F2, F3, F6, F8, F9, J3, V5)

Date: 2026-10-13. Code: `packages/integrity` (analysis, 32 tests), `services/api/src/routes/integrity.ts` (13 routes, 9 database-backed tests), migration `services/indexer/migrations/012_integrity.sql`, `services/monitor/src/checks/backing.ts` (3 tests). Decision: ADR-0302.

## What each row is

- **F3 holders and clusters.** `readHolders` lists the largest holders of a mint (the RPC returns at most 20), labels each owner with the fact behind the label (mint authority, creator or payee of a cross selling the token, a protocol pool authority constant taken from the protocol's own IDL, an account owned by a protocol program, a burn address, a team wallet the issuer signed for), and totals by kind. `traceFunding` reads a wallet's oldest transactions for its first inbound SOL; `clusterByFunding` links wallets that share a first funder or where one funded another, ignores funders that look like services (listed, or having funded 25 or more wallets), and says which it ignored.
- **F8 conflicted wallets.** `findConflicts` flags a bidder that is the issuer, its payee, the settler, a declared team wallet, funded by the issuer, or sharing the issuer's funder (high or medium, each with its evidence), and reports the share of known volume flagged.
- **F2 organic volume, version 0, experimental.** A pair of bounds counted from facts: lower = volume of bidders shown independent, upper = volume not shown inorganic (minus conflicted volume and the self-trade a cross-side funding cluster could have made). Wallets funded by a service, untraced wallets and one-side clusters sit between the bounds and are named.
- **F9 supply truth.** An issuer-signed supply declaration is checked against the mint account (supply, mint and freeze authority), what finalized crosses sold, and the labelled holders. Fees are reconciled by the three-source ledger already published at `/v1/fees/ledger` (W4).
- **F6 backing.** A signed attestation from a trusted attester is checked for signature, mint, age and coverage: verified, stale, undercollateralised or unverifiable. A monitor check reports a token that is not verified.
- **V5 rating feed and J3 cited brief.** A version-0 rating (weights ours, not fitted) is recorded for each finished cross; the track record scores ratings against outcomes and says so when they do not beat chance or the sample is too small. The brief is built from templates filled with cited facts; claims are checked against the same facts.

## Tests

`packages/integrity`: 32 passed. They include wash injection: 30 independent bidders score 10,000 / 10,000 bps; adding 6 sybils funded by one wallet that bid on both sides lowers both bounds, flags one cross-side cluster with a potential self-trade of 1,500 and counts it once in breadth; the issuer bidding on its own cross lowers the upper bound to 7,500; a faucet-funded population is not linked and scores zero lower bound. The protocol authority constants are tested to appear in the IDLs they cite. The rating, the exact binomial tails, the permutation test (seeded, repeatable), a rating that does predict, one that does not, and one that merely matches a lopsided base rate. The brief test checks that every number in a sentence appears in its cited values.

`services/api` integrity routes: 9 passed against Postgres 18 with a scripted RPC: conflicts flagged and each wallet's history read once; wash injection through the route; a listed service funder not linked; 404, 400 and 501; holders labelled and a team declaration changing a label; who may post which document (a stranger 403, a forged body 400, a future date 400); supply reconciled; backing refused from an untrusted signer, verified from a trusted one, then undercollateralised by a newer attestation; a rating recorded once and a track record that makes no claim; a brief and claim checks. `services/monitor`: 30 passed (3 new). `tsc` clean for all three.

## Real runs

Devnet, cross `DfggnrfMbn7J47R2HYuJ1enZYSMzHmsyPTgVzkgWpe9T` (the market-maker run; its events read into a scratch database by the indexer's own ingestion path, wallet histories read from real devnet over a two-endpoint failover):

- Conflicts: 3 of 3 orders, 100% of known volume flagged high. The maker `HjSYwwj6...` and taker `ESbKzKFc...` were each funded by the creator `DTB3Jtxb...` (40,000,000 and 15,000,000 lamports, tx `2JYLQXaG...`), which is true: one operator ran both sides.
- Organic volume: lower 0, upper 0 bps; one funding cluster of the two bidder wallets, linked by "both received their first SOL from DTB3...". The interval correctly says none of this volume is shown organic.
- Holders of the base mint `9Yqqwuba...` (supply 600,000,000): 33.33% in an account owned by the cross_core program (labelled protocol with that basis), 33.33% each in the maker and taker wallets, in one cluster holding 66.66%.
- Documents: a team declaration and a supply declaration signed by the creator were accepted (201). Supply reconciled: SUPPLY_MATCHES, MINT_AUTHORITY_SET (warn), SOLD_WITHIN_SUPPLY (100,000,000 of 600,000,000), circulating 400,000,000.
- Backing: "unverifiable, no attestation has been published" (the honest answer for a token with none). Rating: 24 of 100 on 90 of 100 weight, breadth 0, organic 0, clearing 50. Brief: 7 statements, each cited. Claims "cleared at 1550000" supported; "2 orders" and "40 orders" contradicted (actual 3); "going to the moon" returned unparsed. Track record: "0 rated crosses have a recorded outcome; at least 20 are needed ... No claim is made."

Mainnet, read-only, token `2qR7GAf4...` from the latest successful DBC transaction (public Tatum endpoint): 99.99% of the 1,000,000,000,000,000 supply is held by `FhVo3mqL...`, labelled "Meteora Dynamic Bonding Curve pool authority" from the IDL constant, and one fresh wallet holds the rest. This confirms the pool-authority label on a real DBC token.

## Not covered

- **F2:** no Jito bundle data (mainnet only, and a call auction is not ordered by arrival, so its value here is unproven); not validated against labelled real wash trading, only against synthetic injection; first-funder tracing only, so a wallet funded through an intermediary is not linked; nothing gates graduation or a tier on the score, which needs a policy and, for graduation, a program. Devnet crosses only.
- **F3:** funding tracing on mainnet was not completed: the public mainnet endpoints rate-limited `getSignaturesForAddress` (HUMAN_TASKS H26). It is verified on devnet. A holder beyond the 20 largest is not seen. Mainnet exchange and market-maker labels are not provided because none could be verified.
- **F6:** nothing proves a custodian holds what the attester signed; that is the trusted party's claim. Which attesters to trust is the operator's decision (H32). An automatic pause of one asset needs a per-mint pause in the program (needs-program); the monitor only warns because the program's only pause is protocol-wide. No real custodian attestation was available, so the verified path ran on test keys.
- **V5:** no outcome data exists on devnet, so no hit rate is available and none is claimed; the "venture index over every Solana raise" (cross-venue) is not built.
- **J3:** the brief is templates over cited facts; a fluent research note written by a model needs an LLM key and is not built.
- **F9:** the declared supply is the issuer's word, signed; the check is that the chain agrees with it and the authority is as claimed.
