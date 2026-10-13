# The rules, treasury and settlement layer: SDK builders, API routes, indexer, verifier

Workstream W3A. This is the reference for the screens built on top of the Wave 2D programs (issuer: create a cross with rules, draw, challenges, treasury terms; holder: classes, lockups, votes, stakes, claims). Everything here is built and tested against fixtures and the generated clients; **none of it can touch a new instruction on devnet until the programs are upgraded (docs/HUMAN_TASKS.md H27)**. The old programs keep working through the same routes: `docs/evidence/W3A-builders-devnet.md` is the run against devnet.

What "the program is not deployed" means for a caller: a transaction for a new instruction is built correctly and the deployed program refuses it with `InstructionFallbackNotFound` (Anchor error 101). A cross created by the deployed program has no rules tail, so every route below answers for it as for a cross with every rule off.

## Conventions

- Integers that can exceed 2^53 are decimal strings in requests and responses (a safe integer is also accepted in requests). Basis points and seconds that fit are numbers. Times are Unix seconds. Addresses are base58.
- A transaction route answers `{ transaction, signers, ...facts }` (one version-0 transaction, base64, signatures empty, the wallet named in the request paying) or `{ transactions: [{ transaction, signers }], ...facts }` (send them in order, each after the one before has landed). `signers` lists every key that must sign: usually the named wallet; a fresh keypair signs too where noted (`limitOrder`).
- Errors are `{ "error": "<sentence>", "reason": "<CODE>", ...details }` with status 400 (the request is malformed: the sentence names the field), 404, 409 (the state is wrong: `reason` says which), 422 (the request is well formed and the protocol would refuse it: `reason` and details say why) or 503 (the RPC is busy; retry). A `reason` is stable and meant for branching; the sentence is meant for a person.
- Nothing is signed or stored by the API. Every check the program would make from chain state is made first, so a person reads a reason before signing, not a program error after. The program remains the authority.

## SDK builders (`@opening-cross/sdk`)

All return `@solana/kit` instructions. `CrossView` is `{ address, data, ext? }`; `ext` is the rules tail (`readCrossExt(accountBytes)`, or `readRuledCross(address, bytes)` which returns both), null or absent for a cross without rules, and every builder then behaves as it did before the rules existed.

| Builder | Instruction | Notes |
|---|---|---|
| `buildCreateRuledCross(input & { rules?, feed? })` | `create_cross` + `set_rules`, then shards | Returns `{ cross, ensureCreatorQuote, atomic: [create, setRules], shards, auxShards, classBook, lockVault }`. **`atomic` must be one transaction** (the rules are only accepted in the slot the cross is created in). `wireSize(feePayer, ixs)` and `assertFits` measure it against the 1,232-byte limit; the lists in `set_rules` are sent unpadded, so each insider named costs exactly 32 bytes. |
| `buildSetRules({ creator, cross, rules, baseMint, quoteMint, quoteTokenProgram, calendar?, feed? })` | `set_rules` | Adds the remaining accounts the rules call for (halt state, lender feed, bond accounts, scaled-UI mint, calendar). |
| `checkRules(context, rules)` | none | The checks `set_rules` makes, as `[{ code, field, message }]`. |
| `buildPlaceOrder({ ..., class?, lockSecs?, now? })` | `commit_order` / `commit_order_ext` | Names the shard of the ending bucket `now` falls in. `orderPlacement(cross, owner, nonce, now)` returns `{ epoch, bucket, shardIndex }`. |
| `buildReveal`, `buildCancel`, `buildClaim` (last argument `OrderFacts = { ext: OrderExt, isBuy }`) | `reveal_order`, `cancel_order`, `claim` | `readOrderExt(orderAccountBytes)`. Throws for a cross with rules if the facts are missing. |
| `buildSettleBook(cross, { oraclePrice?, oracleAccounts?, now?, allowUndrawn? })` | `merge_shard` (main, ending buckets up to the drawn one, extension shards) then `clear` | Throws `DrawRequired` until a needed draw has finished. |
| `buildFinalize`, `buildFinalizeWithAccounts` | `finalize` | Adds the referrer's quote account when a referral is set. |
| `buildDrawBegin(cross)`, `buildDrawFinish(cross)` | `draw_begin`, `draw_finish` | Anyone may send them. `drawPurpose(ext, revealEndTs, now)` says which draw is owed; `drawProgress(ext, slot)` says whether `finish` can run. |
| `buildReleaseLocked(cross, payer, owner, nonce)` | `release_locked` | Creates the owner's base token account if needed. |
| `buildPushRefunds(cross, [{ owner, nonce, side }])` | `push_refunds` | 1 to 12 orders. |
| `buildCloseApplicant(cross, owner)` | `close_applicant` | |
| `buildChallengeInsider`, `buildResolveChallenge`, `buildExpireChallenge`, `buildSetArbiter` | the four challenge instructions | `CHALLENGE_DEPOSIT_LAMPORTS` is what a challenge costs on top of rent. |
| `buildInitHaltState`, `buildSetHalt`, `buildSetCorporateAction`, `buildSyncPause`, `buildObservePrice`, `buildInitPrintFeed`, `buildSetFeedPublishers` | the halt and lender-feed instructions | Keyed by base mint. |
| `buildCreateSeries`, `buildSpawnNext`, `buildSetSeriesActive`, `buildSeriesWithdraw` | the series instructions | |
| `buildMissingRuledAccounts(cross, payer, exists)` | `init_shard`, `init_class_book`, `init_lock_vault` | What an interrupted create left undone. |

`@opening-cross/treasury-client` (`TreasuryContext = { treasury, coinMint, quoteMint, coinTokenProgram, quoteTokenProgram }`): `buildInitExt`, `buildPropose`, `buildVote`, `buildReclaimVote`, `buildExecuteProposal`, `buildNavRedeem`, `buildStake`, `buildUnstake`, `buildDepositDistribution`, `buildClaimDistribution`, `buildPayRound`, `buildMarkMissed`, `buildReleaseTranche`, `buildCreateGrant`, `buildReleaseMilestone`, `buildExpireGrant`, `buildPostDisclosure`, `buildRequestDisclosure`, `buildRecordAssignment`, `buildSweepUnclaimed`, plus the first release's `buildSpend`, `buildRecordAttested`, `buildRecordLapse`, `buildTriggerLiquidation`, `buildRedeem`. Where an instruction pays a wallet the builder returns an idempotent create of its token account first. Helpers: `attestationAddress`, `revenueAttestationAddress`, `milestoneAttestationAddress`, `spendAttestationAddress`, `assignmentAttestationAddress`; the arithmetic of the program (`navPayout`, `claimableOf`, `accumulatorAt`, `streamRelease`, `proposalPasses`, `proposalCap`); `checkExtParams` (what `init_ext` refuses); `getTreasuryExtEncoder` / `decodeTreasuryExt`.

`@opening-cross/adapters` already holds the `cross_settle` builders (`buildClaimPartnerFee`, `buildWithdrawPartnerSurplus`, `buildWithdrawPartnerMigrationFee`, `buildClaimPartnerPoolCreationFee`, `buildClaimPolFees`, `buildCreateGreenshoe`, `buildDeployGreenshoeBid`, `buildSettleGreenshoeLevel`, `buildFinishGreenshoe`, and the pool-opening builders). The pool-opening instructions take a pool design and are built by the issuer's tooling; the API routes below cover the payouts and the greenshoe.

`@opening-cross/client` mirrors all of it: `localTxBuilder(rpc)` reads the rules tail and the orders' facts from chain and builds the right accounts; `placeOrder` takes `class` and `lockSecs`; `api.getRules`, `api.treasury.*`, `api.tx.*` call the routes.

## Cross rules (`routes/rules-tx.ts`)

### The rules as JSON

`rules` is an object; every field is optional and means "off"; unknown fields are refused (400 naming them).

```
rules: {
  flags?: number,                          // 2 resumesHalt, 4 feedsLenders, 8 standardGrid, 16 guardScaledUi, added together (GET .../rules names them)
  guards?: { minRaiseQuote, maxMatched, totalSupply, minFloatBps, maxFdvX100, anchorPrice, moveBps, gridEstimate, haltSource },
  ending?: { endingSecs, buckets, cancelCutoffSecs, randomEnd, extensionMinSecs, extensionMaxSecs },
  identity?: { capQuote, maxOrders },
  alloc?: { reserveBps: [small, locked, priority], smallCapQuote, lotteryUnit, minLockSecs, lockVestSecs, earlyUntilTs, priorityGate, class1CliffSecs, class1VestSecs },
  neutrality?: { insiders: [address, ...up to 8], insiderCliffSecs, insiderVestSecs, bondQuote, challengeSecs },
  referral?: { referrer, shareBps },       // shareBps up to 5000 (half the protocol fee)
  oracleSet?: { extraFeeds: [hex32, ...up to 2], quorum, maxSpreadBps, offHoursWidenBps }
}
```

Amounts are decimal strings; `priorityGate`, `haltSource` and `referrer` are addresses; feed ids are 64 hex characters.

### Creating

- `POST /v1/rules/check` with the create-cross body plus `rules` answers `{ ok, issues: [{ code, field, message }] }` and builds nothing.
- `POST /v1/tx/create-cross-ruled` with the create-cross body (`creator`, `baseMint`, `quoteMint`, `baseTokenProgram`, `quoteTokenProgram`, `crossId`, `kind`, `supplyMode`, `disclosure`, `minPrice`, `tick`, `ticks`, `priceScale`, `openTs`, `closeTs`, `revealEndTs`, `integrator`, `integratorFeeBps`, `shards`, `maxOrders`, `proceedsTo`, optional `gateMint`, `oracle`, `calendar`, `settler`, `schedule`, ...), plus `rules` and, only if `flags` has `feedsLenders` and the feed is not the default, `feed`. Answers `{ cross, transactions, sizes, rules, issues: [], warnings }`:
  - `transactions[0 .. sizes.firstTransactions)` hold the creation and `set_rules` in one transaction; when it fits, the creator's quote account and (for a minting cross) the handover of the mint authority are in the same one, otherwise they come first in their own.
  - then one transaction per main shard, per ending-bucket or extension shard the rules call for, the class book and the lock vault (when the rules need them).
  - 422 `RULES_INVALID` with `issues` when a rule would be refused; 422 `TX_TOO_LARGE` when creation and rules cannot share a transaction (name fewer insiders or extra feeds); 422 `MINT_NOT_CROSSABLE` / `MINT_NOT_FOUND` as `create-cross` answers.
- `POST /v1/tx/init-shards` (existing) also creates the bucket shards, class book and lock vault a cross with rules lacks.

### Trading

- `POST /v1/tx/place-order-ext` `{ cross, owner, nonce, side, price, quantity, escrow?, salt?, class?, lockSecs? }` answers `{ transaction, signers, order, placement: { epoch, bucket, shardIndex, validUntil, cancelDeadline } }`. `class` 1 is a small identity-verified buyer (the cross's gate pass and `smallCapQuote`), 2 accepts a lockup of at least `alloc.minLockSecs` (`lockSecs`), 3 is priority. `placement.validUntil` is the last second the transaction names the right bucket's shard: **an open order in an ending period names its bucket's shard, and the chain clock decides the bucket, so build again after `validUntil` or when the program answers a wrong-shard error**. Sealed orders have no shard at commit. 422 `NO_RULES`, `CLASS_FOR_SELL`, `CLASS_UNAVAILABLE`, `LOCK_TOO_SHORT`, `LOCK_NEEDS_CLASS_2`.
- `POST /v1/tx/place-order`, `cancel`, `reveal`, `claim`, `finalize`, `settle`, `init-shards` (existing) read the rules tail and add the accounts it calls for. `settle` merges the ending buckets up to the drawn one and fails with 400 `DRAW_REQUIRED` while a draw is owed; extra oracle feeds default to the push-oracle account of each feed id.
- `POST /v1/tx/settle-ext` `{ cross, payer, oraclePrice?, oracleAccounts? }` is `settle` with the oracle accounts named explicitly.

### The draw

- `POST /v1/tx/draw-begin` `{ cross, payer }` answers `{ transaction, signers, purpose: "end" | "extension" }`. 409 `NOTHING_TO_DRAW` (with `revealEndTs`), `DRAW_PENDING`, `NOT_LIVE`.
- `POST /v1/tx/draw-finish` `{ cross, payer }` answers `{ ..., purpose, earliestSlot }`. 409 `NO_DRAW_PENDING`, `DRAW_TOO_EARLY` (with `earliestSlot`, `slot`), `DRAW_VOID`. The draw is the cluster's own block hashes, not a VRF.

### After the clear

- `POST /v1/tx/release-locked` `{ cross, owner, nonce, payer? }` answers `{ ..., releasable, lockup }`; 404 `NO_LOCKUP`; 409 `NOTHING_VESTED` (with `unlocksAt`).
- `POST /v1/tx/push-refunds` `{ cross, payer, orders: [{ owner, nonce }] }` (1 to 12; refund-only orders).
- `POST /v1/tx/close-applicant` `{ cross, owner, payer? }`.

### Issuer neutrality

- `POST /v1/tx/challenge-insider` `{ cross, challenger, subject, evidence }` (`evidence` is the hash of the document, 64 hex) answers `{ ..., id, challenge, depositLamports }`.
- `POST /v1/tx/resolve-challenge` `{ cross, arbiter, id, upheld, slash? }`; `POST /v1/tx/expire-challenge` `{ cross, id, payer }`; `POST /v1/tx/set-arbiter` `{ admin, arbiter }` (the protocol admin, H28).

### Halt states, the lender feed, series

`POST /v1/tx/init-halt-state` `{ authority, baseMint, venueSigner?, breaker?: { feedId, windowSlots, moveBps } }`; `set-halt` `{ signer, baseMint }`; `set-corporate-action` `{ signer, baseMint, flag }`; `sync-pause` `{ payer, baseMint }`; `observe-price` `{ payer, baseMint, priceUpdate }`; `init-print-feed` `{ authority, baseMint, quoteMint, publishers, minMatched }`; `set-feed-publishers` `{ authority, baseMint, publishers, minMatched }`; `create-series` `{ authority, seriesId, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram, config }` (`config` as in the SDK `SeriesConfigArgs`, with `rules` as above); `spawn-next` `{ series, payer, feed? }`; `set-series-active` `{ authority, series, active }`; `series-withdraw` `{ authority, series, mint, tokenProgram, to, amount }`.

### Reads

| Route | Answers |
|---|---|
| `GET /v1/crosses/:address/rules` | `{ cross, rules: { flags, guards, ending, identity, alloc, neutrality, referral, oracleSet } \| null, state: { draw, neutrality, clearing, noPrintReason }, calls: { classBook, lockVault, needsDraw, drawOwed, drawStatus, auxShards, cancelDeadline, endingStartsAt } }`. `rules` is null with a note for a cross without rules. Read from chain. |
| `GET /v1/crosses/:address/indicative` | `{ phase: "open" \| "ending" \| "no-book", coarse, indicative: { price, matched?, imbalance }, note }`. While the ending period is open the price is the nearest of eight bands and the imbalance a direction (`balanced`, `demand-heavy`, `supply-heavy`): the display rule of the apps, not secrecy (the chain account is public). **Apps show this route's `indicative` instead of `/book`'s while `phase` is `ending`.** |
| `GET /v1/crosses/:address/ending` | buckets with the orders that fell in each (from the index), the drawn last counted bucket, the extension state. |
| `GET /v1/crosses/:address/challenges` | challenges with status `Open`, `Upheld`, `Rejected`, `Expired`. |
| `GET /v1/owners/:owner/lockups?cross=` | each locked fill: `amount`, `startTs`, `cliffSecs`, `vestSecs`, `unlocksAt`, `endsAt`, `released`, `releasable` (from the lockup account), `state: locked \| closed \| unknown`, `nonce`. |
| `GET /v1/halts/:baseMint`, `GET /v1/feeds/:baseMint` | the halt state / lender print feed on chain, with the index's history. |
| `GET /v1/series/:address`, `GET /v1/series?authority=` | the series on chain and the crosses it spawned. |
| `GET /v1/crosses/:address/proof` | the fairness proof; schema `opening-cross/fairness-proof/v2` for a cross with rules (`rules.ending`, `rules.checks`, `rules.limits`), v1 unchanged for one without. |
| `GET /v1/crosses/:address/proof/draws` | `{ proof, draws }`: the same proof, with the `DrawFinished` events the index holds, so an ending drawn before a later draw replaced the stored seed is checked too. |
| `GET /v1/replay/:address` | the replay now names the new events (`rules_set`, `order_placement`, `draw_started`, `draw_finished`, `extension_pending`, `insider_challenged`, `challenge_resolved`, `challenge_expired`, `lock_created`, `lock_released`, `print_fed`). |

## Treasury (`routes/treasury-tx.ts`)

Transactions are `POST /v1/treasuries/:address/tx/<action>`; each answers `{ transaction, signers, ...facts }`. A treasury that was never extended answers 422 `NOT_EXTENDED` for every extension action.

| Action | Body | Notes |
|---|---|---|
| `init-ext` | `{ authority, params }` or `{ authority, preset: "flagship", revenueCredential, revenueSchema, assignmentCredential, assignmentSchema, revenueShareBps, revenueStart, recovery, insiders? }` | 422 `TERMS_INVALID` with `issues` (`severity: "refused"` the program refuses, `"advice"` it accepts but the treasury would be unusable). `params` fields as `checkExtParams`. |
| `propose` | `{ proposer, kind: "spend" \| "open-nav" \| "close-nav", amount?, destination?, descHash? }` | the id is the treasury's next one (`id` in the answer). 422 `OVER_PROPOSAL_CAP` (with `cap`), `NOT_A_HOLDER`. |
| `vote` | `{ voter, id, support, amount }` | 409 `VOTING_CLOSED`; 422 `INSUFFICIENT_COINS`. |
| `reclaim-vote` | `{ voter, id }` | 409 `VOTING_OPEN`; 404 `NO_VOTE`. |
| `execute-proposal` | `{ executor, id }` | 409 `NOT_EXECUTABLE` with `status`: `voting`, `failed`, `timelock`, `expired`, `executed`. |
| `nav-redeem` | `{ holder, amount }` | answers `payout`, `vault`, `supply`; 409 `NAV_CLOSED`; 422 `INSIDER_EXCLUDED`. |
| `stake`, `unstake` | `{ owner, amount }` | |
| `deposit-distribution` | `{ depositor, amount }` | |
| `claim-distribution` | `{ owner }` | answers `claimable`; 409 `NOTHING_TO_CLAIM`. |
| `pay-round` | `{ payer, round, attestation? }` | 422 `NOT_ATTESTED` (with the attestation address the attester must sign). |
| `mark-missed` | `{ caller, round }` | 409 `ROUND_NOT_LATE` (with `dueAt`). |
| `release-tranche` | `{ authority, round, destination }` | |
| `create-grant` | `{ authority, beneficiary, total, lockupEnd, expiryTs, milestones: [{ bps, requiresAttestation }], credential, schema }` | the id is the treasury's next one. 422 `LOCKUP_TOO_SHORT`, `MILESTONES_OVER_100`. |
| `release-milestone` | `{ cranker, grant, index, attestation? }` | 409 `LOCKED`; 422 `NOT_ATTESTED`. |
| `expire-grant` | `{ cranker, grant }` | 409 `NOT_EXPIRED`. |
| `post-disclosure` / `request-disclosure` | `{ authority, hash }` / `{ holder }` | |
| `record-assignment` | `{ payer, attestation? }` | 422 `NOT_ATTESTED`. |
| `sweep-unclaimed` | `{ payer }` | 409 `WINDOW_OPEN` (with `opensAt`). |
| `spend`, `record-attested`, `record-lapse`, `trigger-liquidation`, `redeem` | the first release's instructions (these exist on devnet today) | |

Reads: `GET /v1/treasuries/:address/ext` (terms and live state, or `{ extended: false }`), `/proposals`, `/proposals/:id?voter=`, `/positions/:owner` (`held`, `staked`, `claimable`), `/grants`, `/rounds` (each round `open`, `awaiting-payment`, `late`, `paid` or `missed`, with the attestation address and whether it exists), `/events?name=&limit=`. The existing `GET /v1/treasuries` and `GET /v1/treasuries/:address` are unchanged.

## cross_settle (`routes/settle-tx.ts`, `routes/rules-read.ts`)

`POST /v1/tx/claim-partner-fee` `{ cross, payer, maxBase?, maxQuote? }`, `withdraw-partner-surplus`, `withdraw-partner-migration-fee`, `claim-partner-pool-creation-fee` `{ cross, payer }`, `claim-pol-fees` `{ cross, payer, pool, position, positionNftAccount, tokenAMint, tokenBMint, tokenAVault, tokenBVault }`, `create-greenshoe` `{ cross, creator, budget, startTs, periodSecs, periodCap }`, `deploy-greenshoe-bid` `{ cross, payer, limitOrder, level, amount, binId? }` (`limitOrder` is a fresh keypair address that also signs; `binId` defaults to the bin nearest the level's price), `settle-greenshoe-level` `{ cross, payer, level, hook? }`, `finish-greenshoe` `{ cross, payer }`. Destinations are fixed by the program (the fee recipient, the issuer's proceeds); a caller cannot redirect them.

`GET /v1/crosses/:address/settlement` answers `{ venue, partner, greenshoe, events }`: the venue a cross opened (`dbc`, `damm_v2`, `dlmm`, `raydium_cpmm`), the partner payouts summed, the greenshoe (index plus its account on chain), and the adapter events. All null with a note for a cross no adapter has settled.

## Indexer

Migrations `016_cross_rules.sql`, `017_treasury_ext.sql`, `018_settle.sql` (additive, idempotent). The core indexer decodes the 17 new cross_core events and projects them; `orders` gains `nonce`, `class`, `lock_secs` (read from `commit_order` and `commit_order_ext`). The treasury indexer decodes all 25 treasury events and attributes the three that name only a proposal or a grant. A new poller follows `cross_settle` (`SETTLE_PROGRAMS`, comma separated, default the deployed program). The reconciler compares `close_ts`, `reveal_end_ts` and, for a cross with a rules tail, `rules_set`, flags, draw epoch, last counted bucket, extension state and open challenges; against a cross of the deployed program (no tail, no row) it reports nothing.

## Verifier

`verifyCross(fetch, cross, { draws? })` adds to the proof of a cross with rules: `rules.ending`, `rules.checks` (merged main shards, merged auxiliary shards equal to those the drawn end requires, the ending bucket equals what the seed decides) and `rules.limits` (what the proof cannot establish: the block hashes behind a draw, state-dependent no-print reasons, per-order fills). Conformance v3 (`packages/verifier/conformance/v3.json`, 563 cases) pins placement, required shards, the draw's three words and lock vesting; its values are computed by `generate_v3.py`, **not** by running the Rust code (`source` says so). `fairness-proof/v1` is unchanged; `fairness-proof/v2` has a published schema (`packages/verifier/schema/fairness-proof.v2.schema.json`).
