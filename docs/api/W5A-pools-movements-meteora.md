# Wave 5.1 routes: pools, treasury movements, Meteora depth, receipts and gate presets

Reference for the routes the wave 5.1 packages added to `services/api`. Every transaction route answers an unsigned transaction and holds no key; every read says where its figures came from. Request shapes are documented at the top of each route file (`src/routes/pools.ts`, `settle-meteora-extra-tx.ts`, `treasury.ts`); `apps/web/public/llms.txt` lists every route with a line each, and a test keeps that list equal to what the server registers. Evidence: `docs/evidence/W5-1B.md`, `W5-1C.md`, `W5-1D.md`, `W5-1E.md`, `W5-1G.md`, `G-gate-rules.md`; decisions ADR-0900 to ADR-0965.

## Pools and the router (ADR-0920 to ADR-0925)

| Route | What it answers |
|---|---|
| `GET /v1/router/quote?base&quote&side&amount` | The ranking of venues for one order: live crosses of the pair, the Meteora DAMM v2 pool and DLMM pair the adapters open for it (priced from the pool's own accounts, fee included, executable now, with the swap route), and Jupiter on mainnet. `pools=0` leaves the pools out. A pool that cannot be read, or does not exist for the pair, is under `excluded` with its reason; it never fails the quote |
| `GET /v1/pools?base&quote` | The pools found at the addresses the adapters open them at, with price, reserves, fee and depth both ways |
| `GET /v1/pools/:address` | One pool's health: price, reserves, fee, depth at slippage limits, price impact of set sizes, the bin ladder of a DLMM pair, persistence while the API has run |
| `GET /v1/pools/route?base&quote&side&amount[&pool]` | The router's answer with the pools it read named; `pool=` names a pool elsewhere |
| `GET /v1/pools/by-cross/:address` | The issuer's view: the cross's pools, how far each is from the clearing price, how deep, what is left of the ladder |
| `GET /v1/pools/summary` | The pools of recent crosses in one answer (the dashboard's liquidity section) |
| `GET /v1/depth/cross/:address?sizes=` | A cross's own depth and the price impact of orders of set sizes, beside the pools' slippage for the same sizes |
| `POST /v1/pools/swap-tx` `{ pool, owner, inputMint, amountIn, maxSlippageBps?, minimumAmountOut? }` | An unsigned exact-input swap with the quote it was built from; the minimum output is enforced by the program, and a minimum above the quote is refused with `MINIMUM_ABOVE_QUOTE` |

## Treasury movements (ADR-0930)

`GET /v1/treasuries/:address/movements?kind=&direction=out|in&asset=quote|coin&teamOutflow=true&counterparty=&minAmount=&sinceSlot=&before=&limit=` lists the events that moved value across a treasury's boundary, newest first: `spend`, `proposal_spend`, `tranche_release`, `grant_release`, `sweep`, `redemption`, `nav_redemption`, `distribution_deposit`, `revenue_share`. `kind` takes several kinds, comma separated; `before` is the previous answer's `next`; `limit` is 1 to 200. A malformed filter is a 400 naming the filter; a database without the movement table (migration 020 not applied) is a 503. `teamOutflow` marks the three outflows the program's team guard covers. `GET /v1/treasuries/:address/movements/totals?sinceSlot=` sums by kind, direction and asset; quote and coin are never added together. MCP: `oc_list_treasury_movements`.

`GET /v1/crosses/:address/settlement` now carries `futarchyDaos` and `presales`: the MetaDAO DAOs and fixed-price tranches the cross opened, from the indexer's `settle_futarchy_daos` and `settle_presales`. Empty lists are the normal answer until the batch 2 build of `cross_settle` is deployed (H27).

## Meteora depth (ADR-0910 to ADR-0916)

Every route below reads the chain first and refuses in words; none is a `cross_settle` instruction, so the release check is whether the external program exists on the cluster (`409 EXTERNAL_PROGRAM_MISSING` otherwise).

| Group | Routes |
|---|---|
| Alpha Vault on either venue | `alpha-vault-init` takes `venue: "damm" \| "dlmm"`; `alpha-vault-withdraw`, `alpha-vault-close-escrow` (a depositor's exits); the other vault routes find the vault wherever it is |
| DAMM v2 reward slots | `GET /v1/crosses/:address/damm-rewards`; `POST /v1/tx/damm-reward-init`, `-fund`, `-claim`, `-update-funder`, `-update-duration`, `-withdraw-ineligible`; `damm-lp-join` (a holder joins the pool so a reward stream can pay them) |
| Conviction ladder | `GET /v1/crosses/:address/ladder?position=`; `POST /v1/tx/ladder-limit-place`, `-cancel`, `-close` (DLMM limit orders, revocable); `ladder-position-place` (a position, optionally `lockUntil`, allowed only while the pair is closed); `ladder-rebalance-withdraw` then `ladder-rebalance-relay` (the issuer's two-step rebalance) |
| Fixed-price tranche, buyer side | `presale-deposit`, `presale-claim`, `presale-creator-withdraw`; `open-fixed-price-presale` finds a transfer hook from the mint and refuses one it does not know |
| Fee sharing | `GET /v1/fee-share/:base/:mint` returns `claimable` for every recipient; `fee-share-create` takes two to five recipients |
| Curve | `POST /v1/curve/calibrate` `{ cross \| clearingPrice, bids: [{ price, quantity }], segments?, headroomBps?, floorBps? }` returns band edges and liquidity weights from the demand the call revealed, or says `basis: "default"` with the reason when there is nothing to read |

## Receipts, fees and gates

- `GET /v1/crosses/:address/receipt-attestation[?optional=1]`: the signed, Merkle-anchored attestation of a settled cross's receipt (ADR-0941). 404 until one exists, or `200 { attestation: null }` with `optional=1`; 400 for a malformed address. The attestation verifies against `GET /v1/promises/signer`.
- `GET /v1/fees/ledger` and the statements read a cross's referral from its rules tail: an entry carries `referrer` and `referral`, expects the referrer's transfer in the finalize transaction, and `totals.verified[mint].referralFee` counts the referrals apart (ADR-0962).
- `GET /v1/gates/presets[?restricted=KP,IR&quoteUnit=1000000]` returns the three gate modes as `presets` and the jurisdiction rule templates (Reg D 506(c), Reg S, Reg CF, MiCA, VARA, open) as `jurisdictionPresets`, each with its rules, resale lock, notes and primary sources; every one says `requiresCounsel` (ADR-0903).
- `GET /v1/alerts/subject?address=` says what an address is to alerts (a token, a treasury, a cross, a market, nothing) and which wallets following it would cover (ADR-0940).
