# W2A-L2 / X15: an open preset registry, with performance

Date: 2026-10-13. Code: `packages/preset-registry` (9 tests), `services/api/src/routes/presets.ts` (5 tests over Postgres), migration `015_presets.sql`, `services/api/scripts/presets-devnet.ts`. Decision: ADR-0308. `tsc` clean for both.

## What it does

Anyone can publish a preset: a document signed by its author with an id, a version, the create-cross fields it sets (kind, disclosure, supply mode, price levels, step, windows, order cap), tags and an optional declared royalty. It is valid only if its fields are ones the program accepts (levels 2 to 256, a sealed call has a reveal window and an open one has none, a minting preset is a launch or recurring cross); it must be signed by its author's key; a published version is never changed, a new version must be higher. A cross is attributed to a preset by a memo (`oc-preset:1:<author>/<id>@<version>`) in its **creation transaction**, so attribution is on chain without a program change and an author cannot claim a cross that did not use the preset. `GET /v1/presets/:author/:id/performance` reads each cross's creation transaction once (a read that fails is tried again later) and reports, for the crosses that carried the memo: how many, how many finished, the print rate with a Wilson 95% interval, median orders and bidding wallets, median share of the larger side that traded, and how many had only the issuer's own wallets as bidders. Below a minimum sample there is no headline, and every response states what the figures do not show.

## Tests

Validation of each field and the sealed/open and minting rules; a signature that is not the author's, a tampered body and an invalid body are each refused; the memo round-trips and rejects what it did not write; performance with and without enough crosses, with no-print crosses and a live one, and with nothing. Routes: publishing, a stale or repeated version refused (409), the newest-version list with tag and kind filters, every version of one preset, the `use` endpoint with the fields and the memo; attribution counting only memo-carrying crosses (a cross with the same values and no memo, and one with another preset's memo, are not counted), each creation transaction read once, a cross whose transaction cannot be read yet counted later.

## On real devnet

A preset signed by the ops key was published; two real crosses were created on devnet, one with the preset's memo in its creation transaction (`5d7Zmc58...`, cross `ANUrVtKM...`) and one without (`2mwqoiry...`, cross `DgpbhABn...`). Read into a scratch database by the indexer and attributed by the route reading each transaction from devnet: the cross with the memo was attributed to `open-reopen-5m@1`, the other was not (`PASS`), performance showed 1 cross, none finished yet.

## Not covered

**Royalties are not paid.** A declared royalty is a claim in the document. Sharing a fee with a preset's author (Meteora's Dynamic Fee Sharing with `fee_claimer` = a launch PDA, the feature's description) needs a program change in `cross_settle`/`cross_core` and is recorded as needs-program. Performance is not a ranking and not causal: a preset that attracts better issuers looks better without being better. The issuer wizard does not yet read this registry or add the memo (the web workstream's); `/v1/presets/.../use` returns what it needs. A preset does not set a price, supply or raise.
