# The seven Wave 3D programs: SDK builders, API routes, MCP tools, keeper duties

Workstream W4A. This is the reference for the screens built on `cross_mandate`, `cross_conviction`, `cross_basket`, `cross_listing`, `cross_bounty`, `cross_backing` and `cross_graduate` (ADR-0650 to ADR-0656), on the two new `cross_settle` instructions (`open_fixed_price_presale`, ADR-0663; `seed_futarchy_dao`, ADR-0657) and on the fifth rule flag of `cross_core` (`FLAG_GOVERNED_GRADUATION`). The conventions of `W3A-rules-treasury-settle.md` and `W3E-markets-keeper-neutrality.md` apply unchanged: integers that can exceed 2^53 are decimal strings, times are Unix seconds, a transaction route answers `{ transaction, signers, bytes, ...facts }`, errors are `{ error, reason, ...details }` with status 400 (malformed, the sentence names the field), 404, 409 (the state is wrong), 422 (well formed, and the protocol would refuse it) or 503. A `reason` is stable and meant for branching; where the program has an error of that meaning the reason is its name in SCREAMING_SNAKE (`OverShareLimit` is `OVER_SHARE_LIMIT`) and `issues: [{ code, field, message }]` lists every refusal found, `code` being the program's own name.

**Honest status.** These programs are proved on LiteSVM and on a local validator (`docs/evidence/W3D-*.md`, `docs/evidence/W4A-*.md`). **They are not deployed to devnet** until the operations key is funded (docs/HUMAN_TASKS.md H27, H43), and the batch 2 upgrade of `cross_core` and `cross_settle` is not either. Every transaction route therefore checks the cluster first and answers **409 `PROGRAM_NOT_DEPLOYED`** (`{ program, programName, instruction }`) instead of a transaction the cluster would refuse; every read answers with `release.deployed: false` and a `note`, or 404 `PROGRAM_NOT_DEPLOYED` for a single account that cannot exist. Screens must read `GET /v1/programs` and show these features as "built, not on this network yet", never as live. Not run on any cluster: the routes against a real devnet or mainnet program, the indexer against real transactions, the keeper's sends, the attester's sends.

## The release: `GET /v1/programs`

`programs` now also holds `crossMandate`, `crossConviction`, `crossBasket`, `crossListing`, `crossBounty`, `crossBacking`, `crossGraduate`, each `{ address, name, adr, deployed, extended, deployedSlot, checked: [{ instruction, present }], note }`. `deployed` is `true` (the program is on the cluster and loads every instruction), `false` (no program at the address, or one without some instruction) or `null` (not known: the cluster could not be read, or the scan could not find the control instruction so it is not trusted; **an unreadable program is never reported as a missing one**). The three older entries gain `missing: true` when the cluster was read and nothing is at the address.

`features` answers what a screen may offer, each `{ available: true | false | null, needs: [...], unverified?: [...], note }`: `mandates`, `conviction`, `baskets`, `listing`, `bounty`, `backing`, `governedGraduation` (needs `cross_graduate` and the batch 2 build of `cross_settle`; the fifth flag of `cross_core` is a bit in an existing mask and cannot be seen in the program bytes, so it is listed under `unverified`), `fixedPricePresale` and `futarchyDao` (batch 2 of `cross_settle`). MCP: `oc_get_program_release`.

Creating a cross with the governed-graduation rule (`POST /v1/tx/create-cross-ruled` with `rules.flags` including 32) is refused with 409 `PROGRAM_NOT_DEPLOYED { feature: "governedGraduation", missing: [...] }` while `cross_graduate`, `cross_settle` or its batch 2 gate is definitely missing: a governed cross cannot open a pool without a passed vote, so one created now could never be seeded. When the release cannot be read the cross is built and `warnings` carries `GOVERNED_UNVERIFIED`. `GET /v1/crosses/:address/rules` names the flag `governedGraduation`, and `POST /v1/rules/check` accepts it (it reads no chain).

The seeding routes (`POST /v1/tx/seed-damm-v2`, `open-dlmm-pair`, `seed-raydium-cpmm`, `seed-futarchy-dao`) apply the program's own gate before a transaction is handed out: for a governed cross they answer 409 `GRADUATION_NOT_APPROVED { why: "NO_OUTCOME" | "WRONG_VENUE", outcome, venue, chosen?, route? }` unless the cross's `Outcome` account exists and names that venue, and `WRONG_VENUE` names the route that opens the venue the holders chose. When it passes, the answer carries `graduation: { governed: true, outcome, venue }` and the transaction names the outcome as its last remaining account.

## SDK builders (`@opening-cross/sdk`, `packages/sdk/src/programs`)

All return `@solana/kit` instructions, check what the program would refuse from the facts given, and throw `ProgramRefusal` (carrying `issues`) before a transaction exists. `*Addresses` helpers derive every PDA from the generated clients.

| Program | Builders | Pure helpers |
|---|---|---|
| `cross_mandate` | `buildCreateMandate`, `buildFundMandate`, `buildSetMandateLimits`, `buildRevokeMandate`, `buildWithdrawMandate`, `buildWithdrawMandateLamports`, `buildSweepMandate`, `buildMandatePlaceOrder`, `buildMandateCancel`, `buildMandateReveal` | `mandateAddresses`, `checkMandateLimits`, `checkMandateOrder`, `mandateSupplyReference`, `mandateShareBound`, `maxBaseForEscrow`, `MANDATE_AGENT_INSTRUCTIONS`, `inspectMandateAgentTransaction` (what an agent host runs before it signs), `MANDATE_MIN_SIGNER_LAMPORTS` |
| `cross_conviction` | `buildLockTokens`, `buildUnlock`, `buildClaimBadge` (init_badge, the holder's badge account, claim_badge), `buildCloseLock` | `convictionAddresses`, `convictionBadgeAddresses`, `convictionTokenDays`, `checkConvictionLock` |
| `cross_basket` | `buildCreateBasket` (the vault accounts first), `buildMintShares`, `buildRedeemShares` | `basketAddresses`, `basketOwed`, `basketCovers`, `checkBasketTerms`, `checkBasketComponentMint` |
| `cross_listing` | `buildCreateVenue`, `buildOpenBond`, `buildDepositBond`, `buildWithdrawBond`, `buildListCross`, `buildReleaseListing`, `buildSlashListing` | `venueAddress`, `bondAddresses`, `listingAddress`, `checkVenueTerms`, `checkListing`, `listingVerdict` |
| `cross_bounty` | `buildCreateBounty`, `buildFundBounty`, `buildClaimInvariant`, `buildAward`, `buildWithdrawBounty` | `bountyAddresses`, `crossViolates`, `brokenInvariants`, `checkBountyTerms`, `checkBountyClaim`, `BOUNTY_INVARIANT_NAMES` |
| `cross_backing` | `buildInitHaltStateWithWatchdog`, `buildCreateBackingPolicy`, `buildAttestBacking`, `buildCheckBacking` | `backingAddresses`, `backingVerdict`, `backingRequired`, `checkBackingPolicy` |
| `cross_graduate` | `buildInitCharter`, `buildStartRound`, `buildCastVote`, `buildPostVolume`, `buildFinalizeRound`, `buildPublishOutcome`, `buildWithdrawVote`, `governedOutcomeAccount` | `charterAddress`, `roundAddress`, `outcomeAddress`, `voteAddress`, `decideRound`, `roundShortfall`, `checkCharterTerms`, `checkCharterCross`, `checkVote`, `isGoverned` |

`rules-check.ts` accepts the fifth flag (`FLAG_GOVERNED_GRADUATION`). `@opening-cross/adapters` adds `buildOpenFixedPricePresale` (`encodePresaleArgs`, `fixedPriceQ64`, `presaleAddresses`, `checkFixedPriceTerms`; the argument bytes are checked field by field against `idls/presale.json`) and `buildSeedFutarchyDao` (`encodeDaoParams`, `twapInitialObservation`, `depositMatchesPrice`, `futarchyAddresses`, `squadsTreasuryOf`, `checkFutarchyCross`); and `buildSeedDammV2`, `buildOpenDlmmPair` (after the badge accounts) and `buildSeedRaydiumCpmm` add the `Outcome` account as the last remaining account when the cross carries the flag.

`@opening-cross/client` mirrors all of it: `api.getMandate`, `listMandates`, `getMandateActivity`, `ownerMandates`, `checkAgentTransaction`, `getConviction`, `getConvictionLock`, `getConvictionMint`, `getBasket`, `quoteBasket`, `listBaskets`, `listListingVenues`, `getListingVenue`, `getVenueListings`, `getListing`, `getCrossListings`, `listBounties`, `getBounty`, `getBountyPayouts`, `getCrossInvariants`, `getBacking`, `listBackingPolicies`, `getGraduation`, `getGraduationRound`, and `api.tx.<camelCaseOfTheRoute>` for each transaction route below (`api.tx.mandatePlaceOrder` is `POST /v1/tx/mandate-place-order`).

## Mandates (`routes/mandate-tx.ts`)

An owner funds a vault and names one agent. The agent can only place buy orders inside the owner's limits; the owner can revoke and withdraw at any time. `limits` is `{ maxPerOrder, totalCap, maxShareBps (1 to 2,500), expiresAt, allow: [{ kind: "base_mint" | "creator" | "cross", key }] (1 to 8) }`.

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/mandate-create` | `{ owner, agent, quoteMint, limits, id?, fund?: { amount?, lamports? } }` | The first free `id` when omitted. `{ mandate, signer, vault, id, funded, minSignerLamports, note? }`. 422 `BAD_LIMITS { issues }`, `AGENT_IS_OWNER`, `MINT_HAS_TRANSFER_HOOK`, `INSUFFICIENT_QUOTE`; 409 `ALREADY_EXISTS`, `NO_QUOTE_ACCOUNT`. The agent places an order only while the signer account holds `minSignerLamports`: fund it with `lamports`. |
| `POST /v1/tx/mandate-fund` | `{ owner, mandate, amount?, lamports? }` | 422 `NOT_THE_OWNER`, `NOTHING_TO_DO`, `INSUFFICIENT_QUOTE`. |
| `POST /v1/tx/mandate-set-limits` | `{ owner, mandate, limits }` | 409 `REVOKED` (a revoked mandate stays revoked), 422 `BAD_LIMITS`. |
| `POST /v1/tx/mandate-revoke` | `{ owner, mandate }` | Immediate, permanent (`permanent: true`). 409 `REVOKED`. |
| `POST /v1/tx/mandate-withdraw` | `{ owner, mandate, amount? }` | Default: the whole vault. Works after a revoke and after the expiry. 422 `OVER_VAULT`; 409 `NOTHING_TO_WITHDRAW`. The owner's token account is created first. |
| `POST /v1/tx/mandate-withdraw-lamports` | `{ owner, mandate, lamports? \| all: true }` | The signer account keeps the rent of an empty account or is emptied: 422 `BELOW_RENT_EXEMPT`, `OVER_BALANCE`. |
| `POST /v1/tx/mandate-sweep` | `{ payer, mandate, mint }` | Anyone; the base token a filled order left in the signer account goes to the owner. 422 `QUOTE_STAYS_IN_VAULT`; 409 `NOTHING_TO_SWEEP`. |
| `POST /v1/tx/mandate-place-order` | `{ agent, mandate, cross, price, quantity, nonce?, escrow?, salt? }` | **The agent signs** (`signers: [agent]`). The order belongs to the signer account, so refunds and no-prints pay back into the vault. `{ order, nonce, escrow, commitment, remainingAfter, warnings }`. 422 `NOT_THE_AGENT`, `REVOKED`, `EXPIRED`, `OVER_PER_ORDER_LIMIT`, `OVER_TOTAL_CAP`, `VAULT_TOO_LOW`, `WRONG_QUOTE`, `NOT_ALLOWED`, `NO_SUPPLY_REFERENCE`, `OVER_SHARE_LIMIT`, `NEED_RENT_FUNDING` (each with `issues`); 409 `NOT_LIVE`, `NONCE_USED`. A sealed cross needs a 32-byte hex `salt` (kept by the caller, needed to reveal) and is measured by its escrow at the lowest price. A gated or identity-limited cross carries a warning: the signer account has no gate pass. |
| `POST /v1/tx/mandate-cancel-order` | `{ caller, mandate, cross, nonce }` | The owner or the agent, also after a revoke. The refund lands in the vault (`refundTo`). 422 `NOT_OWNER_OR_AGENT`; 404 `NO_SUCH_ORDER`. |
| `POST /v1/tx/mandate-reveal-order` | `{ caller, mandate, cross, nonce, price, quantity, salt }` | The owner or the agent. |
| `POST /v1/mandates/check-transaction` | `{ transaction }` | `{ ok, instructions, issues, allowed }`. An agent key signs only `place_order`, `cancel_order`, `reveal_order` and compute-budget instructions. Run it before signing a draft. |

Reads: `GET /v1/mandates/:address` (`{ mandate, owner, agent, limits, committed, capRemaining, status: active | revoked | expired, signer, vault, vaultBalance, signerLamports, minSignerLamports, canPlaceOrder, blockers: [...], release }`, from chain), `GET /v1/mandates?owner=&agent=&limit=` and `GET /v1/owners/:owner/mandates` (the index), `GET /v1/mandates/:address/activity` (`{ events, orders }`).

## Conviction (`routes/conviction-tx.ts`)

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/conviction-lock` | `{ holder, mint, amount, unlockTs, nonce? }` | `unlockTs` one day to four years from now (422 `BAD_UNLOCK_TIME`, `NOTHING_TO_LOCK`). `{ lock, vault, nonce, lockedFor, tokenDays, note }`. 422 `INSUFFICIENT_BALANCE`, `MINT_HAS_TRANSFER_HOOK`; 409 `NO_TOKEN_ACCOUNT`, `NONCE_USED`. |
| `POST /v1/tx/conviction-unlock` | `{ holder, lock }` | 409 `STILL_LOCKED { unlockTs, secondsLeft }`, `ALREADY_WITHDRAWN`; 422 `NOT_THE_HOLDER`. |
| `POST /v1/tx/conviction-claim-badge` | `{ holder, lock }` | The badge mint is created on the first claim; `tokenDays` is `floor(amount x lock seconds / (86,400 x 10^decimals))`, once per lock. 422 `TOO_SMALL_FOR_A_BADGE`; 409 `STILL_LOCKED`, `BADGE_ALREADY_CLAIMED`. |
| `POST /v1/tx/conviction-close-lock` | `{ holder, lock }` | 409 `LOCK_STILL_NEEDED { withdrawn, badgeClaimed }`. |

Reads: `GET /v1/conviction/locks/:address` (`state: locked | unlockable | unlocked`, `secondsLeft`, `tokenDays`, `canClaimBadge`, `closable`), `GET /v1/owners/:owner/conviction` (the holder's locks and badges), `GET /v1/conviction/mints/:mint` (what is locked behind a token).

## Baskets (`routes/basket-tx.ts`)

A share (six decimals) backed by `unitsPerShare` of each of one to eight components per whole share (10^6 share atoms). Minting rounds each deposit **up**, redeeming rounds each payout **down**; after every step each vault must cover the shares outstanding.

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/basket-create` | `{ creator, label, components: [{ mint, unitsPerShare }], id? }` | 422 `BAD_BASKET`, `DUPLICATE_COMPONENT`, `UNSAFE_EXTENSION` (a transfer fee, permanent delegate, transfer hook, pausable or other restricting extension); **a token gated by `cross_gate` cannot be a component**. A component whose issuer holds a freeze authority can have the basket's vault frozen. |
| `POST /v1/tx/basket-mint` | `{ user, basket, shares }` | `deposits: [{ mint, amount, exact }]`; 422 `INSUFFICIENT_COMPONENT`. |
| `POST /v1/tx/basket-redeem` | `{ user, basket, shares }` | `payouts: [...]`; 422 `INSUFFICIENT_SHARES`. |

Reads: `GET /v1/baskets/:address` (components, vault balances, `shareSupply`, `backingPerShare`, `solvent`), `GET /v1/baskets/:address/quote?shares=&side=mint|redeem` (the exact rounding per component), `GET /v1/baskets?creator=`.

## Listing (`routes/listing-tx.ts`)

A venue fixes its terms for good. A lister opens a bond, deposits, and lists a cross it created that still takes orders (each listing sets aside `minBond`); the bond is released after `closeTs + releaseDelaySecs` when the cross ends well and slashed to the venue when it ends because its settlement never happened.

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/listing-create-venue` | `{ creator, bondMint, minBond, releaseDelaySecs, slashTo, id? }` | 422 `BAD_TERMS` (a positive bond, a delay of at least a day). `slashAccountExists` says whether the venue's account for slashed bonds exists. |
| `POST /v1/tx/listing-open-bond` | `{ lister, venue }` | 409 `ALREADY_EXISTS`. |
| `POST /v1/tx/listing-deposit-bond` | `{ lister, venue, amount }` | 409 `NO_BOND`; 422 `INSUFFICIENT_BALANCE`. |
| `POST /v1/tx/listing-withdraw-bond` | `{ lister, venue, amount? }` | Only the part no open listing has set aside: 422 `BOND_ENCUMBERED`. |
| `POST /v1/tx/listing-list-cross` | `{ lister, venue, cross }` | 422 `NOT_THE_CREATOR`, `CROSS_NOT_LIVE`, `BOND_TOO_SMALL`; 409 `ALREADY_LISTED`, `NO_BOND`. Answers `releaseAfter`. |
| `POST /v1/tx/listing-release` | `{ payer, listing }` | Anyone. 409 `NOT_ENDED`, `USE_SLASH`, `ALREADY_SETTLED`. |
| `POST /v1/tx/listing-slash` | `{ payer, listing }` | Anyone. 409 `NO_FAULT`, `USE_RELEASE`, `ALREADY_SETTLED`; creates the venue's slash account first when it is missing (`createsSlashAccount`). |

Reads: `GET /v1/listing/venues` (the index), `GET /v1/listing/venues/:venue?lister=` (terms from chain and the lister's bond: total, set aside, free), `GET /v1/listing/venues/:venue/listings`, `GET /v1/crosses/:address/listings`, `GET /v1/listing/listings/:address` (`next: release | slash | wait | settled`).

## Bounty (`routes/bounty-tx.ts`)

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/bounty-create` | `{ sponsor, rewardMint, arbiter, expiresAt, rewards: [11 amounts], id? }` | The pool is committed for at least 30 days: 422 `COMMITMENT_TOO_SHORT`, `BAD_REWARDS`. |
| `POST /v1/tx/bounty-fund` | `{ funder, bounty, amount }` | Anyone. 422 `INSUFFICIENT_BALANCE`. |
| `POST /v1/tx/bounty-claim-invariant` | `{ claimant, bounty, cross, invariant? }` | Without `invariant`, the first broken one the bounty covers. 422 `NO_VIOLATION { broken }`, `NOT_COVERED`, `ALREADY_PAID`, `EXPIRED`; 409 `POOL_EMPTY`. Pays `pays` to the claimant's token account (created first). |
| `POST /v1/tx/bounty-award` | `{ arbiter, bounty, hunter, amount, evidence }` | `evidence` is the report's hash (64 hex). 422 `NOT_THE_ARBITER`, `OVER_POOL`; 409 `EXPIRED`. |
| `POST /v1/tx/bounty-withdraw` | `{ sponsor, bounty, amount? }` | 409 `STILL_COMMITTED { expiresAt }`; 422 `NOT_THE_SPONSOR`, `OVER_POOL`. |

Reads: `GET /v1/bounties` (the index), `GET /v1/bounties/:address` (`invariants: [{ invariant, name, reward, covered, paid }]`, `pool`, `status`), `GET /v1/bounties/:address/payouts`, and `GET /v1/crosses/:address/invariants` (which of the eleven invariants the cross account breaks right now; empty for an honest cross). Eleven invariants are not a proof of correctness.

## Backing (`routes/backing-tx.ts`)

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/backing-init-halt-state` | `{ authority, baseMint }` | A halt state that names the watchdog as its venue signer (fixed at creation): 409 `HALT_STATE_EXISTS` for an asset that already has one with another venue signer. |
| `POST /v1/tx/backing-create-policy` | `{ authority, mint, attester, minCoverageBps (100 to 20,000), maxAgeSecs (60 to 2,592,000) }` | Permanent. 409 `NO_HALT_STATE`, `ALREADY_EXISTS`; 422 `NOT_THE_AUTHORITY`, `WATCHDOG_NOT_VENUE_SIGNER`, `BAD_POLICY`. |
| `POST /v1/tx/backing-attest` | `{ attester, mint, backingAtoms }` | 422 `NOT_THE_ATTESTER`. Answers `coversNow`, `requiredNow`. |
| `POST /v1/tx/backing-check` | `{ mint, payer }` | Anyone. 409 `BACKED` when the backing is fresh and covers the live supply, `ALREADY_HALTED`. |

Reads: `GET /v1/assets/:mint/backing` (the policy, the last statement, the live supply, the required backing, the verdict now `Backed | Missing | Stale | Short`, `haltsOnNextCheck` and the halt state), `GET /v1/backing/policies`. A fresh statement does not lift a halt: only a printing resume cross does.

## Graduation (`routes/graduate-tx.ts`)

`round` is the round's index (0 to 2); without it the latest round is meant. Quorum is measured against the live supply when the round is finalized: an issuer that still holds a mint authority can raise it (a veto by dilution), so the console should show whether the mint authority is gone before holders are asked to vote.

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/graduate-init-charter` | `{ creator, cross, quorumBps (1,000 to 10,000), windowSecs (3 to 30 days), minVolume?, volumeAttester? }` | 422 `BAD_CHARTER`, `NOT_THE_CREATOR`, `TOO_LATE`, `NOT_GOVERNED`; 409 `ALREADY_EXISTS`. |
| `POST /v1/tx/graduate-start-round` | `{ creator, cross }` | 409 `CROSS_NOT_FINALIZED`, `ROUND_OPEN`, `ALREADY_PASSED`, `NO_ROUNDS_LEFT`, `NO_CHARTER`. |
| `POST /v1/tx/graduate-cast-vote` | `{ voter, cross, venue, amount, round? }` | `venue` is `damm_v2`, `dlmm`, `raydium_cpmm` or `metadao_futarchy` (or 0 to 3). 422 `NOT_VOTING`, `VENUE_LOCKED`, `INSUFFICIENT_BALANCE`. The tokens are locked until `unlocksAt`. |
| `POST /v1/tx/graduate-post-volume` | `{ attester, cross, volumeQuote, round? }` | 422 `NOT_THE_ATTESTER`. |
| `POST /v1/tx/graduate-finalize-round` | `{ payer, cross, round? }` | Anyone. 409 `WINDOW_OPEN`; answers `willPass`, `winner`, `shortfall`. |
| `POST /v1/tx/graduate-publish-outcome` | `{ payer, cross, round? }` | Anyone. 409 `NOT_PASSED`, `ALREADY_PUBLISHED`. |
| `POST /v1/tx/graduate-withdraw-vote` | `{ voter, cross, round? }` | 409 `WINDOW_OPEN`; 404 `NO_VOTE`. |

Reads: `GET /v1/crosses/:address/graduation` (the charter, every round with its tallies, `quorumNeeded`, `wouldPassNow`, the outcome and `seeding: { requiresOutcome, ready, instruction }`) and `GET /v1/graduation/rounds/:round?voter=`.

## The two batch 2 instructions of `cross_settle` (`routes/settle-wave3d-tx.ts`)

| Route | Body | Notes |
|---|---|---|
| `POST /v1/tx/open-fixed-price-presale` | `{ cross, creator, base, terms, disableWithdraw? }` | A tranche at exactly the clearing price through Meteora's Presale Vault. `base` is a fresh keypair address that also signs. `terms` is `{ maxCap, minCap, start, end, supply, buyerMinDeposit, buyerMaxDeposit, depositFeeBps?, immediatelyReleaseBps?, lockDuration?, vestDuration?, unsoldTokenAction? }`. `{ presale, qPrice, clearingPrice, supply }`. 422 `NOT_THE_CREATOR`, `NOTHING_TO_DO`, `BAD_TERMS`, `INSUFFICIENT_BASE`; 409 `LIVE`, `NOT_CLEARED`, `NO_BASE_MINT`, `PRESALE_EXISTS`, `EXTERNAL_PROGRAM_MISSING`. |
| `POST /v1/tx/seed-futarchy-dao` | `{ cross, creator, baseAmount, quoteAmount?, nonce?, settings? }` | A MetaDAO DAO whose spot pool starts at the clearing price. Legacy SPL tokens only: 422 `FUTARCHY_NEEDS_LEGACY_TOKENS`, `FUTARCHY_QUOTE_DECIMALS`, `START_PRICE_NOT_CLEARING_PRICE` (the quote deposit is the exact ratio rounded down or up and nothing else), `INSUFFICIENT_BASE` / `_QUOTE`; 409 `DAO_EXISTS`, `GRADUATION_NOT_APPROVED`, `EXTERNAL_PROGRAM_MISSING`. |

Both start with a compute-budget instruction of 1,400,000 units and carry `release` like the other `cross_settle` routes.

## MCP tools

Reads: `oc_get_mandate`, `oc_list_mandates`, `oc_get_mandate_activity`, `oc_get_conviction`, `oc_get_conviction_lock`, `oc_get_basket`, `oc_quote_basket`, `oc_list_baskets`, `oc_get_listing_venue`, `oc_get_listing`, `oc_get_cross_listings`, `oc_get_bounty`, `oc_list_bounties`, `oc_get_cross_invariants`, `oc_get_backing`, `oc_get_graduation`, `oc_get_graduation_round`, `oc_get_program_release`. For agents: `oc_check_agent_transaction` (the guard, a read), `oc_draft_mandate_place_order` (the agent signs), `oc_draft_mandate_cancel_order`, `oc_draft_mandate_reveal_order` (owner or agent) and the owner's `oc_draft_mandate_revoke` and `oc_draft_mandate_withdraw`. The MCP server holds no key; there is no tool that creates, funds, re-limits or empties a mandate for an agent. A test runs every read tool against the whole API server and every mandate draft against its real route.

## The indexer

Migration `019_wave3d_programs.sql` (additive, idempotent): `program_events` (one log for the seven programs, with `subject` and `cross_address`), `mandates`, `mandate_orders`, `conviction_locks`, `conviction_badges`, `baskets`, `listing_venues`, `listing_bonds`, `listing_listings`, `bounties`, `bounty_payouts`, `backing_policies`, `backing_attestations`, `backing_failures`, `graduation_charters`, `graduation_rounds`, `graduation_votes`, `graduation_outcomes`. The indexer follows each program under the cursor `rpc:<program id>`; `WAVE3D_PROGRAMS` (a comma list of program names, default `all`, `none` to turn them off) chooses which. On a cluster without the programs every table stays empty and the reconciler, which reads crosses only, is unaffected.

## The keeper and the attester

`KEEPER_DUTIES` gains `graduation` (finalize a round whose window closed, publish a passed round's outcome; on by default), `backing` (`check` an opted-in asset whose attested backing is missing, stale or short; on by default), `listings` (release or slash; named only: a slash may pay for the venue's slash account) and `bounties` (claim an invariant a cross account breaks; named only: the reward is paid to the keeper's wallet). A scoped keeper (`KEEPER_CREATORS`) narrows graduation and listings to its creators' crosses; bounties and backing are protocol-wide. `KEEPER_DRY_RUN=1` plans all of it and sends nothing.

`services/backing-attester` signs the statements `cross_backing` checks, from a source named in a JSON file (`ATTESTER_CONFIG`): the balances of reserve token accounts on chain, an HTTP JSON report of a custodian, or a report file. It posts only a figure the source gave, dated and fresh; a source that fails is not worked around, so the statement ages out and the asset halts; a figure far above the last is held for an operator. Environment: `RPC_URL`, `ATTESTER_KEYPAIR`, `ATTESTER_CONFIG`, `PASS_MS`, `ATTESTER_DRY_RUN`. It proves nothing about a custodian: which attesters count is an operator decision (H32).
