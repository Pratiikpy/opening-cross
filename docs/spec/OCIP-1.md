# OCIP-1: Opening Cross Interface Protocol, version 1

| | |
|---|---|
| Identifier | `OCIP-1` |
| Revision | 1 (2026-10-13) |
| Status | Draft (see [sRFC-0001](sRFC-0001-process.md) for the status values) |
| Licence | Apache-2.0, like the rest of the repository |
| Deployment status | Solana devnet only. Nothing is deployed to mainnet. There has been no external audit. |
| Reference implementation | `programs/`, `crates/clearing-core`, `packages/verifier`, `packages/promises`, `services/` in this repository |

## 0. How to read this document

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

This specification describes what the reference implementation does, derived from its source code, its Anchor IDLs and its tests, as of the commit that carries this file. It does not describe intended behaviour that the code does not yet have. Where the code cannot determine a fact, the text says **not specified** or **NOT VERIFIED** rather than guessing. Sections marked *non-normative* or *informative* carry no requirements.

While the reference implementation is the only implementation, it is authoritative where this text is silent or ambiguous. A contradiction between this text and the reference implementation is a defect in one of them and is resolved through the process in [sRFC-0001](sRFC-0001-process.md); until it is resolved, the program as deployed on devnet determines behaviour.

Parts of this document are checked mechanically by `tests/core/test/ocip-spec.test.ts`: every instruction, account type, event and error in the program IDLs must appear here with its discriminator or code; program ids must equal `Anchor.toml`; PDA seed constants and numeric limits must equal the program sources; and every worked example, hash vector, promise vector and the sample fairness proof in the fenced `ocip:` blocks must be reproduced by the code in `packages/`. Prose is not checked.

## 1. Purpose and scope

Opening Cross is an open call-auction protocol on Solana. Limit orders are collected during a call window, optionally sealed by commit-reveal; at the close every filled order trades at one uniform clearing price, computed by a deterministic integer rule that anyone can recompute from the on-chain book. By design every order ends in a payout or a full refund (§17.2); that is tested, not audited.

OCIP-1 specifies the interfaces a third party needs to take part in that protocol, and to check its results, without relying on the reference implementation's operator:

- to **build a venue** that creates crosses and routes users' orders into them (§3 to §8, §14.1);
- to **run an indexer** that follows crosses and their events (§12, §14.2);
- to **run a keeper** that advances crosses through their lifecycle (§5, §14.3);
- to **write a verifier** that recomputes a cross and emits or checks a fairness proof (§13);
- to **write a settlement adapter** that opens a market at the clearing price (§9);
- to **check a signed promise** about a cross's clearing price (§15);
- to **prove an independent clearing implementation correct** against the conformance vectors (§16).

### 1.1 What is normative

| Part | Where | Normative content |
|---|---|---|
| Clearing rule, rounding, fees | §7 | Yes |
| `cross_core` accounts, instructions, state machine | §3, §4, §5, §6 | Yes |
| Disclosure modes and commitment format | §8 | Yes |
| `cross_settle` adapter contract | §9 | Yes for the adapter checks; the AMM calls are informative |
| `cross_gate`, `cross_calendar` interfaces | §10, §11 | Yes at the level the code defines |
| Events and errors | §12 | Yes |
| Verification procedure and fairness proof | §13 | Yes |
| Signed promises | §15 | Yes at the level the code defines |
| Conformance vectors | §16 | Yes |
| Public read API | Appendix A | No |
| `treasury` program | Appendix B | No |

### 1.2 Not in scope

- Matching against any venue other than a cross, DEX routing and price comparison (`packages/router`; Appendix A lists the routes).
- The web and mobile applications, the MCP server, the premium monitor and the fee-modelling package.
- Token-economic design, legal classification and compliance obligations of any asset sold through a cross. Nothing here is an offer of securities or investment advice.
- Encrypted or threshold-decrypted orders. The only privacy mechanism specified is commit-reveal (§8). An "encrypted default reveal" and an Arcium sealed-bid path are **not specified** because the repository does not contain them.
- A random or hidden close time, anti-flipping lockups at the cross level, per-identity allocation caps and a lottery tier. None exist in the code.

### 1.3 Conformance classes

An implementation claims conformance to OCIP-1 as one or more of the following classes. A claim names the class and the OCIP revision.

| Class | An implementation of this class | Requirements |
|---|---|---|
| Core | An on-chain program with the `cross_core` interface (§3 to §8, §12) | All MUST statements in §3 to §8 and §12; reproduces every vector in §16 |
| Integrator | A program or application that creates crosses or places orders in a Core | §6.2, §6.3, §8.3 and §14.1 |
| Keeper | A process that sends the permissionless instructions | §14.3 |
| Indexer | A process that decodes events and tracks state | §12.3, §14.2 |
| Verifier | A process that recomputes a cross and emits or checks a fairness proof | §13, §16 |
| Adapter | A program that is the `settler` of a deferred-mint cross or seeds a market at the clearing price | §9 |
| Promise issuer / checker | A process that signs, grades or checks promises | §15 |

## 2. Conventions and terminology

### 2.1 Numbers, encodings and time

- Token amounts, quantities and prices are unsigned integers. On chain they are `u64`; aggregates inside the clearing computation are `u128`. There is no floating point anywhere in the rule.
- All multi-byte integers inside account data, instruction data and hash preimages are little-endian. Account and instruction data use Borsh as implemented by Anchor 1.0.2 (`Option<T>` is a one-byte tag, `0` or `1`, followed by `T` when present).
- Off-chain documents defined here (the fairness proof, conformance vectors, promises, API responses) write integers that may exceed 2^53 as decimal strings. Small counters such as `ticks` are JSON numbers where the schema says so.
- Timestamps are Unix seconds (`i64`) read from the Solana `Clock` sysvar by the program, and compared as stated in each rule.
- Addresses are 32-byte public keys, shown in base58.
- An **atom** is the smallest unit of a token. `base_decimals` and `quote_decimals` are stored on the cross for display only; no rule uses them except the oracle conversion in §7.8.
- **Price.** A price `p` is an integer number of quote atoms per `price_scale` base atoms. The quote value of `q` base atoms at price `p` is `q · p / price_scale`, with the rounding stated in §7.
- Discriminators are the first eight bytes of `sha256("global:" + instruction)`, `sha256("account:" + Name)` or `sha256("event:" + Name)`, except where §3.1 lists an explicit override.

### 2.2 Terminology

| Term | Meaning |
|---|---|
| Cross | One call auction: a `Cross` account plus its book, shards, orders and vaults |
| Base, quote | The token being sold (base) and the token it is priced in (quote) |
| Call window | `open_ts ≤ now < close_ts`, when orders may be placed and cancelled |
| Reveal window | `close_ts ≤ now < reveal_end_ts` in a sealed cross; empty in an open cross |
| Grid | The `ticks` prices `min_price + i · tick`, `0 ≤ i < ticks`. Every order and reference price lies on it |
| Order | A limit order `(side, limit price, quantity)` with escrowed funds |
| Shard | A per-tick accumulator that orders write to; shards are merged into the book after the reveal window |
| Book | The merged per-tick aggregates the clear reads |
| Level | One grid price with its aggregate buy quantity, sell quantity and order counts |
| `D(p)`, `S(p)` | Buy quantity with limit ≥ p; sell quantity with limit ≤ p |
| `D⁺(p)`, `S⁻(p)` | Buy quantity with limit > p; sell quantity with limit < p |
| `V(p)` | Matched volume, `min(D(p), S(p))` |
| `P*` | The clearing price |
| Marginal order | An order whose limit equals `P*` on the rationed side |
| Print | A cross that clears with a price (`Cleared`). A **no print** refunds every order |
| Dust | The base-atom difference between sell fills and buy fills caused by rationing rounding |
| Dust bond | Quote atoms the creator deposits at creation so rounding can never leave a vault short |
| Supply mode | `Escrow` (sellers escrow base), `Mint` (the issuer's schedule is sold and fills are minted) or `DeferredMint` (like `Mint`, but the base mint is created after the clear) |
| Schedule | The issuer's pre-committed list of `(price, quantity)` sell levels in the mint modes |
| Settler | In a deferred-mint cross, the only signer allowed to bind the base mint |
| Integrator | The venue that creates a cross; receives the integrator fee |
| Keeper | Any party that sends a permissionless instruction |

### 2.3 Roles

| Role | Holder | Powers |
|---|---|---|
| Admin | `Protocol.admin` | Sets fee schedule and recipient, rotates the guardian, proposes a successor admin, migrates the account |
| Guardian | `Protocol.guardian` | With the admin, pauses and unpauses creation of crosses and orders |
| Creator | The signer of `create_cross` | Pays the dust bond; owns the cross's PDA seed; is the only party allowed to run `open_dbc_pool`, `seed_damm_v2`, `open_dlmm_pair` and `seed_raydium_cpmm` for the cross |
| Owner | An order's owner | Places, cancels and reveals the order; receives its payout |
| Anyone | Any signer | `init_shard`, `merge_shard`, `clear`, `claim`, `abandon_settlement`, `finalize` |

## 3. Programs, identifiers and data model

### 3.1 Programs

OCIP-1 covers four programs and describes a fifth informatively. Program ids are the `declare_id!` values in `programs/*/src/lib.rs` and the `[programs.localnet]` and `[programs.devnet]` entries of `Anchor.toml`.

```json ocip:programs
{
  "cross_core": "F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ",
  "cross_gate": "2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr",
  "cross_settle": "2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ",
  "cross_calendar": "CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN",
  "treasury": "HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd",
  "cross_settle@devnet-raydium": "4nH5srCTtRFtJuHNmH2Q3x1TSMZ8w3VWBfX7PwwNMpJ5"
}
```

| Program | Role |
|---|---|
| `cross_core` | Escrow, order entry, commit-reveal, aggregation, clearing, claims, refunds, fee accounting (§4 to §8) |
| `cross_gate` | Passes and locks for a mint; enforced as a Token-2022 transfer hook and as a Token ACL (sRFC-37) gate (§10) |
| `cross_settle` | Settlement adapters: Meteora DBC continuation, DAMM v2, DLMM and Raydium CPMM seeding at the clearing price (§9) |
| `cross_calendar` | Exchange sessions and approved oracle feeds with time-locked administration (§11) |
| `treasury` | Ownership-coin treasury template (Appendix B, informative) |

`cross_settle@devnet-raydium` is the same source built with the `devnet-raydium` feature under its own id, because Raydium's mainnet CPMM id is not a program on devnet (ADR-0021). It is not in `Anchor.toml`. The default build accepts only the mainnet Raydium CPMM program and the feature build only Raydium's devnet program.

Programs outside this repository that the interfaces name:

```json ocip:external-programs
{
  "meteora_dbc": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  "meteora_damm_v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  "meteora_dlmm": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "raydium_cpmm": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "raydium_cpmm_devnet": "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
  "solana_attestation_service": "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
  "token_acl": "TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP",
  "pyth_receiver": "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
  "pyth_receiver_upgraded": "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp",
  "spl_memo": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
}
```

Base and quote mints may be owned by either the SPL Token program or Token-2022; `cross_core` uses the token-interface and stores each mint's token program on the cross. The program itself does not inspect mint extensions (§17).

Account and instruction discriminators of `cross_gate` that are not Anchor defaults are overridden with the SPL transfer-hook and sRFC-37 interface values:

```json ocip:explicit-discriminators
{
  "cross_gate": ["can_freeze_permissionless", "can_thaw_permissionless", "execute", "init_hook_metas"]
}
```

### 3.2 Limits and constants

```json ocip:constants
{
  "MAX_TICKS": 256,
  "MAX_SHARDS": 32,
  "MAX_PROTOCOL_FEE_BPS": 100,
  "MAX_INTEGRATOR_FEE_BPS": 300,
  "BPS": 10000,
  "MAX_SESSIONS": 64,
  "MAX_FEEDS": 8,
  "MIN_TIMELOCK_SECS": 604800
}
```

`MAX_TICKS`, `MAX_SHARDS`, `MAX_PROTOCOL_FEE_BPS`, `MAX_INTEGRATOR_FEE_BPS` and `BPS` are in `programs/cross_core/src/state.rs`; `MAX_SESSIONS`, `MAX_FEEDS` and `MIN_TIMELOCK_SECS` in `programs/cross_calendar/src/lib.rs`. The merged-shard bitmap is a `u32`, which is why `MAX_SHARDS` is 32. A merge of a shard index at or above 32 is not possible because `init_shard` rejects `index ≥ shards`.

### 3.3 Program-derived addresses

Seeds are concatenated byte strings. `u64` seeds are 8 bytes little-endian, `u8` seeds are one byte, addresses are their 32 raw bytes.

| Account | Program | Seeds |
|---|---|---|
| Protocol | `cross_core` | `"protocol"` |
| Cross | `cross_core` | `"cross"`, creator, `cross_id` as `u64` |
| Book | `cross_core` | `"book"`, cross |
| Shard `i` | `cross_core` | `"shard"`, cross, `i` as `u8` |
| Order | `cross_core` | `"order"`, cross, owner, `nonce` as `u64` |
| Quote vault | `cross_core` | `"quote_vault"`, cross |
| Base vault | `cross_core` | `"base_vault"`, cross |
| GateConfig | `cross_gate` | `"config"`, mint |
| Pass | `cross_gate` | `"pass"`, mint, owner |
| Lock | `cross_gate` | `"lock"`, mint, owner |
| Transfer-hook extra metas | `cross_gate` | `"extra-account-metas"`, mint |
| Token ACL thaw metas | `cross_gate` | `"thaw_extra_account_metas"`, mint |
| Token ACL freeze metas | `cross_gate` | `"freeze_extra_account_metas"`, mint |
| Calendar | `cross_calendar` | `"calendar"`, admin, `id` as `u64` |
| Settler | `cross_settle` | `"settler"`, cross |
| DBC config | `cross_settle` | `"dbc_config"`, cross |
| DBC base mint | `cross_settle` | `"base_mint"`, cross |
| DAMM position NFT mint | `cross_settle` | `"damm_position"`, cross |
| Treasury | `treasury` | `"treasury"`, coin mint |
| Treasury vault | `treasury` | `"vault"`, treasury |
| SAS attestation | SAS program | `"attestation"`, credential, schema, nonce |

The seed constants as they appear in the sources:

```json ocip:seeds
{
  "cross_core": {
    "PROTOCOL_SEED": "protocol",
    "CROSS_SEED": "cross",
    "BOOK_SEED": "book",
    "SHARD_SEED": "shard",
    "ORDER_SEED": "order",
    "QUOTE_VAULT_SEED": "quote_vault",
    "BASE_VAULT_SEED": "base_vault"
  },
  "cross_gate": {
    "CONFIG_SEED": "config",
    "PASS_SEED": "pass",
    "LOCK_SEED": "lock",
    "HOOK_METAS_SEED": "extra-account-metas",
    "THAW_METAS_SEED": "thaw_extra_account_metas",
    "FREEZE_METAS_SEED": "freeze_extra_account_metas"
  },
  "cross_calendar": {
    "CALENDAR_SEED": "calendar"
  },
  "cross_settle": {
    "SETTLER_SEED": "settler",
    "DBC_CONFIG_SEED": "dbc_config",
    "BASE_MINT_SEED": "base_mint",
    "DAMM_POSITION_SEED": "damm_position"
  },
  "treasury": {
    "TREASURY_SEED": "treasury",
    "VAULT_SEED": "vault"
  }
}
```

The Order PDA is created by `commit_order` at the address derived with a client-supplied bump (`order_bump`); the program verifies it with `create_program_address` and does not search for a bump. The Token ACL meta-list seeds use underscores because the deployed Token ACL program derives them that way; the sRFC-37 text shows hyphens, and the program is authoritative (`programs/cross_gate/src/lib.rs`).

### 3.4 Enumerations

All enumerations are Borsh enums: one byte, the variant index.

- `CrossKind`: 0 `Launch`, 1 `Reopen`, 2 `Tender`, 3 `Recurring`
- `CrossState`: 0 `Live`, 1 `Cleared`, 2 `NoPrint`, 3 `Finalized`
- `Disclosure`: 0 `Sealed`, 1 `Open`
- `NoPrintReason`: 0 `NoCross`, 1 `BelowMinimumVolume`, 2 `ImbalanceTooHigh`, 3 `SettlementExpired`, 4 `OracleDivergence`, 5 `OracleUnavailable`, 6 `BelowMinimumRaise`, 7 `FloatTooLow`, 8 `FdvTooHigh`, 9 `PriceMoved`, 10 `Halted`, 11 `CorporateAction`, 12 `IssuerPaused`, 13 `OracleDisagreement`
- `OrderSide`: 0 `Buy`, 1 `Sell`
- `OrderState`: 0 `Committed`, 1 `Revealed`
- `SupplyMode`: 0 `Escrow`, 1 `Mint`, 2 `DeferredMint`
- `Mode`: 0 `Open`, 1 `Allowlist`

`Mode` belongs to `cross_gate`. `cross_calendar` defines no enumeration. The enumerations of `treasury` are in Appendix B.

### 3.5 Account index

Every account type in the program IDLs, with its 8-byte discriminator (hex) and its allocated size in bytes including the discriminator. `Cross`, `Protocol`, `Order`, `GateConfig`, `Pass`, `Lock` and `Treasury` are Borsh accounts allocated at their maximum size (`8 + INIT_SPACE`); `Levels` is a zero-copy account (`#[repr(C)]`); `Calendar` is allocated for `MAX_SESSIONS` sessions and `MAX_FEEDS` feeds.

| Program | Account | Discriminator | Allocated size |
|---|---|---|---|
| `cross_core` | `Applicant` | `a6619f2e3df1f3ce` | 82 |
| `cross_core` | `ArbiterRegistry` | `f691e769d530611b` | 41 |
| `cross_core` | `Challenge` | `77faa179775116d0` | 166 |
| `cross_core` | `ClassBook` | `adeecf34b4089b7a` | 9256 |
| `cross_core` | `Cross` | `57d37eb097cdabeb` | 668 |
| `cross_core` | `HaltState` | `ae3fb2c449962b40` | 244 |
| `cross_core` | `Levels` | `e870eec7afa7bfa7` | 6192 |
| `cross_core` | `Lockup` | `012d202039515843` | 113 |
| `cross_core` | `Order` | `86addfb94d561c33` | 143 |
| `cross_core` | `PrintFeed` | `7127297f81d184da` | 322 |
| `cross_core` | `Protocol` | `2d27652b73488328` | 147 |
| `cross_core` | `Series` | `f06108b78b4dfaa2` | 1087 |
| `cross_gate` | `GateConfig` | `a1c80a3db9785c15` | 172 |
| `cross_gate` | `Lock` | `08ff24cad2163989` | 89 |
| `cross_gate` | `Pass` | `28f78c71380e392c` | 73 |
| `cross_settle` | `Greenshoe` | `43ca1a80e5cfa525` | 387 |
| `cross_calendar` | `Calendar` | `9df0ba39d593972e` | 2683 |
| `treasury` | `Grant` | `a1a60bcdcc87cd36` | 195 |
| `treasury` | `Position` | `aabc8fe47a40f7d0` | 105 |
| `treasury` | `Proposal` | `1a5ebdbb74883521` | 203 |
| `treasury` | `RoundRecord` | `9305a94e8ad04cc1` | 67 |
| `treasury` | `Treasury` | `eeef7bee5901a8fd` | 237 |
| `treasury` | `VoteRecord` | `70097ba5ea099da7` | 89 |

The size column counts every `Option` as present. A decoder MUST decode a Borsh account sequentially. Because `Option::None` occupies one byte but the account is allocated for `Some`, the byte offset of a field that follows an `Option` field is not fixed. The offsets in the field tables below are the offsets when every preceding `Option` is present; they are given to show structure, not as fixed positions. The bytes after the encoded value up to the allocated size are not specified.

### 3.6 `Protocol`

The singleton configuration at `["protocol"]`.

<!-- ocip:account Protocol -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `admin` | `Pubkey` | 32 | 8 |
| 2 | `guardian` | `Pubkey` | 32 | 40 |
| 3 | `fee_recipient` | `Pubkey` | 32 | 72 |
| 4 | `fee_bps` | `[u16; 4]` | 8 | 104 |
| 5 | `paused` | `bool` | 1 | 112 |
| 6 | `bump` | `u8` | 1 | 113 |
| 7 | `pending_admin` | `Option<Pubkey>` | 33 | 114 |
<!-- /ocip:account -->

- `fee_bps` is indexed by `CrossKind` (`Launch`, `Reopen`, `Tender`, `Recurring`). Each entry MUST be at most `MAX_PROTOCOL_FEE_BPS`.
- `paused` stops `create_cross` and `commit_order` only (§5.4).
- `pending_admin` is set by `propose_admin` and consumed by `accept_admin`.

### 3.7 `Cross`

<!-- ocip:account Cross -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `creator` | `Pubkey` | 32 | 8 |
| 2 | `cross_id` | `u64` | 8 | 40 |
| 3 | `kind` | `CrossKind` | 1 | 48 |
| 4 | `supply_mode` | `SupplyMode` | 1 | 49 |
| 5 | `disclosure` | `Disclosure` | 1 | 50 |
| 6 | `state` | `CrossState` | 1 | 51 |
| 7 | `base_mint` | `Pubkey` | 32 | 52 |
| 8 | `quote_mint` | `Pubkey` | 32 | 84 |
| 9 | `base_token_program` | `Pubkey` | 32 | 116 |
| 10 | `quote_token_program` | `Pubkey` | 32 | 148 |
| 11 | `base_decimals` | `u8` | 1 | 180 |
| 12 | `quote_decimals` | `u8` | 1 | 181 |
| 13 | `proceeds_to` | `Pubkey` | 32 | 182 |
| 14 | `min_price` | `u64` | 8 | 214 |
| 15 | `tick` | `u64` | 8 | 222 |
| 16 | `ticks` | `u16` | 2 | 230 |
| 17 | `price_scale` | `u64` | 8 | 232 |
| 18 | `open_ts` | `i64` | 8 | 240 |
| 19 | `close_ts` | `i64` | 8 | 248 |
| 20 | `reveal_end_ts` | `i64` | 8 | 256 |
| 21 | `reference_price` | `Option<u64>` | 9 | 264 |
| 22 | `min_matched` | `u64` | 8 | 273 |
| 23 | `max_imbalance_bps` | `Option<u32>` | 5 | 281 |
| 24 | `protocol_fee_bps` | `u16` | 2 | 286 |
| 25 | `integrator_fee_bps` | `u16` | 2 | 288 |
| 26 | `integrator` | `Pubkey` | 32 | 290 |
| 27 | `fee_recipient` | `Pubkey` | 32 | 322 |
| 28 | `gate_mint` | `Option<Pubkey>` | 33 | 354 |
| 29 | `shards` | `u8` | 1 | 387 |
| 30 | `max_orders` | `u32` | 4 | 388 |
| 31 | `dust_bond` | `u64` | 8 | 392 |
| 32 | `orders_total` | `u32` | 4 | 400 |
| 33 | `orders_open` | `u32` | 4 | 404 |
| 34 | `merged_mask` | `u32` | 4 | 408 |
| 35 | `clearing` | `Option<ClearingSummary>` | 94 | 412 |
| 36 | `no_print_reason` | `Option<NoPrintReason>` | 2 | 506 |
| 37 | `buyer_paid` | `u64` | 8 | 508 |
| 38 | `base_bought` | `u64` | 8 | 516 |
| 39 | `base_sold` | `u64` | 8 | 524 |
| 40 | `seller_paid` | `u64` | 8 | 532 |
| 41 | `fees_accrued` | `u64` | 8 | 540 |
| 42 | `oracle` | `Option<OracleGuard>` | 41 | 548 |
| 43 | `calendar` | `Option<Pubkey>` | 33 | 589 |
| 44 | `settler` | `Option<Pubkey>` | 33 | 622 |
| 45 | `settle_deadline_ts` | `i64` | 8 | 655 |
| 46 | `base_bound` | `bool` | 1 | 663 |
| 47 | `bump` | `u8` | 1 | 664 |
| 48 | `quote_vault_bump` | `u8` | 1 | 665 |
| 49 | `base_vault_bump` | `u8` | 1 | 666 |
| 50 | `book_bump` | `u8` | 1 | 667 |
<!-- /ocip:account -->

Field semantics:

| Field | Meaning |
|---|---|
| `creator`, `cross_id` | The PDA seeds. `cross_id` is chosen by the creator |
| `kind` | Selects the entry of `Protocol.fee_bps` snapshotted at creation. It has no other effect in the program |
| `supply_mode`, `disclosure` | §2.2, §8 |
| `state` | §5 |
| `base_mint`, `base_decimals` | Zero (`Pubkey::default()` and `0`) in a deferred-mint cross until `bind_base_mint` sets them |
| `base_token_program`, `quote_token_program` | Token program of each mint, fixed at creation |
| `proceeds_to` | Owner of the token accounts that receive issuer proceeds (mint modes) and the dust and bond remainder (all modes) at `finalize` |
| `min_price`, `tick`, `ticks`, `price_scale` | The grid and price unit. `tick > 0`, `price_scale > 0`, `0 < ticks ≤ MAX_TICKS` |
| `open_ts`, `close_ts`, `reveal_end_ts` | The windows (§5.2). For an open cross `reveal_end_ts = close_ts` |
| `reference_price` | Optional price on the grid used as a tie-break in §7.3 |
| `min_matched`, `max_imbalance_bps` | Print guards (§7.7) |
| `protocol_fee_bps`, `integrator_fee_bps`, `integrator`, `fee_recipient` | Fee snapshot (§7.6). Later changes to `Protocol` never affect an existing cross |
| `gate_mint` | If set, `commit_order` requires a `cross_gate` pass for this mint (§10.5) |
| `shards`, `max_orders` | `1 ≤ shards ≤ MAX_SHARDS`; the cap on `orders_total` |
| `dust_bond` | Quote atoms deposited at creation (§7.6) |
| `orders_total` | Incremented by every `commit_order`; never decremented |
| `orders_open` | Incremented by `commit_order`, decremented by `cancel_order` and `claim` |
| `merged_mask` | Bit `i` is set once shard `i` has been merged |
| `clearing` | The clearing summary (§7.4), present only for a cross that printed. It is not cleared by `abandon_settlement` |
| `no_print_reason` | Present once a cross has been marked no print |
| `buyer_paid`, `base_bought`, `base_sold`, `seller_paid`, `fees_accrued` | Running totals updated by `claim` |
| `oracle` | Optional oracle guard (§7.8) |
| `calendar` | Optional calendar account the cross is scheduled on (§11) |
| `settler`, `settle_deadline_ts`, `base_bound` | Deferred-mint settlement (§9). `base_bound` is `true` from creation in every other supply mode |
| `bump`, `quote_vault_bump`, `base_vault_bump`, `book_bump` | Stored PDA bumps |

### 3.8 `Levels`: the book and the shards

Both the merged book and each shard are `Levels` accounts: an account of 6192 bytes whose fixed arrays hold, for tick `i`, the aggregate buy quantity, aggregate sell quantity, buy order count and sell order count.

<!-- ocip:account Levels -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `cross` | `Pubkey` | 32 | 8 |
| 2 | `buy` | `[u64; 256]` | 2048 | 40 |
| 3 | `sell` | `[u64; 256]` | 2048 | 2088 |
| 4 | `buy_orders` | `[u32; 256]` | 1024 | 4136 |
| 5 | `sell_orders` | `[u32; 256]` | 1024 | 5160 |
| 6 | `index` | `u8` | 1 | 6184 |
| 7 | `_pad` | `[u8; 7]` | 7 | 6185 |
<!-- /ocip:account -->

`cross` binds the account to its cross. For a shard `index` is its shard number; for the book it is `0` and unused. The arrays are indexed by tick `i`, price `min_price + i · tick`; entries at `i ≥ ticks` are always zero.

### 3.9 `Order`

<!-- ocip:account Order -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `cross` | `Pubkey` | 32 | 8 |
| 2 | `owner` | `Pubkey` | 32 | 40 |
| 3 | `nonce` | `u64` | 8 | 72 |
| 4 | `index` | `u32` | 4 | 80 |
| 5 | `side` | `OrderSide` | 1 | 84 |
| 6 | `state` | `OrderState` | 1 | 85 |
| 7 | `commitment` | `[u8; 32]` | 32 | 86 |
| 8 | `price` | `u64` | 8 | 118 |
| 9 | `quantity` | `u64` | 8 | 126 |
| 10 | `escrow` | `u64` | 8 | 134 |
| 11 | `bump` | `u8` | 1 | 142 |
<!-- /ocip:account -->

- A sealed order has `state = Committed`, the `commitment` its owner supplied and `price = quantity = 0` until it is revealed. An open order is created `Revealed` with its plaintext price and quantity and a zero `commitment`.
- `escrow` is the quote atoms (buy) or base atoms (sell) transferred to the cross's vault when the order was placed.
- There is no `Claimed` or `Cancelled` state: `claim` and `cancel_order` close the account and return its rent to `owner`. An order that does not exist as an account has been settled or never placed.

### 3.10 Argument and nested types

<!-- ocip:struct CreateCrossParams -->
**`CreateCrossParams`**

| Field | Type |
|---|---|
| `cross_id` | `u64` |
| `kind` | `CrossKind` |
| `supply_mode` | `SupplyMode` |
| `disclosure` | `Disclosure` |
| `min_price` | `u64` |
| `tick` | `u64` |
| `ticks` | `u16` |
| `price_scale` | `u64` |
| `open_ts` | `i64` |
| `close_ts` | `i64` |
| `reveal_end_ts` | `i64` |
| `reference_price` | `Option<u64>` |
| `min_matched` | `u64` |
| `max_imbalance_bps` | `Option<u32>` |
| `integrator_fee_bps` | `u16` |
| `integrator` | `Pubkey` |
| `gate_mint` | `Option<Pubkey>` |
| `oracle` | `Option<OracleGuard>` |
| `calendar` | `Option<Pubkey>` |
| `shards` | `u8` |
| `max_orders` | `u32` |
| `proceeds_to` | `Pubkey` |
| `schedule` | `Vec<SupplyLevel>` |
| `settler` | `Option<Pubkey>` |
| `settle_deadline_ts` | `i64` |
<!-- /ocip:struct -->

<!-- ocip:struct CommitOrderArgs -->
**`CommitOrderArgs`**

| Field | Type |
|---|---|
| `nonce` | `u64` |
| `side` | `OrderSide` |
| `escrow` | `u64` |
| `commitment` | `[u8; 32]` |
| `price` | `u64` |
| `quantity` | `u64` |
| `order_bump` | `u8` |
<!-- /ocip:struct -->

<!-- ocip:struct SupplyLevel -->
**`SupplyLevel`**

| Field | Type |
|---|---|
| `price` | `u64` |
| `quantity` | `u64` |
<!-- /ocip:struct -->

<!-- ocip:struct OracleGuard -->
**`OracleGuard`**

| Field | Type |
|---|---|
| `feed_id` | `[u8; 32]` |
| `max_divergence_bps` | `u32` |
| `max_staleness_secs` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct ClearingSummary -->
**`ClearingSummary`**

| Field | Type |
|---|---|
| `price` | `u64` |
| `matched` | `u128` |
| `demand` | `u128` |
| `supply` | `u128` |
| `rationed` | `u8` |
| `marginal_quantity` | `u128` |
| `marginal_remaining` | `u128` |
| `marginal_orders` | `u32` |
<!-- /ocip:struct -->

`ClearingSummary.rationed` is `0` for none, `1` for buy and `2` for sell. The summary mirrors `clearing_core::Clearing` (§7.4).


## 4. Instruction conventions

### 4.1 Instruction index

Every instruction of the four normative programs and of `treasury`, with its 8-byte discriminator in hex. A discriminator is per program: `propose_admin` has the same discriminator in `cross_core` and in `cross_calendar` because the name is the same. Instruction data is the discriminator followed by the Borsh-encoded arguments in the order listed in §6, §9, §10 and §11.

| Program | Instruction | Discriminator | Rule |
|---|---|---|---|
| `cross_core` | `abandon_settlement` | `21eaa4bdd3b63171` | Anchor default |
| `cross_core` | `accept_admin` | `702a2d5a74b50daa` | Anchor default |
| `cross_core` | `bind_base_mint` | `ec6386e535b395e7` | Anchor default |
| `cross_core` | `cancel_order` | `5f81edf00831df84` | Anchor default |
| `cross_core` | `challenge_insider` | `32b38b720dc2e17c` | Anchor default |
| `cross_core` | `claim` | `3ec6d6c1d59f6cd2` | Anchor default |
| `cross_core` | `clear` | `fa271cd57ba38505` | Anchor default |
| `cross_core` | `close_applicant` | `75bbd9c14c6e709d` | Anchor default |
| `cross_core` | `commit_order` | `6aa7bdba4a718be8` | Anchor default |
| `cross_core` | `commit_order_ext` | `1b5f4b78ee474af0` | Anchor default |
| `cross_core` | `create_cross` | `b127363de7b3e902` | Anchor default |
| `cross_core` | `create_series` | `b5093478c5dd2a8e` | Anchor default |
| `cross_core` | `draw_begin` | `ecbed0feadfdbd2b` | Anchor default |
| `cross_core` | `draw_finish` | `2491c96ecf6a982d` | Anchor default |
| `cross_core` | `expire_challenge` | `495214e3d8423a29` | Anchor default |
| `cross_core` | `finalize` | `ab3dda387f730cd9` | Anchor default |
| `cross_core` | `init_class_book` | `b50a1b7331ebae38` | Anchor default |
| `cross_core` | `init_halt_state` | `7d63fab7602ea61a` | Anchor default |
| `cross_core` | `init_lock_vault` | `201d07bdffc742ab` | Anchor default |
| `cross_core` | `init_print_feed` | `51deb4f1731f7377` | Anchor default |
| `cross_core` | `init_protocol` | `03bc8dede1e2e8d2` | Anchor default |
| `cross_core` | `init_shard` | `342b84d080698727` | Anchor default |
| `cross_core` | `log_ext` | `a3ce08799f8a6221` | Anchor default |
| `cross_core` | `merge_shard` | `4aeceb6409b301a8` | Anchor default |
| `cross_core` | `migrate_protocol` | `b6fefddc0090eafa` | Anchor default |
| `cross_core` | `observe_price` | `93b204150ed5519f` | Anchor default |
| `cross_core` | `propose_admin` | `79d6c7d4572775ea` | Anchor default |
| `cross_core` | `push_refunds` | `e3083d1aaddec719` | Anchor default |
| `cross_core` | `release_locked` | `43af87ee17bf823c` | Anchor default |
| `cross_core` | `resolve_challenge` | `51bf7c7783f89d6d` | Anchor default |
| `cross_core` | `reveal_order` | `19f42adb119cd34a` | Anchor default |
| `cross_core` | `series_withdraw` | `72f66ca6d0f0aaae` | Anchor default |
| `cross_core` | `set_arbiter` | `0fcdc2b4acd571d3` | Anchor default |
| `cross_core` | `set_corporate_action` | `5c0a689a2b30c45a` | Anchor default |
| `cross_core` | `set_feed_publishers` | `776f91d3490f9d9a` | Anchor default |
| `cross_core` | `set_guardian` | `93f332799aa4321e` | Anchor default |
| `cross_core` | `set_halt` | `d4c0b3421749c50f` | Anchor default |
| `cross_core` | `set_paused` | `5b3c7dc0b0e1a6da` | Anchor default |
| `cross_core` | `set_protocol_fees` | `318fbd1238ce9ee2` | Anchor default |
| `cross_core` | `set_rules` | `4294c42be8d2aea9` | Anchor default |
| `cross_core` | `set_series_active` | `2fa403c9b1d49fdf` | Anchor default |
| `cross_core` | `spawn_next` | `00547321e4e0416d` | Anchor default |
| `cross_core` | `sync_pause` | `4064d0cc9b84312a` | Anchor default |
| `cross_gate` | `can_freeze_permissionless` | `d68d6d4bf8012d1d` | explicit |
| `cross_gate` | `can_thaw_permissionless` | `08afa981894a3df1` | explicit |
| `cross_gate` | `claim_pass` | `8ef8bc42ea65c6d3` | Anchor default |
| `cross_gate` | `claim_pass_merkle` | `734231613e480dde` | Anchor default |
| `cross_gate` | `close_lock` | `3afeb78297ee5f36` | Anchor default |
| `cross_gate` | `create_config` | `c9cff3724b6f2fbd` | Anchor default |
| `cross_gate` | `execute` | `692565c54bfb661a` | explicit |
| `cross_gate` | `grant_pass` | `08064d3d5e06ca7b` | Anchor default |
| `cross_gate` | `init_gate_metas` | `289b4ea44c25b3ea` | Anchor default |
| `cross_gate` | `init_hook_metas` | `2b220d31a758ebeb` | explicit |
| `cross_gate` | `revoke_pass` | `08ce8864b2dba8fc` | Anchor default |
| `cross_gate` | `revoke_unattested` | `551bcab225496f45` | Anchor default |
| `cross_gate` | `set_allowlist_root` | `91eefcad0f035e17` | Anchor default |
| `cross_gate` | `set_authority` | `85fa25156ea31a79` | Anchor default |
| `cross_gate` | `set_lock` | `4a2d89840b56d5f2` | Anchor default |
| `cross_gate` | `set_mode` | `9f2f93f7553554e6` | Anchor default |
| `cross_gate` | `set_sas_requirement` | `88a313cf52a69bb7` | Anchor default |
| `cross_settle` | `bind_dbc_mint` | `5c4c468431421010` | Anchor default |
| `cross_settle` | `claim_partner_fee` | `61ce27695e5e7e94` | Anchor default |
| `cross_settle` | `claim_partner_pool_creation_fee` | `faee1a048b0a65f8` | Anchor default |
| `cross_settle` | `claim_pol_fees` | `7faa7893edb79ff6` | Anchor default |
| `cross_settle` | `create_greenshoe` | `790ab1f3b0c3a708` | Anchor default |
| `cross_settle` | `deploy_greenshoe_bid` | `1666e52b2a274335` | Anchor default |
| `cross_settle` | `finish_greenshoe` | `ed749332903fdcf5` | Anchor default |
| `cross_settle` | `open_dbc_pool` | `440e79b574c1e1b2` | Anchor default |
| `cross_settle` | `open_dbc_pool_locked` | `c2efeac9304df95f` | Anchor default |
| `cross_settle` | `open_dlmm_pair` | `a6c2b662acb01d14` | Anchor default |
| `cross_settle` | `open_dlmm_pair_badged` | `834af8a9ba4f1d29` | Anchor default |
| `cross_settle` | `open_dlmm_pair_batched` | `7f59563ad0861265` | Anchor default |
| `cross_settle` | `open_fixed_price_presale` | `34611f0884997c69` | Anchor default |
| `cross_settle` | `seed_damm_v2` | `0a846137cc3c4955` | Anchor default |
| `cross_settle` | `seed_damm_v2_batched` | `b45c59900119f2e8` | Anchor default |
| `cross_settle` | `seed_futarchy_dao` | `bacf1a1f7a34ca06` | Anchor default |
| `cross_settle` | `seed_raydium_cpmm` | `f9bcc67f97d40e68` | Anchor default |
| `cross_settle` | `settle_greenshoe_level` | `61e14a2e76ff1701` | Anchor default |
| `cross_settle` | `withdraw_partner_migration_fee` | `e799311760c1c129` | Anchor default |
| `cross_settle` | `withdraw_partner_surplus` | `20d5762ec37a0dc9` | Anchor default |
| `cross_calendar` | `apply_admin` | `44df4e336b449dea` | Anchor default |
| `cross_calendar` | `apply_update` | `4ca614936c76ae26` | Anchor default |
| `cross_calendar` | `cancel_update` | `4ce563c37e8a44f7` | Anchor default |
| `cross_calendar` | `create_calendar` | `8c4601637b2442a1` | Anchor default |
| `cross_calendar` | `propose_admin` | `79d6c7d4572775ea` | Anchor default |
| `cross_calendar` | `propose_update` | `a1df56cc50c7c6cf` | Anchor default |
| `treasury` | `claim_distribution` | `cc9c5e55027de8b4` | Anchor default |
| `treasury` | `create_grant` | `1377b0df2d8ee19c` | Anchor default |
| `treasury` | `create_treasury` | `fe62d93319588c2d` | Anchor default |
| `treasury` | `deposit_distribution` | `60577900a9ccd99e` | Anchor default |
| `treasury` | `execute_proposal` | `ba3c74856c806f1c` | Anchor default |
| `treasury` | `expire_grant` | `4f669056fd469ac5` | Anchor default |
| `treasury` | `init_ext` | `40434371dbca3db0` | Anchor default |
| `treasury` | `mark_missed` | `8f547ec039a8e31a` | Anchor default |
| `treasury` | `nav_redeem` | `42dca951c52bed62` | Anchor default |
| `treasury` | `pay_round` | `586dc42ec7de5a62` | Anchor default |
| `treasury` | `post_disclosure` | `382c801bb566c77f` | Anchor default |
| `treasury` | `propose` | `5dfd52a87621665a` | Anchor default |
| `treasury` | `reclaim_vote` | `36f9f7895d5f865b` | Anchor default |
| `treasury` | `record_assignment` | `e95b9de44afbd6ea` | Anchor default |
| `treasury` | `record_attested` | `d8aec36025b0c3c3` | Anchor default |
| `treasury` | `record_lapse` | `13c7c7b47d022562` | Anchor default |
| `treasury` | `redeem` | `b80c569546c461e1` | Anchor default |
| `treasury` | `release_milestone` | `3802c7a4b86ca7de` | Anchor default |
| `treasury` | `release_tranche` | `9c899f05502685e3` | Anchor default |
| `treasury` | `request_disclosure` | `6c32fb157b45f414` | Anchor default |
| `treasury` | `spend` | `f2cdff5765d9f539` | Anchor default |
| `treasury` | `stake` | `ceb0ca12c8d1b36c` | Anchor default |
| `treasury` | `sweep_unclaimed` | `40a8dde02ad88a90` | Anchor default |
| `treasury` | `trigger_liquidation` | `ec5fb877c54394e5` | Anchor default |
| `treasury` | `unstake` | `5a5f6b2acd7c32e1` | Anchor default |
| `treasury` | `vote` | `e36e9b17887eac19` | Anchor default |

### 4.2 Account tables

In the account tables of §6 and the following sections, the flags column uses: `W` writable, `S` signer, `O` optional. An optional account is passed as the program id itself when absent, as Anchor encodes `Option<Account>`. An address in the notes column is a fixed account the program checks. "PDA" lists the seeds from §3.3. Accounts are listed in instruction order.

### 4.3 Errors

Failures return Anchor custom errors, numbered from 6000 in the order of the tables in §12.2, or Anchor framework errors (constraint, account-not-initialized, deserialization and token-program errors), which this document does not enumerate. A transaction that fails changes no state.

### 4.4 Permissionless instructions

An instruction described as permissionless needs a fee-paying signer and no authority. `claim` always pays the order's owner, whoever sends it, so any party can crank it.

## 5. Cross lifecycle and state machine

### 5.1 States

`Cross.state` takes one of four values (§3.4): `Live`, `Cleared`, `NoPrint`, `Finalized`.

| State | Meaning |
|---|---|
| `Live` | Created. Accepts orders during the call window, accepts reveals during the reveal window, and may be merged and cleared once `reveal_end_ts` has passed. The state does not change when time passes |
| `Cleared` | A price was found and passed every guard. `clearing` is present. Claims pay fills and refund the rest |
| `NoPrint` | No price, a guard refused it, the oracle refused it, or settlement was abandoned. Claims refund every order in full |
| `Finalized` | Every order has been claimed or cancelled and the remainders have been distributed. Terminal |

### 5.2 Time phases of a `Live` cross

| Phase | Condition on the cluster clock `now` | Permitted order actions |
|---|---|---|
| Before the call | `now < open_ts` | None: `commit_order` fails with `NotInCallWindow` |
| Call window | `open_ts ≤ now < close_ts` | `commit_order`, `cancel_order` |
| Reveal window | `close_ts ≤ now < reveal_end_ts` | `reveal_order` (sealed crosses only). In an open cross `reveal_end_ts = close_ts` and this window is empty |
| Merge and clear | `now ≥ reveal_end_ts` | `merge_shard`, then `clear` |

`cancel_order` checks only `now < close_ts` (it does not check `open_ts`). Because an order cannot exist before `open_ts`, this has no effect on a well-formed cross.

### 5.3 Transitions

| From | To | Instruction | Condition |
|---|---|---|---|
| (none) | `Live` | `create_cross` | §6.2 |
| `Live` | `Cleared` | `clear` | All shards merged; a price exists; it passes the volume, imbalance and oracle guards |
| `Live` | `NoPrint` | `clear` | All shards merged; no price (`NoCross`), or `BelowMinimumVolume`, `ImbalanceTooHigh`, `OracleDivergence` or `OracleUnavailable` |
| `Cleared` | `NoPrint` | `abandon_settlement` | `supply_mode = DeferredMint`, `base_bound = false`, `now ≥ settle_deadline_ts`. Reason `SettlementExpired` |
| `Cleared` | `Finalized` | `finalize` | `orders_open = 0` |
| `NoPrint` | `Finalized` | `finalize` | `orders_open = 0` |

No other transition exists. In particular a `Cleared` or `NoPrint` cross cannot return to `Live`, and `Finalized` is terminal. Within `Cleared`, a deferred-mint cross has `base_bound = false` until `bind_base_mint` runs; while it is false, `claim` fails with `SettlementPending` (§9).

```
create_cross
    │
    ▼
  Live
    ├── clear: a price is found and every guard passes ──▶ Cleared ──┬── finalize ──────────────▶ Finalized
    │                                                                └── abandon_settlement ──▶ NoPrint
    └── clear: no price, or a guard refuses it ─────────▶ NoPrint ──── finalize ──────────────▶ Finalized
```

`abandon_settlement` applies only to a `Cleared` deferred-mint cross that never bound a mint.

### 5.4 Pause

`Protocol.paused` is read by `create_cross` and `commit_order` only. A paused protocol still accepts `cancel_order`, `reveal_order`, `merge_shard`, `clear`, `claim`, `abandon_settlement` and `finalize`, so no order can be trapped by a pause.

### 5.5 Which instruction is allowed when

| Instruction | `Live` | `Cleared` | `NoPrint` | `Finalized` |
|---|---|---|---|---|
| `commit_order` | during the call window, if not paused | no | no | no |
| `cancel_order` | before `close_ts` | no | no | no |
| `reveal_order` | during the reveal window (sealed) | no | no | no |
| `init_shard` | yes (no state check) | yes | yes | yes |
| `merge_shard` | from `reveal_end_ts` | no | no | no |
| `clear` | when every shard is merged | no | no | no |
| `bind_base_mint` | no | deferred-mint, unbound, before the deadline | no | no |
| `abandon_settlement` | no | deferred-mint, unbound, after the deadline | no | no |
| `claim` | no | yes (after the base mint is bound, if deferred) | yes | no |
| `finalize` | no | when `orders_open = 0` | when `orders_open = 0` | no |

`init_shard` checks `index < shards` and that the account does not yet exist; it does not read `state`, so shards can be created after a cross has left `Live`, but a cross whose shards were not all created before `reveal_end_ts` cannot be merged or cleared until they exist.

### 5.6 Order lifecycle

```
(no account) ──commit_order──▶ Committed ──reveal_order──▶ Revealed ──claim──▶ (account closed)
                    │                                          │
                    └────────────cancel_order (before close)───┴──▶ (account closed)
```

An open-disclosure order is created already `Revealed`. A sealed order that is never revealed stays `Committed`; `claim` refunds it in full once the cross is `Cleared` or `NoPrint`.

## 6. `cross_core` instruction reference

Each entry lists accounts, arguments, preconditions in the order the program checks them with the error each returns, effects, and events. Errors are named in §12.2.

### 6.1 Administration

#### `init_protocol`

Creates the singleton `Protocol` account; the signer becomes `admin`.

<!-- ocip:ix cross_core init_protocol -->
Discriminator `03bc8dede1e2e8d2`. Arguments: `guardian: Pubkey`, `fee_recipient: Pubkey`, `fee_bps: [u16; 4]`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `admin` | WS |  |
| 2 | `protocol` | W | PDA ["protocol"] |
| 3 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

Preconditions: every entry of `fee_bps` is at most `MAX_PROTOCOL_FEE_BPS` (`FeeTooHigh`). The PDA must not exist (Anchor `init`). Effects: `admin = signer`, `guardian`, `fee_recipient`, `fee_bps` as given, `paused = false`, `pending_admin = None`. No event.

#### `set_protocol_fees`

Admin only (`Unauthorized` otherwise). Sets `fee_recipient` and `fee_bps`; each entry at most `MAX_PROTOCOL_FEE_BPS` (`FeeTooHigh`). Affects crosses created afterwards; existing crosses keep their snapshot. No event.

<!-- ocip:ix cross_core set_protocol_fees -->
Discriminator `318fbd1238ce9ee2`. Arguments: `fee_recipient: Pubkey`, `fee_bps: [u16; 4]`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `admin` | S |  |
| 2 | `protocol` | W | PDA ["protocol"] |
<!-- /ocip:ix -->

#### `migrate_protocol`

Brings a `Protocol` account written by an earlier layout up to the current size. Admin only: the stored admin (bytes 8..40) must equal the signer (`Unauthorized`); the account must be owned by `cross_core`, be the PDA, and carry the `Protocol` discriminator (`Unauthorized`). If the account is already at least `8 + INIT_SPACE` bytes it returns without change. Otherwise the admin pays the extra rent, the account is resized, and every added byte is zeroed (so `pending_admin = None`). No event.

<!-- ocip:ix cross_core migrate_protocol -->
Discriminator `b6fefddc0090eafa`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `admin` | WS |  |
| 2 | `protocol` | W |  |
| 3 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `propose_admin`, `accept_admin`

Two-step admin handover. `propose_admin(new_admin)` (admin only) stores `new_admin` in `pending_admin`; `None` withdraws a proposal. Event `AdminProposed`. `accept_admin` must be signed by the proposed key (`Unauthorized` if `pending_admin` differs); it sets `admin`, clears `pending_admin`, and emits `AdminChanged`.

<!-- ocip:ix cross_core propose_admin -->
Discriminator `79d6c7d4572775ea`. Arguments: `new_admin: Option<Pubkey>`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `admin` | S |  |
| 2 | `protocol` | W | PDA ["protocol"] |
<!-- /ocip:ix -->

<!-- ocip:ix cross_core accept_admin -->
Discriminator `702a2d5a74b50daa`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `new_admin` | S |  |
| 2 | `protocol` | W | PDA ["protocol"] |
<!-- /ocip:ix -->

#### `set_guardian`

Admin only. Sets `Protocol.guardian`. No event.

<!-- ocip:ix cross_core set_guardian -->
Discriminator `93f332799aa4321e`. Arguments: `guardian: Pubkey`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `admin` | S |  |
| 2 | `protocol` | W | PDA ["protocol"] |
<!-- /ocip:ix -->

#### `set_paused`

Signer must be the guardian or the admin (`Unauthorized`). Sets `paused`. Event `PauseChanged`. See §5.4.

<!-- ocip:ix cross_core set_paused -->
Discriminator `5b3c7dc0b0e1a6da`. Arguments: `paused: bool`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `signer` | S |  |
| 2 | `protocol` | W | PDA ["protocol"] |
<!-- /ocip:ix -->

### 6.2 `create_cross`

Creates the `Cross`, the `Book`, the quote vault and (unless deferred-mint) the base vault; deposits the dust bond; for the mint modes, loads the issuer's schedule into the book.

<!-- ocip:ix cross_core create_cross -->
Discriminator `b127363de7b3e902`. Arguments: `params: CreateCrossParams`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `protocol` | – | PDA ["protocol"] |
| 3 | `cross` | W | PDA ["cross", creator, params.cross_id] |
| 4 | `book` | W | PDA ["book", cross] |
| 5 | `base_mint` | O |  |
| 6 | `quote_mint` | – |  |
| 7 | `quote_vault` | W | PDA ["quote_vault", cross] |
| 8 | `base_vault` | WO | PDA ["base_vault", cross] |
| 9 | `creator_quote` | W |  |
| 10 | `calendar_account` | O |  |
| 11 | `base_token_program` | – |  |
| 12 | `quote_token_program` | – |  |
| 13 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

`base_mint` and `base_vault` MUST be present for every supply mode except `DeferredMint` and MUST be absent for `DeferredMint`. `calendar_account` is required when `params.calendar` is set. The vaults are token accounts owned by the cross PDA.

Preconditions, in the order checked:

1. `Protocol.paused` is false (`Paused`).
2. `integrator_fee_bps ≤ MAX_INTEGRATOR_FEE_BPS` (`FeeTooHigh`).
3. `tick > 0` and `price_scale > 0` (`InvalidParams`).
4. `0 < ticks ≤ MAX_TICKS` (`InvalidParams`).
5. `0 < shards ≤ MAX_SHARDS` (`InvalidParams`).
6. `max_orders > 0` (`InvalidParams`).
7. `supply_mode = DeferredMint` if and only if `base_mint` and `base_vault` are absent (`InvalidParams`).
8. If `base_mint` is present it differs from `quote_mint` (`InvalidParams`).
9. `open_ts < close_ts` and `close_ts > now` (`InvalidTimeline`).
10. For a sealed cross `reveal_end_ts > close_ts` (`InvalidTimeline`). For an open cross the argument is ignored and `reveal_end_ts = close_ts`.
11. If `oracle` is present: the supply mode is not `DeferredMint`, `max_divergence_bps > 0` and `max_staleness_secs > 0` (`InvalidParams`).
12. If `calendar` is present: `calendar_account` is present with that address and is owned by the `cross_calendar` program (`CalendarMismatch`), decodes as a `Calendar`, and has a session whose `start_ts` equals `close_ts` (`NotACalendarSession`); if an `oracle` is present its `feed_id` is on the calendar's approved list (`FeedNotApproved`).
13. For `DeferredMint`: `settler` is present (`InvalidParams`) and `settle_deadline_ts > reveal_end_ts` (`InvalidTimeline`). For every other mode `settler` is absent (`InvalidParams`).
14. If `reference_price` is present it lies on the grid (`OffGrid`).
15. The dust bond is computed (§7.6); an overflow fails (`Overflow`).
16. For `Mint` and `DeferredMint`: `schedule` is non-empty (`InvalidParams`). If a base mint is present its mint authority is the cross PDA (`MintAuthorityNotCross`). Each schedule price lies on the grid (`OffGrid`) and each schedule quantity is positive (`InvalidParams`). For `Escrow`: `schedule` is empty (`InvalidParams`).
17. The creator's quote token account holds the bond; the transfer to the quote vault fails otherwise (token-program error).

Effects:

- All parameters are stored as given, except: `reveal_end_ts` as in 10; `protocol_fee_bps = min(Protocol.fee_bps[kind], integrator_fee_bps / 4)` with integer division (§7.6); `fee_recipient = Protocol.fee_recipient`; `base_bound = (supply_mode ≠ DeferredMint)`; `base_decimals` and `quote_decimals` from the mints (`base_decimals = 0` when deferred).
- Each schedule level is added to the book as a sell at its tick: the level's quantity is added to the tick's aggregate and the tick's sell order count is incremented by one per schedule level. Two levels at one tick therefore add two to the count.
- The Cross PDA is created at `["cross", creator, cross_id]`. An existing account makes the instruction fail.
- Event `CrossCreated`.

The program does not restrict which `kind` is combined with which `supply_mode` or `disclosure`, does not bound `max_imbalance_bps` or `min_price`, and does not validate `gate_mint` or `integrator`. Integrators SHOULD apply their own checks (the reference API limits `max_imbalance_bps` to 10,000 and `integrator_fee_bps` to 300; `POST /v1/tx/create-cross`).

#### `init_shard`

Creates shard `index` of a cross as a `Levels` account at `["shard", cross, index]`, with `cross` and `index` set. Any signer may pay. `index < cross.shards` (`InvalidParams`). All `cross.shards` shards MUST exist before the cross can be merged and cleared. No event.

<!-- ocip:ix cross_core init_shard -->
Discriminator `342b84d080698727`. Arguments: `index: u8`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `cross` | – |  |
| 3 | `shard` | W |  |
| 4 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

### 6.3 Order entry

#### `commit_order`

Places an order and escrows its funds. Open crosses take the plaintext price and quantity and add them to a shard immediately; sealed crosses store only a commitment.

<!-- ocip:ix cross_core commit_order -->
Discriminator `6aa7bdba4a718be8`. Arguments: `args: CommitOrderArgs`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `owner` | WS |  |
| 2 | `protocol` | – | PDA ["protocol"] |
| 3 | `cross` | W |  |
| 4 | `order` | W |  |
| 5 | `shard` | WO |  |
| 6 | `pass` | O |  |
| 7 | `escrow_mint` | – |  |
| 8 | `escrow_vault` | W |  |
| 9 | `owner_escrow` | W |  |
| 10 | `escrow_token_program` | – |  |
| 11 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

`shard` is required for open crosses and omitted for sealed crosses. `pass` is required when the cross has a `gate_mint`. `escrow_mint`, `escrow_vault`, `owner_escrow` and `escrow_token_program` refer to the quote token for a buy and the base token for a sell.

Preconditions, in the order checked:

1. `Protocol.paused` is false (`Paused`).
2. `state = Live` and `open_ts ≤ now < close_ts` (`NotInCallWindow`).
3. `orders_total < max_orders` (`CrossFull`).
4. `escrow > 0` (`InvalidParams`).
5. A sell requires `supply_mode = Escrow` (`SellsNotAccepted`).
6. If `gate_mint` is set, `pass` is a valid pass for the order's owner (§10.5) (`NotEligible`).
7. The `order` account is the PDA for `(cross, owner, nonce)` under the supplied `order_bump`, has no data and no lamports (`InvalidParams`).
8. Open crosses only: `quantity > 0` (`InvalidParams`); `price` is on the grid (`OffGrid`); for a buy `ceil(quantity · price / price_scale) ≤ escrow`, for a sell `quantity ≤ escrow` (`InsufficientEscrow`; an overflow fails `Overflow`); `shard` is present (`ShardMissing`) and is the shard the order maps to (§8.4) and belongs to this cross (`WrongShard`).
9. `escrow_mint` equals the cross's quote mint (buy) or base mint (sell), and `escrow_token_program` equals the corresponding stored token program (`WrongMint`); `escrow_vault` is the corresponding vault PDA (`WrongVault`).

Effects:

- The `Order` account is created, owned by `cross_core`, funded by `owner`.
- Sealed: the order stores `commitment`, `price = 0`, `quantity = 0`, `state = Committed`. The arguments `price` and `quantity` are ignored. No price or quantity is validated until `reveal_order`; `escrow` is only required to be positive.
- Open: the order stores `price`, `quantity`, `state = Revealed`, a zero `commitment`; the quantity is added to the shard at the order's tick and its order count incremented. The argument `commitment` is ignored.
- `escrow` tokens are transferred from `owner_escrow` to the vault with `transfer_checked`.
- `orders_total` and `orders_open` are incremented.
- Event `OrderCommitted` with `index` the value of `orders_total` before the increment.

The `order_bump` argument is the bump of the order PDA, computed by the client.

#### `cancel_order`

Owner only. Withdraws an order before the call closes. Full refund, no fee. The `order` account is closed and its rent returned to `owner`.

<!-- ocip:ix cross_core cancel_order -->
Discriminator `5f81edf00831df84`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `owner` | WS |  |
| 2 | `cross` | W |  |
| 3 | `order` | W |  |
| 4 | `shard` | WO |  |
| 5 | `base_mint` | – |  |
| 6 | `quote_mint` | – |  |
| 7 | `quote_vault` | W | PDA ["quote_vault", cross] |
| 8 | `base_vault` | W | PDA ["base_vault", cross] |
| 9 | `owner_quote` | WO |  |
| 10 | `owner_base` | WO |  |
| 11 | `base_token_program` | – |  |
| 12 | `quote_token_program` | – |  |
<!-- /ocip:ix -->

Preconditions: `state = Live` and `now < close_ts` (`NotInCallWindow`); the order belongs to the signer and the cross (`Unauthorized`, `WrongCross`). If the order is `Revealed` (every open order), `shard` is present and is the order's shard (`ShardMissing`, `WrongShard`) and the quantity is removed from it. The escrow is returned to `owner_quote` for a buy and `owner_base` for a sell; the matching account MUST be present (`TokenAccountMissing`).

Effects: `orders_open` is decremented; `orders_total` is not, so a cancelled order still counts toward `max_orders`. Event `OrderCancelled`.

The account list requires `base_mint` and `base_vault` to be present. A deferred-mint cross has neither before its mint is bound, so whether `cancel_order` can be called on one before `bind_base_mint` is NOT VERIFIED: no test in the repository calls it.

#### `reveal_order`

Owner only. Reveals a sealed order and adds it to its shard.

<!-- ocip:ix cross_core reveal_order -->
Discriminator `19f42adb119cd34a`. Arguments: `price: u64`, `quantity: u64`, `salt: [u8; 32]`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `owner` | S |  |
| 2 | `cross` | – |  |
| 3 | `order` | W |  |
| 4 | `shard` | W |  |
<!-- /ocip:ix -->

Preconditions: the cross is sealed (`NotSealed`); `state = Live` and `close_ts ≤ now < reveal_end_ts` (`NotInRevealWindow`); the order is `Committed` (`AlreadyRevealed`); `commitment_of(cross, owner, nonce, side, price, quantity, salt)` equals the stored commitment (`CommitmentMismatch`; §8.2); `quantity > 0`, `price` on the grid, and the stored `escrow` covers the order exactly as in `commit_order` step 8 (`InvalidParams`, `OffGrid`, `InsufficientEscrow`); the shard is the order's shard and belongs to the cross (`WrongShard`).

Effects: the quantity is added to the shard at the price's tick, the order becomes `Revealed` with the revealed `price` and `quantity`. Event `OrderRevealed`.

### 6.4 Settlement

#### `merge_shard`

Permissionless. Adds one shard into the book, once.

<!-- ocip:ix cross_core merge_shard -->
Discriminator `4aeceb6409b301a8`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | W |  |
| 2 | `book` | W | PDA ["book", cross] |
| 3 | `shard` | – |  |
<!-- /ocip:ix -->

Preconditions: `state = Live` and `now ≥ reveal_end_ts` (`CallNotOver`); the shard belongs to the cross (`WrongShard`); its bit in `merged_mask` is clear (`AlreadyMerged`). Effects: every per-tick quantity and order count of the shard is added to the book (an overflow fails `Overflow`) and the bit is set. No event.

Because the mint-mode schedule was loaded into the book at creation, the book already holds the schedule before any shard is merged.

#### `clear`

Permissionless. Computes the clearing price from the merged book and sets the outcome.

<!-- ocip:ix cross_core clear -->
Discriminator `fa271cd57ba38505`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | W |  |
| 2 | `book` | – | PDA ["book", cross] |
| 3 | `oracle_price` | O |  |
<!-- /ocip:ix -->

`oracle_price` is a Pyth `PriceUpdateV2` account; it is required when the cross has an `oracle` guard and ignored otherwise.

Preconditions: `state = Live` (`WrongState`); `merged_mask` has a bit set for every shard `0 ≤ i < shards` (`ShardsNotMerged`). `clear` has no time condition of its own: it is reachable only after `merge_shard`, which requires `now ≥ reveal_end_ts`.

Procedure:

1. Build a level for every tick `i < ticks` where the book's buy or sell aggregate is non-zero, at price `min_price + i · tick`, with the aggregates as `u128`.
2. Run the clearing rule (§7.3) with `reference_price` on the cross's grid. An inconsistent book (a level with quantity but no orders, or orders but no quantity) fails with `InvalidBook`.
3. No price: `state = NoPrint`, `no_print_reason = NoCross`.
4. A price: apply the volume guard, then the imbalance guard (§7.7). A failure sets `NoPrint` with `BelowMinimumVolume` or `ImbalanceTooHigh`.
5. If the guards pass, apply the oracle guard (§7.8) when the cross has one. A verdict sets `NoPrint` with `OracleDivergence` or `OracleUnavailable`. If the cross has an oracle guard and `oracle_price` is absent the instruction fails with `OracleAccountMissing` and the cross stays `Live`.
6. Otherwise `state = Cleared` and `clearing = Some(summary)`.

Event `CrossCleared` with `printed = (state = Cleared)`, the stored `clearing` (absent unless printed) and `no_print_reason`.

#### `claim`

Permissionless crank; funds always go to the order's owner. Pays the order's fill at `P*` and refunds the rest, then closes the order account (rent to `owner`).

<!-- ocip:ix cross_core claim -->
Discriminator `3ec6d6c1d59f6cd2`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `cross` | W |  |
| 3 | `owner` | W |  |
| 4 | `order` | W |  |
| 5 | `base_mint` | WO |  |
| 6 | `quote_mint` | – |  |
| 7 | `quote_vault` | W | PDA ["quote_vault", cross] |
| 8 | `base_vault` | WO | PDA ["base_vault", cross] |
| 9 | `owner_quote` | W | associated token account of (owner, quote_token_program, quote_mint) |
| 10 | `owner_base` | WO |  |
| 11 | `base_token_program` | – |  |
| 12 | `quote_token_program` | – |  |
| 13 | `associated_token_program` | – | address `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| 14 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

`base_mint` and `owner_base` are required whenever base atoms are paid to the owner (a minted or transferred fill, or returned sell escrow) and may be omitted otherwise; `base_vault` is required only when base atoms are transferred out of the vault, which is the escrow mode. `owner_quote` is created as an associated token account for `owner` if it does not exist, paid by `payer`.

Preconditions: `state` is `Cleared` or `NoPrint` (`WrongState`); if `Cleared`, `base_bound` is true (`SettlementPending`); the order belongs to the cross and the owner passed (`Unauthorized`, `WrongCross`).

Payout:

| Cross state | Order state | Buy | Sell |
|---|---|---|---|
| `NoPrint` | any | refund `escrow` in quote | refund `escrow` in base |
| `Cleared` | `Committed` (never revealed) | refund `escrow` in quote | refund `escrow` in base |
| `Cleared` | `Revealed` | `fill` base; refund `escrow − pay` in quote | `gross − fee` quote; return `escrow − fill` base |

with `fill = clearing_core::fill(side, price, quantity, summary)`, `pay = ceil(fill · P* / price_scale)`, `gross = floor(fill · P* / price_scale)` and `fee = floor(gross · (protocol_fee_bps + integrator_fee_bps) / 10000)` (§7.5, §7.6). In `Mint` and `DeferredMint` crosses a buyer's `fill` base atoms are minted to `owner_base`; in `Escrow` crosses they are transferred from the base vault. Sell orders exist only in `Escrow` crosses. The running totals `buyer_paid`, `base_bought`, `base_sold`, `seller_paid` and `fees_accrued` are updated; `orders_open` is decremented. `owner_base` and `base_mint` MUST be supplied whenever base atoms move (`TokenAccountMissing`).

Event `OrderClaimed` with `fill`, `quote_out`, `base_out` and `fee`.

An unrevealed sealed order is refunded in full, with no fee, regardless of the cross's outcome.

#### `bind_base_mint`

Deferred-mint crosses only. The registered settler binds the base mint it created after the clear.

<!-- ocip:ix cross_core bind_base_mint -->
Discriminator `ec6386e535b395e7`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `settler` | S |  |
| 2 | `cross` | W |  |
| 3 | `base_mint` | – |  |
<!-- /ocip:ix -->

Preconditions: `supply_mode = DeferredMint` and `state = Cleared` and `base_bound = false` (`WrongState`); the signer equals `settler` (`NotSettler`); `now < settle_deadline_ts` (`SettlementDeadlinePassed`; ADR-0026); `base_mint` is owned by the cross's stored `base_token_program` (`WrongMint`); it differs from the quote mint (`InvalidParams`); its mint authority is the cross PDA (`MintAuthorityNotCross`). Effects: `base_mint`, `base_decimals`, `base_bound = true`. Event `BaseMintBound`.

#### `abandon_settlement`

Permissionless. Deferred-mint crosses only.

<!-- ocip:ix cross_core abandon_settlement -->
Discriminator `21eaa4bdd3b63171`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | W |  |
<!-- /ocip:ix -->

Preconditions: `supply_mode = DeferredMint`, `state = Cleared`, `base_bound = false` (`WrongState`); `now ≥ settle_deadline_ts` (`DeadlineNotReached`). Effects: `state = NoPrint`, `no_print_reason = SettlementExpired`. The stored `clearing` remains present. Event `CrossCleared` with `printed = false`, the retained `clearing` and the reason. Every order then refunds in full through `claim`.

An indexer or verifier MUST NOT infer from `clearing` being present that the cross printed; it MUST read `state` and `no_print_reason`.

#### `finalize`

Permissionless. Distributes what is left once every order has been claimed or cancelled.

<!-- ocip:ix cross_core finalize -->
Discriminator `ab3dda387f730cd9`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `cross` | W |  |
| 3 | `base_mint` | WO |  |
| 4 | `quote_mint` | – |  |
| 5 | `quote_vault` | W | PDA ["quote_vault", cross] |
| 6 | `base_vault` | WO | PDA ["base_vault", cross] |
| 7 | `fee_recipient_quote` | W |  |
| 8 | `integrator_quote` | W |  |
| 9 | `proceeds_quote` | W |  |
| 10 | `proceeds_base` | WO |  |
| 11 | `base_token_program` | – |  |
| 12 | `quote_token_program` | – |  |
<!-- /ocip:ix -->

`base_vault`, `base_mint` and `proceeds_base` MUST be supplied for an escrow-mode cross that holds base dust: when `supply_mode = Escrow` and `base_sold > base_bought`, a call that omits any of them fails with `BaseDustAccountsMissing` before anything moves (ADR-0025). An escrow-mode cross with no dust (`base_sold = base_bought`, which includes every cross that did not print) may omit them. A client SHOULD always supply them for an escrow-mode cross. In the mint modes `base_mint` is needed to hand back the mint authority. `fee_recipient_quote`, `integrator_quote` and `proceeds_quote` are token accounts of the quote mint owned by `fee_recipient`, `integrator` and `proceeds_to` respectively; they MAY be the same account.

Preconditions: `state` is `Cleared` or `NoPrint` (`WrongState`); `orders_open = 0` (`OrdersOutstanding`); in an escrow-mode cross with `base_sold > base_bought`, the three base accounts above are present (`BaseDustAccountsMissing`).

Procedure:

1. Total fees: in `Mint` and `DeferredMint`, `floor(buyer_paid · (protocol_fee_bps + integrator_fee_bps) / 10000)`; in `Escrow`, `fees_accrued`.
2. `protocol_fee = floor(fees · protocol_fee_bps / total_bps)` (zero when `total_bps` is zero); `integrator_fee = fees − protocol_fee`. Each non-zero amount is transferred from the quote vault.
3. Any base atoms left in the base vault (escrow mode rounding dust) are sent to `proceeds_base`.
4. Everything left in the quote vault (issuer proceeds in the mint modes, the unspent dust bond and any rounding remainder in all modes) is sent to `proceeds_quote`.
5. If the supply mode mints and the base mint is bound: the mint authority is set to none if the cross printed, or back to `creator` if it did not. A deferred-mint cross that never bound a mint has no authority to hand back.
6. `state = Finalized`. Event `CrossFinalized`.

After a `finalize` that supplied the accounts above, both vaults are empty (invariant I6, `docs/security/INVARIANTS.md`; tested, not audited).


## 7. The clearing rule

This section is normative and is implemented by `crates/clearing-core` (`no_std`, integer arithmetic only, used by the program and by the generator of the conformance vectors). It restates ADR-0003 and is held to the code by the vectors in §16.

### 7.1 Inputs

A clearing takes:

- the grid `(min_price, tick, ticks)`;
- the book: for each tick, an aggregate buy quantity and an aggregate sell quantity, and the number of orders behind each (only the aggregates matter to the result; the counts are used for consistency and for the dust bound);
- the optional reference price `reference_price` (on the grid);

and returns either no clearing or a clearing `(P*, V*, …)`. Nothing depends on the order in which orders arrived, on their number beyond the aggregates, or on their size distribution except through the pro-rata rule of §7.5.

### 7.2 Definitions

For a grid price `p`:

```
D(p)  = Σ quantity of buy orders with limit ≥ p
D⁺(p) = Σ quantity of buy orders with limit >  p
S(p)  = Σ quantity of sell orders with limit ≤ p
S⁻(p) = Σ quantity of sell orders with limit <  p
V(p)  = min(D(p), S(p))
```

A price `p` is **feasible** if and only if `V(p) > 0`, `V(p) ≥ D⁺(p)` and `V(p) ≥ S⁻(p)` (every strictly better order fits inside the matched volume).

### 7.3 Choice of the clearing price

An implementation MUST return the same result as the following exhaustive procedure over every grid price `p = min_price + i · tick`, `0 ≤ i < ticks`:

1. Discard prices that are not feasible. If none is feasible the cross has no clearing (no print, reason `NoCross`).
2. Among feasible prices keep those with the greatest `V(p)`.
3. Among those keep the smallest imbalance `|D(p) − S(p)|`.
4. If a reference price is supplied, among those keep the price with the smallest `|p − reference_price|`.
5. Among those keep the lowest price.

The result is `P*`. Step 5 is the choice ADR-0003 records for its open decision VM6 (which of the equally good prices): when several prices clear the same volume with the same imbalance and the same distance from the reference, buyers pay the lowest.

The program does not evaluate every grid price. Because `D` and `S` are constant between consecutive order prices, it evaluates each order price, the reference price, and in each gap between consecutive order prices the single grid price that can win there (the grid price nearest the reference, or the lowest grid price in the gap when there is no reference). The independent TypeScript implementation (`packages/verifier/src/reference.ts`) evaluates every grid price. Both reproduce all 525 conformance vectors (§16). The exhaustive procedure above is the specification; the shortcut is an implementation detail. The result depends on the grid: a price in a gap between two order prices can clear (see E3a and E3b in §7.9).

The rule is the standard opening-auction rule (maximum volume, minimum imbalance, reference price) with a deterministic final tie-break. Truthful bidding is NOT a best response for a buyer with more than one unit of demand: a counterexample is hand-checkable (a book on which shading earns 2,900 against 500, `docs/evidence/W2A-Q2-adversarial.md`), as is usual for uniform-price auctions. For a single small order in a deep market the search found no gain, which is not a proof. Pro-rata rationing at the margin weakens it further (ADR-0003).

### 7.4 The clearing summary

At the chosen price `P*`:

| Field | Definition |
|---|---|
| `price` | `P*` |
| `matched` | `V* = V(P*)` |
| `demand`, `supply` | `D(P*)`, `S(P*)` |
| `rationed` | `none` if `D = S`; `buy` if `D > S`; `sell` if `S > D` |
| `marginal_quantity` (`Q`) | The aggregate quantity at exactly `P*` on the rationed side; `0` if none |
| `marginal_remaining` (`R`) | `V* − D⁺(P*)` if buy is rationed; `V* − S⁻(P*)` if sell is rationed; `0` if none |
| `marginal_orders` | The number of orders at exactly `P*` on the rationed side; `0` if none |

Since `V*` is at least `D⁺` and `S⁻` by feasibility, `R ≥ 0` and `R ≤ Q`.

### 7.5 Fills

The fill of a single order is a pure function of the order and the summary; no other order is needed.

```
crosses  = (side = buy  and limit ≥ P*)  or  (side = sell and limit ≤ P*)
marginal = (limit = P*) and (summary.rationed = side)

fill = 0                                   if not crosses
fill = quantity                            if crosses and not marginal
fill = floor(quantity · R / Q)             if marginal and side = buy
fill = ceil (quantity · R / Q)             if marginal and side = sell
```

`quantity · R` is computed exactly in 256 bits. The result never exceeds `quantity` (since `R ≤ Q`). If `Q = 0` the fill is the full quantity.

**Rounding and dust.** Buys round down and sells round up, so across all fills `Σ sell fills ≥ V* ≥ Σ buy fills`, and each side differs from `V*` by less than the number of its marginal orders. `max_dust = marginal_orders`. The difference `Σ sell fills − Σ buy fills` is base dust (stays in the base vault in escrow mode and is sent to `proceeds_base` by `finalize`; in the mint modes only buyers' fills are minted, so the unsold schedule is simply not minted).

**Payments.** For a fill of `f` base atoms at price `P*`:

```
buyer pays        = ceil (f · P* / price_scale)     quote atoms
seller receives   = floor(f · P* / price_scale)     quote atoms, before fees
```

Rounding always favours the vault. A buyer pays at most their limit: `limit ≥ P*` and the escrow was sized at `ceil(quantity · limit / price_scale)`.

### 7.6 Fees and the dust bond

- **Who pays.** Fees are charged on filled notional and are paid by the sell side. Buyers pay exactly `P*` for their fill. Bids, cancels and refunds are never charged.
- **Snapshot.** At `create_cross`, `integrator_fee_bps` is taken from the caller (at most 300) and `protocol_fee_bps = min(Protocol.fee_bps[kind], floor(integrator_fee_bps / 4))`. The second term makes the protocol's share of the total at most 20% (`p ≤ 0.2 · (p + i) ⇔ p ≤ i / 4`); a cross with no integrator fee pays no protocol fee and no fee at all. `fee_bps` entries are at most 100. Later changes to `Protocol` never affect an existing cross (ADR-0010).
- **Escrow mode.** At each sell `claim`: `fee = floor(gross · total_bps / 10000)` with `total_bps = protocol_fee_bps + integrator_fee_bps`. `fees_accrued` is the sum. At `finalize`: `protocol_fee = floor(fees_accrued · protocol_fee_bps / total_bps)`, `integrator_fee = fees_accrued − protocol_fee`.
- **Mint modes.** The issuer is the only seller and its sales are not claimed order by order, so at `finalize`: `fees = floor(buyer_paid · total_bps / 10000)`, split as above.
- **Dust bond.** `dust_bond = ceil(max_orders · max_price / price_scale)` where `max_price = min_price + (ticks − 1) · tick`: the cost of buying one atom per order at the highest grid price. The creator transfers it to the quote vault at creation. It covers the rounding difference between buyers' payments and sellers' receipts; the unspent part is returned to `proceeds_to` at `finalize`. Invariant I5 states that the difference is bounded by the bond; it is tested by property tests, not proven.
- **Proceeds.** Mint modes: `proceeds_quote = dust_bond + buyer_paid − fees` (escrow-mode analogue: `dust_bond + buyer_paid − seller_paid`, with fees paid out of the sellers' gross).

### 7.7 Print guards

After a price is found, `clear` refuses to print if either guard fails, evaluated in this order:

1. **Minimum volume.** `matched < min_matched` → `BelowMinimumVolume`.
2. **Maximum imbalance.** If `max_imbalance_bps` is set and `|D(P*) − S(P*)| · 10000 > max_imbalance_bps · matched` → `ImbalanceTooHigh`. The comparison is strict and uses no division: a cross exactly at the bound prints.

A guarded cross is a no print: every order is refunded. The clearing is not stored; a verifier can still recompute the price the book would have cleared at (the vectors give it as `wouldClearAt`).

### 7.8 Oracle guard

A cross created with an `OracleGuard` also refuses to print when the clearing price strays from a Pyth price. It applies only after §7.7 passes, in `clear`:

1. The `oracle_price` account MUST be supplied; otherwise `clear` fails (`OracleAccountMissing`).
2. Verdict `OracleUnavailable` (no print) if any of: the account is not owned by one of the two Pyth receiver programs (`pyth_receiver`, `pyth_receiver_upgraded` in §3.1); its data is not a `PriceUpdateV2` (discriminator `[34, 241, 35, 99, 157, 126, 244, 205]`); its feed id differs from `OracleGuard.feed_id`; its verification level is not `Full`; `now − publish_time > max_staleness_secs`; or the conversion below fails.
3. Otherwise convert the price to cross units: `reference = price · 10^(exponent + quote_decimals − base_decimals) · price_scale` (division truncates when the exponent is negative); a non-positive price is unavailable.
4. Verdict `OracleDivergence` (no print) if `|P* − reference| · 10000 > max_divergence_bps · reference`.

`PriceUpdateV2` layout read by the program: 8-byte discriminator; `write_authority` (32); `verification_level` (Borsh enum: `0` is `Partial { num_signatures: u8 }`, `1` is `Full`); then `feed_id` (32), `price` (`i64`), `conf` (`u64`), `exponent` (`i32`), `publish_time` (`i64`). The guard pins the feed id, not an account address, so a keeper posts a fresh update through the Pyth receiver and passes that account.

The verdict depends on the account passed to `clear`, which is not stored; a verifier cannot reproduce it from the book (§13). Any fully verified update for the pinned feed that is within `max_staleness_secs` of the clearing transaction is acceptable, and the caller of `clear` chooses which one.

### 7.9 Worked examples

The examples below are machine-readable. Each `case` is in the conformance format of §16. `economics` lists, for a printed example, what `claim` and `finalize` pay under the example's fee configuration. `tests/core/test/ocip-spec.test.ts` recomputes every number with the independent TypeScript implementation (`packages/verifier`), and the same cases and money were also run through `clearing-core` (`buyer_pays`, `seller_receives`, `fill`) when this section was written.

Grid prices are written as integers. In E1 the price scale is 1,000,000 base atoms (a 6-decimal token) and prices are quote atoms (6 decimals) per whole token, so `900000` is 0.90. In E2 to E5 the scale is 1 (prices are quote atoms per base atom).

```json ocip:examples
{
  "schema": "opening-cross/ocip-examples/v1",
  "examples": [
    {
      "id": "E1",
      "title": "Launch in mint mode: uniform price, buy side rationed, rounding down",
      "case": {
        "name": "E1 launch",
        "grid": { "min": "500000", "tick": "50000", "ticks": 21 },
        "reference": null,
        "guards": { "minMatched": "0", "maxImbalanceBps": null },
        "orders": [
          { "side": "sell", "price": "700000", "quantity": "300000000" },
          { "side": "sell", "price": "900000", "quantity": "300000000" },
          { "side": "sell", "price": "1100000", "quantity": "400000000" },
          { "side": "buy", "price": "1200000", "quantity": "200000000" },
          { "side": "buy", "price": "1000000", "quantity": "250000000" },
          { "side": "buy", "price": "900000", "quantity": "137000001" },
          { "side": "buy", "price": "900000", "quantity": "262999999" }
        ],
        "expect": {
          "printed": true,
          "price": "900000",
          "matched": "600000000",
          "rationed": "buy",
          "fills": ["300000000", "300000000", "0", "200000000", "250000000", "51375000", "98624999"]
        }
      },
      "economics": {
        "priceScale": "1000000",
        "kind": "Launch",
        "supplyMode": "mint",
        "protocolScheduleBps": [30, 5, 15, 30],
        "integratorFeeBps": 100,
        "protocolFeeBps": 25,
        "maxOrders": 1000,
        "dustBond": "1500",
        "orders": [
          { "side": "sell", "schedule": true },
          { "side": "sell", "schedule": true },
          { "side": "sell", "schedule": true },
          {
            "side": "buy",
            "fill": "200000000",
            "escrowQuote": "240000000",
            "pays": "180000000",
            "refundQuote": "60000000",
            "receivesBase": "200000000"
          },
          {
            "side": "buy",
            "fill": "250000000",
            "escrowQuote": "250000000",
            "pays": "225000000",
            "refundQuote": "25000000",
            "receivesBase": "250000000"
          },
          { "side": "buy", "fill": "51375000", "escrowQuote": "123300001", "pays": "46237500", "refundQuote": "77062501", "receivesBase": "51375000" },
          {
            "side": "buy",
            "fill": "98624999",
            "escrowQuote": "236700000",
            "pays": "88762500",
            "refundQuote": "147937500",
            "receivesBase": "98624999"
          }
        ],
        "totals": { "buyerPaid": "540000000", "baseBought": "599999999", "baseSold": "0", "sellerPaid": "0", "feesAccrued": "0" },
        "finalize": { "protocolFee": "1350000", "integratorFee": "5400000", "proceedsQuote": "533251500", "dustBase": "0" }
      }
    },
    {
      "id": "E2",
      "title": "Reopen in escrow mode: sell side rationed, rounding up, one atom of dust",
      "case": {
        "name": "E2 reopen",
        "grid": { "min": "90", "tick": "1", "ticks": 21 },
        "reference": "100",
        "guards": { "minMatched": "0", "maxImbalanceBps": null },
        "orders": [
          { "side": "buy", "price": "101", "quantity": "5" },
          { "side": "buy", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "99", "quantity": "4" },
          { "side": "sell", "price": "100", "quantity": "5" },
          { "side": "sell", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "100", "quantity": "11" }
        ],
        "expect": { "printed": true, "price": "100", "matched": "12", "rationed": "sell", "fills": ["5", "7", "4", "2", "3", "4"] }
      },
      "economics": {
        "priceScale": "1",
        "kind": "Reopen",
        "supplyMode": "escrow",
        "protocolScheduleBps": [30, 5, 15, 30],
        "integratorFeeBps": 100,
        "protocolFeeBps": 5,
        "maxOrders": 100,
        "dustBond": "11000",
        "orders": [
          { "side": "buy", "fill": "5", "escrowQuote": "505", "pays": "500", "refundQuote": "5", "receivesBase": "5" },
          { "side": "buy", "fill": "7", "escrowQuote": "700", "pays": "700", "refundQuote": "0", "receivesBase": "7" },
          { "side": "sell", "fill": "4", "escrowBase": "4", "grossQuote": "400", "feeQuote": "4", "receivesQuote": "396", "returnedBase": "0" },
          { "side": "sell", "fill": "2", "escrowBase": "5", "grossQuote": "200", "feeQuote": "2", "receivesQuote": "198", "returnedBase": "3" },
          { "side": "sell", "fill": "3", "escrowBase": "7", "grossQuote": "300", "feeQuote": "3", "receivesQuote": "297", "returnedBase": "4" },
          { "side": "sell", "fill": "4", "escrowBase": "11", "grossQuote": "400", "feeQuote": "4", "receivesQuote": "396", "returnedBase": "7" }
        ],
        "totals": { "buyerPaid": "1200", "baseBought": "12", "baseSold": "13", "sellerPaid": "1300", "feesAccrued": "13" },
        "finalize": { "protocolFee": "0", "integratorFee": "13", "proceedsQuote": "10900", "dustBase": "1" }
      }
    },
    {
      "id": "E3a",
      "title": "Interior grid price, no reference: lowest price of the maximum-volume range",
      "case": {
        "name": "E3a gap no reference",
        "grid": { "min": "100", "tick": "5", "ticks": 5 },
        "reference": null,
        "guards": { "minMatched": "0", "maxImbalanceBps": null },
        "orders": [{ "side": "buy", "price": "120", "quantity": "10" }, { "side": "sell", "price": "100", "quantity": "10" }],
        "expect": { "printed": true, "price": "100", "matched": "10", "rationed": "none", "fills": ["10", "10"] }
      },
      "economics": null
    },
    {
      "id": "E3b",
      "title": "Interior grid price, reference on the grid: nearest the reference wins",
      "case": {
        "name": "E3b gap reference 110",
        "grid": { "min": "100", "tick": "5", "ticks": 5 },
        "reference": "110",
        "guards": { "minMatched": "0", "maxImbalanceBps": null },
        "orders": [{ "side": "buy", "price": "120", "quantity": "10" }, { "side": "sell", "price": "100", "quantity": "10" }],
        "expect": { "printed": true, "price": "110", "matched": "10", "rationed": "none", "fills": ["10", "10"] }
      },
      "economics": null
    },
    {
      "id": "E4a",
      "title": "Minimum-volume guard: cleared at 100 with volume 12, refused because the minimum is 13",
      "case": {
        "name": "E4a min matched 13",
        "grid": { "min": "90", "tick": "1", "ticks": 21 },
        "reference": "100",
        "guards": { "minMatched": "13", "maxImbalanceBps": null },
        "orders": [
          { "side": "buy", "price": "101", "quantity": "5" },
          { "side": "buy", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "99", "quantity": "4" },
          { "side": "sell", "price": "100", "quantity": "5" },
          { "side": "sell", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "100", "quantity": "11" }
        ],
        "expect": { "printed": false, "noPrintReason": "BelowMinimumVolume", "wouldClearAt": "100" }
      },
      "economics": null
    },
    {
      "id": "E4b",
      "title": "Imbalance guard one basis point too tight",
      "case": {
        "name": "E4b imbalance 12499",
        "grid": { "min": "90", "tick": "1", "ticks": 21 },
        "reference": "100",
        "guards": { "minMatched": "0", "maxImbalanceBps": 12499 },
        "orders": [
          { "side": "buy", "price": "101", "quantity": "5" },
          { "side": "buy", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "99", "quantity": "4" },
          { "side": "sell", "price": "100", "quantity": "5" },
          { "side": "sell", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "100", "quantity": "11" }
        ],
        "expect": { "printed": false, "noPrintReason": "ImbalanceTooHigh", "wouldClearAt": "100" }
      },
      "economics": null
    },
    {
      "id": "E4c",
      "title": "Imbalance guard exactly at the bound, so the cross prints",
      "case": {
        "name": "E4c imbalance 12500",
        "grid": { "min": "90", "tick": "1", "ticks": 21 },
        "reference": "100",
        "guards": { "minMatched": "0", "maxImbalanceBps": 12500 },
        "orders": [
          { "side": "buy", "price": "101", "quantity": "5" },
          { "side": "buy", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "99", "quantity": "4" },
          { "side": "sell", "price": "100", "quantity": "5" },
          { "side": "sell", "price": "100", "quantity": "7" },
          { "side": "sell", "price": "100", "quantity": "11" }
        ],
        "expect": { "printed": true, "price": "100", "matched": "12", "rationed": "sell", "fills": ["5", "7", "4", "2", "3", "4"] }
      },
      "economics": null
    },
    {
      "id": "E5",
      "title": "A book that does not cross prints nothing",
      "case": {
        "name": "E5 bid below ask",
        "grid": { "min": "90", "tick": "1", "ticks": 21 },
        "reference": null,
        "guards": { "minMatched": "0", "maxImbalanceBps": null },
        "orders": [{ "side": "buy", "price": "95", "quantity": "10" }, { "side": "sell", "price": "105", "quantity": "10" }],
        "expect": { "printed": false, "noPrintReason": "NoCross" }
      },
      "economics": null
    }
  ]
}
```

**E1, launch in mint mode.** The issuer's schedule sells 300, 300 and 400 tokens at 0.70, 0.90 and 1.10. Buyers: 200 at 1.20, 250 at 1.00, and two orders of 137.000001 and 262.999999 at 0.90. At 0.90, `D = 850`, `S = 600`, `V = 600`, `D⁺ = 450 ≤ V` and `S⁻ = 300 ≤ V`: feasible with the greatest volume, so `P* = 0.90` and the buy side is rationed. `Q = 400` (the two orders at 0.90) and `R = 600 − 450 = 150`: the first marginal buy fills `floor(137000001 · 150000000 / 400000000) = 51,375,000` atoms and the second `floor(262999999 · 150000000 / 400000000) = 98,624,999`, one atom short of 150. Buyers pay `ceil(f · 900000 / 1000000)`: 88,762,500 for the second (a fraction rounds up). The cross mints 599,999,999 atoms. With an integrator fee of 100 bps and the example schedule entry of 30 bps for launches, the protocol fee is `min(30, floor(100 / 4)) = 25` bps; `fees = floor(540,000,000 · 125 / 10000) = 6,750,000`, of which the protocol receives `floor(6,750,000 · 25 / 125) = 1,350,000` and the integrator the rest.

**E2, reopen in escrow mode.** A reference price of 100. At 100, `D = 12`, `S = 27`, so `V = 12`; sell is rationed with `Q = 23` (5 + 7 + 11) and `R = 12 − S⁻ = 12 − 4 = 8`. Marginal sells fill `ceil(5 · 8 / 23) = 2`, `ceil(7 · 8 / 23) = 3` and `ceil(11 · 8 / 23) = 4`, a total of 9 against 8 intended, so sell fills total 13 against buy fills of 12: one atom of base dust. With `integrator_fee_bps = 100` and the reopen schedule entry of 5 bps, `protocol_fee_bps = min(5, 25) = 5`, `total_bps = 105`. Sell fees are floored per claim (4, 2, 3, 4 = 13). The protocol's share `floor(13 · 5 / 105)` is zero: the integrator receives all 13. The dust bond for 100 orders at the maximum price 110 is 11,000.

**E3a and E3b.** One buy at 120 and one sell at 100 on a grid of 5. Every grid price from 100 to 120 clears the same volume with zero imbalance. Without a reference the lowest, 100, wins. With a reference of 110 the price 110, which no order names, wins.

**E4a to E4c.** The E2 book: the volume guard at 13 refuses it (volume 12). With `|D − S| = 15`, the imbalance guard refuses it at 12,499 bps (`150000 > 12499 · 12 = 149988`) and lets it print at 12,500 (`150000 = 150000`, not greater).

**E5.** A bid below the ask does not cross: no print, reason `NoCross`.

The price and fee schedule values used above (30, 5, 15 and 30 bps for launch, reopen, tender and recurring) are the values proposed in `docs/FEATURE_STATUS.md` and set on the devnet protocol account; they are configuration, not part of the rule.

## 8. Disclosure modes

`Cross.disclosure` is `Sealed` or `Open`, fixed at creation.

### 8.1 Open

Orders are public from the moment they are placed. `commit_order` takes the plaintext price and quantity, validates them (§6.3), and adds them to the order's shard immediately; the order is created `Revealed`. `reveal_end_ts = close_ts`; there is no reveal window and `reveal_order` fails with `NotSealed`. Orders may be cancelled until `close_ts`. The aggregated book is readable per tick from the shard accounts while the call is open (and, for the mint modes, the issuer's schedule from the book account).

### 8.2 Sealed: commit-reveal

A sealed order is placed as a hash and later opened.

**Commitment.** `commitment = SHA-256(preimage)` where the preimage is the 121-byte concatenation:

| Bytes | Field | Encoding |
|---|---|---|
| 0..32 | `cross` | the cross account address |
| 32..64 | `owner` | the order owner's address |
| 64..72 | `nonce` | `u64`, little-endian |
| 72 | `side` | one byte: `0` buy, `1` sell |
| 73..81 | `price` | `u64`, little-endian |
| 81..89 | `quantity` | `u64`, little-endian |
| 89..121 | `salt` | 32 bytes |

This is `commitment_of` in `programs/cross_core/src/lib.rs`, mirrored by `orderCommitment` in `packages/sdk`.

**Phases.**

1. *Commit* (call window). `commit_order` stores the commitment; `escrow` is only required to be positive. The side and the escrow amount are public. The price and quantity are not.
2. *Cancel* (call window). The owner may cancel and take a full refund.
3. *Reveal* (`close_ts ≤ now < reveal_end_ts`). The owner calls `reveal_order(price, quantity, salt)`. The program recomputes the commitment, validates the order against the stored `escrow` as in an open cross, and adds it to the shard. `OrderRevealed` publishes the price and quantity.
4. *No reveal.* An order that is not revealed in the window is never added to a shard and is excluded from the clearing. At `claim` it is refunded in full whatever the cross's outcome.

The salt SHOULD be 32 random bytes generated by the client and stored by it before the commit transaction is sent; a lost salt means the order cannot be revealed and is refunded.

**Properties** that follow from the code (see §17 for the consequences): revealing is optional and not revealing is free; each reveal is public as soon as it lands; a reveal can only be made by the order's owner (the instruction needs the owner's signature).

Encrypted or threshold-decrypted reveal, and a keeper-performed default reveal, are not specified (§1.2).

### 8.3 Order entry rules for integrators

An integrator placing an order MUST: choose a `nonce` unique for the `(cross, owner)` pair (the PDA must not exist); compute the order PDA and its bump; fund an `escrow` of at least `ceil(quantity · price / price_scale)` quote atoms (buy) or `quantity` base atoms (sell); supply the shard that §8.4 selects (open crosses); and supply the owner's `pass` when the cross has a `gate_mint`.

### 8.4 Shard assignment

An order writes to shard

```
shard(owner, nonce, shards) = u32_le(SHA-256(owner ‖ nonce_le8)[0..4]) mod shards
```

where `owner` is the 32 address bytes and `nonce_le8` is the `u64` nonce, little-endian. It depends only on values the owner knows when composing the transaction, so concurrent bidders never race for a shard. (An earlier design used `orders_total mod shards`; a devnet run with ten bids in flight failed 39 of 40 with `WrongShard`, ADR-0005.) `cancel_order` and `reveal_order` recompute the shard from the stored owner and nonce.

```json ocip:hashes
{
  "commit": {
    "cross": "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
    "owner": "3ELeRTTg5W5hAYaEFznzFV1jknNFkjHqS8ytwvQEQP1Z",
    "nonce": "7",
    "side": "sell",
    "price": "1000000",
    "quantity": "250000000",
    "saltHex": "6162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80",
    "crossHex": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    "ownerHex": "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40",
    "commitmentHex": "a28be59572e807cd63da4d623c031b6bf3bc2b0b96d241ed02f77d49be5cdeb8"
  },
  "shard": [
    { "owner": "3ELeRTTg5W5hAYaEFznzFV1jknNFkjHqS8ytwvQEQP1Z", "nonce": "1", "shards": 8, "index": 7 },
    { "owner": "3ELeRTTg5W5hAYaEFznzFV1jknNFkjHqS8ytwvQEQP1Z", "nonce": "2", "shards": 8, "index": 1 },
    { "owner": "3ELeRTTg5W5hAYaEFznzFV1jknNFkjHqS8ytwvQEQP1Z", "nonce": "3", "shards": 8, "index": 4 },
    { "owner": "3ELeRTTg5W5hAYaEFznzFV1jknNFkjHqS8ytwvQEQP1Z", "nonce": "10", "shards": 8, "index": 0 },
    { "owner": "3ELeRTTg5W5hAYaEFznzFV1jknNFkjHqS8ytwvQEQP1Z", "nonce": "32", "shards": 32, "index": 29 }
  ],
  "leaf": {
    "mint": "5Pk716N113awdSaUDZEPZVi9Zs6hJmG5KCJtp5qQK3LB",
    "owner": "3ELeRTTg5W5hAYaEFznzFV1jknNFkjHqS8ytwvQEQP1Z",
    "mintHex": "4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60",
    "ownerHex": "2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40",
    "leafHex": "20e256892acf6abafcd9c1d80bed0b5d79f36f6099fbb663c6ae01a0939761fa"
  }
}
```

`commit.commitmentHex` is `orderCommitment` of the listed inputs (`crossHex` and `ownerHex` are the raw address bytes). Each `shard` entry gives the index for the owner, nonce and shard count. `leaf` is the gate allowlist leaf of §10.4.

## 9. Settlement adapters (`cross_settle`)

### 9.1 The contract between `cross_core` and an adapter

`cross_core` knows nothing about any market. It holds escrow and prices; an adapter turns a cleared cross into a market at `P*`. Two adapter shapes exist.

**Deferred-mint adapter.** A launch whose base token does not exist at the time of the call.

1. `create_cross` with `supply_mode = DeferredMint`, no base mint and no base vault, `settler` set to the adapter's authority, and `settle_deadline_ts > reveal_end_ts`.
2. The cross clears. While `base_bound = false`, `claim` fails with `SettlementPending` and refunds are not available through `claim` either (the instruction requires a bound mint in `Cleared`).
3. The adapter creates the base mint with the cross PDA as mint authority and calls `bind_base_mint`, signing as `settler`.
4. If the mint has not been bound, anyone may call `abandon_settlement` at or after `settle_deadline_ts`; the cross becomes `NoPrint` (`SettlementExpired`) and every order refunds. `bind_base_mint` fails with `SettlementDeadlinePassed` at or after the same instant, so the deadline splits time exactly: before it only a bind can end the wait, from it on only `abandon_settlement` can, and the outcome never depends on which transaction lands first.

**Post-bind adapter.** Opens a market for an already-bound base mint at `P*` (DAMM v2, DLMM, Raydium CPMM). It is not a precondition of anything in `cross_core`.

An adapter MUST read the `Cross` account from the `cross_core` program (owner check) and MUST derive its start price from `clearing.price` and `price_scale`, never from a caller-supplied value; it MUST reject a start price that does not match `P*` as stated below.

### 9.2 `open_dbc_pool`

Step one of the Meteora Dynamic Bonding Curve continuation (ADR-0006): creates the DBC config and pool whose start price is `P*`. The signer MUST be the cross creator.

<!-- ocip:ix cross_settle open_dbc_pool -->
Discriminator `440e79b574c1e1b2`. Arguments: `config_parameters: ConfigParameters`, `pool: InitializePoolParameters`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `settler` | – | PDA ["settler", cross] |
| 4 | `dbc_config` | W | PDA ["dbc_config", cross] |
| 5 | `base_mint` | W | PDA ["base_mint", cross] |
| 6 | `quote_mint` | – |  |
| 7 | `leftover_receiver` | – |  |
| 8 | `pool` | W |  |
| 9 | `base_vault` | W |  |
| 10 | `quote_vault` | W |  |
| 11 | `dbc_pool_authority` | – |  |
| 12 | `dbc_event_authority` | – |  |
| 13 | `dbc_program` | – | address `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| 14 | `cross_gate_program` | – | address `2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr` |
| 15 | `quote_token_program` | – |  |
| 16 | `token_2022_program` | – | address `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 17 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

Preconditions: `cross` is owned by `cross_core` (`WrongCross`); `creator` equals `cross.creator` (`NotCreator`); `base_bound` is false (`AlreadyBound`); `cross.settler` equals this adapter's settler PDA for the cross (`WrongSettler`); `quote_mint` equals the cross's quote mint (`WrongMint`); the cross has a clearing summary (`NotCleared`); `config_parameters.token_type = 1` (Token-2022) and `config_parameters.token_update_authority = 4` (`PartnerUpdateAndMintAuthority`) (`BadConfig`); and

```
|config_parameters.sqrt_start_price − floor( sqrt(P* · 2^128 / price_scale) )| ≤ 1        (StartPriceNotClearingPrice)
```

The right-hand value is a Q64.64 square-root price, `sqrt_price_q64`, computed with 256-bit integer arithmetic and a floor integer square root. It then calls DBC `create_config_with_transfer_hook` (config PDA signs, `fee_claimer` is the settler PDA, `transfer_hook_program` is `cross_gate`) and `initialize_virtual_pool_with_token2022_transfer_hook` (base-mint PDA signs). DBC creates the base mint and gives its mint authority to the settler PDA. Event `DbcPoolOpened`. The issuer chooses the curve shape, fees and liquidity split in `config_parameters`; the start price is not the issuer's choice.

### 9.3 `bind_dbc_mint`

Step two. Permissionless once step one has run; the payer funds rent.

<!-- ocip:ix cross_settle bind_dbc_mint -->
Discriminator `5c4c468431421010`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `cross` | W |  |
| 3 | `settler` | – | PDA ["settler", cross] |
| 4 | `base_mint` | W | PDA ["base_mint", cross] |
| 5 | `gate_config` | W |  |
| 6 | `gate_extra_metas` | W |  |
| 7 | `cross_gate_program` | – | address `2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr` |
| 8 | `cross_core_program` | – | address `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ` |
| 9 | `token_2022_program` | – |  |
| 10 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

Preconditions: `base_bound` is false (`AlreadyBound`); `cross.settler` equals the settler PDA (`WrongSettler`); the base mint's mint authority is the settler PDA (`PoolNotOpened`). Effects, as CPIs signed by the settler PDA: `cross_gate::create_config` for the mint in `Open` mode; `cross_gate::init_hook_metas`; `cross_gate::set_authority` to the cross creator; the mint authority of the base mint is set to the cross PDA; `cross_core::bind_base_mint`. Event `DbcMintBound`. Claims then mint each buyer's fill at `P*` and `finalize` revokes the mint authority.

### 9.4 `seed_damm_v2`, `open_dlmm_pair`, `seed_raydium_cpmm`

These three open a market for an already-bound base mint. Their account lists are the target program's own plus the cross; they are in the IDL (`packages/cross-settle-client/idl/cross_settle.json`) and the target program's interface is `idls/cp_amm.json`, `idls/lb_clmm.json` and `idls/raydium_cp_swap.json` respectively. The accounts are:

<!-- ocip:ix cross_settle seed_damm_v2 -->
`seed_damm_v2`, discriminator `0a846137cc3c4955`. Arguments: `params: InitializeCustomizablePoolParameters`. Accounts in order: `creator` (WS), `cross`, `position_nft_mint` (W), `position_nft_account` (W), `pool` (W), `position` (W), `base_mint`, `quote_mint`, `token_a_vault` (W), `token_b_vault` (W), `creator_base` (W), `creator_quote` (W), `damm_pool_authority`, `damm_event_authority`, `damm_program`, `base_token_program`, `quote_token_program`, `token_2022_program`, `system_program`.
<!-- /ocip:ix -->

<!-- ocip:ix cross_settle open_dlmm_pair -->
`open_dlmm_pair`, discriminator `a6c2b662acb01d14`. Arguments: `params: CustomizableParams`. Accounts in order: `creator` (WS), `cross`, `lb_pair` (W), `base_mint`, `quote_mint`, `reserve_x` (W), `reserve_y` (W), `oracle` (W), `creator_base`, `creator_quote`, `dlmm_event_authority`, `dlmm_program`, `base_token_program`, `quote_token_program`, `system_program`.
<!-- /ocip:ix -->

<!-- ocip:ix cross_settle seed_raydium_cpmm -->
`seed_raydium_cpmm`, discriminator `f9bcc67f97d40e68`. Arguments: `base_amount: u64`, `quote_amount: u64`, `open_time: u64`. Accounts in order: `creator` (WS), `cross`, `amm_config`, `raydium_authority`, `pool_state` (W), `token_0_mint`, `token_1_mint`, `lp_mint` (W), `creator_token_0` (W), `creator_token_1` (W), `creator_lp_token` (W), `token_0_vault` (W), `token_1_vault` (W), `create_pool_fee` (W), `observation_state` (W), `raydium_program`, `spl_token_program`, `token_0_program`, `token_1_program`, `associated_token_program`, `system_program`, `rent`.
<!-- /ocip:ix -->

Common preconditions for all three: `cross` owned by `cross_core` (`WrongCross`); `creator` equals `cross.creator` (`NotCreator`); `base_bound` is true (`PoolNotOpened`); the cross has a clearing summary (`NotCleared`); the mints passed equal the cross's mints (`WrongMint`).

| Instruction | Start-price check (`StartPriceNotClearingPrice`) | Market |
|---|---|---|
| `seed_damm_v2(params)` | `abs(params.sqrt_price − sqrt_price_q64(P*, price_scale)) ≤ 1` | DAMM v2 customizable pool; token A is the base, token B the quote; the position NFT mint is the PDA `["damm_position", cross]`; the issuer supplies `params.liquidity` from its own accounts |
| `open_dlmm_pair(params)` | `bin_contains(params.active_id, params.bin_step, P*, price_scale)` | DLMM pair; token X is the base, token Y the quote; liquidity is added afterwards with DLMM's own instructions |
| `seed_raydium_cpmm(base_amount, quote_amount, open_time)` | `deposit_matches_price(base_amount, quote_amount, P*, price_scale)` | Raydium CPMM pool; the mints are ordered by key, so the base may be token 0 or token 1 |

`bin_contains(id, bin_step, P*, scale)`: with `bin(id) = (1 + bin_step / 10^4)^id` in Q64.64, computed by exact integer exponentiation (truncating right shift by 64 after each product; the computation fails if an intermediate exceeds 192 bits; for a negative `id` the result is `2^128 / bin(|id|)`, truncated), and `p = floor(P* · 2^64 / scale)`, true if and only if `bin(id) · (20000 − bin_step) / 20000 ≤ p ≤ bin(id) · (20000 + bin_step) / 20000`: P* lies within half a bin step of the bin's price.

`deposit_matches_price(base, quote, P*, scale)`: with `exact = base · P*`, `floor = ⌊exact / scale⌋` and `ceil = ⌈exact / scale⌉`, true if and only if `floor ≤ quote ≤ ceil`. It is undefined (an `Overflow` error) when `scale = 0` or `base = 0`.

Events: `DammV2Seeded`, `DlmmPairOpened`, `RaydiumCpmmSeeded`. Errors: §12.2. The adapters guarantee only that the market opens at the price the cross discovered; they do not guarantee later depth or that the target program accepts the mint (for example, DAMM v2 rejects mints with Default Account State unless Meteora has issued a token badge, ADR-0004).

```json ocip:settle-vectors
{
  "sqrtPriceQ64": [
    { "price": "1", "priceScale": "1", "sqrtPriceQ64": "18446744073709551616" },
    { "price": "4", "priceScale": "1", "sqrtPriceQ64": "36893488147419103232" },
    { "price": "1200000", "priceScale": "1000000", "sqrtPriceQ64": "20207395683390924192" }
  ],
  "depositMatchesPrice": [
    { "baseAmount": "3", "quoteAmount": "8", "price": "10", "priceScale": "4", "matches": true },
    { "baseAmount": "3", "quoteAmount": "7", "price": "10", "priceScale": "4", "matches": true },
    { "baseAmount": "3", "quoteAmount": "9", "price": "10", "priceScale": "4", "matches": false },
    { "baseAmount": "1000000", "quoteAmount": "1200000", "price": "1200000", "priceScale": "1000000", "matches": true },
    { "baseAmount": "1000000", "quoteAmount": "1200001", "price": "1200000", "priceScale": "1000000", "matches": false }
  ]
}
```

`sqrt_price_q64(price, scale) = floor(sqrt(floor(price · 2^128 / scale)))`. When this section was written the three `sqrtPriceQ64` values and the five `depositMatchesPrice` results were also produced by the program's own `sqrt_price_q64` and `deposit_matches_price` functions, compiled from `programs/cross_settle/src/lib.rs` unchanged.

### 9.5 Adapters and instructions added by revision 2

Every other instruction of `cross_settle`, with its accounts and arguments. The adapters' behaviour is described in ADR-0006 to ADR-0010, ADR-0021 to ADR-0024 and ADR-0480 onwards; each checks that the cross is `Cleared` at the price it opens a market at, that the signer is the creator or the documented authority, and that the mints are the cross's.

<!-- ocip-gen:ix-cross_settle -->
#### `claim_partner_fee`

Claims the DBC partner's trading fees (the settler PDA is the partner) to an account owned by the cross's protocol fee recipient. Permissionless: nobody chooses the destination (ADR-0480).

<!-- ocip:ix cross_settle claim_partner_fee -->
Discriminator `61ce27695e5e7e94`. Arguments: `max_base: u64`, `max_quote: u64`, `hook: TransferHookAccountsInfo`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `settler` | – | PDA ["settler", cross] |
| 3 | `dbc_pool_authority` | – |  |
| 4 | `dbc_config` | – | PDA ["dbc_config", cross] |
| 5 | `pool` | W |  |
| 6 | `base_destination` | W |  |
| 7 | `quote_destination` | W |  |
| 8 | `base_vault` | W |  |
| 9 | `quote_vault` | W |  |
| 10 | `base_mint` | – |  |
| 11 | `quote_mint` | – |  |
| 12 | `dbc_event_authority` | – |  |
| 13 | `dbc_program` | – | address `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| 14 | `base_token_program` | – |  |
| 15 | `quote_token_program` | – |  |
<!-- /ocip:ix -->

#### `claim_partner_pool_creation_fee`

Claims the pool-creation fee the partner is owed, in lamports, to the fee recipient's wallet.

<!-- ocip:ix cross_settle claim_partner_pool_creation_fee -->
Discriminator `faee1a048b0a65f8`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `settler` | – | PDA ["settler", cross] |
| 3 | `dbc_config` | – | PDA ["dbc_config", cross] |
| 4 | `pool` | W |  |
| 5 | `fee_receiver` | W |  |
| 6 | `dbc_event_authority` | – |  |
| 7 | `dbc_program` | – | address `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
<!-- /ocip:ix -->

#### `claim_pol_fees`

Claims the fees of the protocol-owned DAMM v2 position a DBC migration leaves with the settler, to accounts owned by the cross's `proceeds_to` (ADR-0482).

<!-- ocip:ix cross_settle claim_pol_fees -->
Discriminator `7faa7893edb79ff6`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `settler` | – | PDA ["settler", cross] |
| 3 | `damm_pool_authority` | – |  |
| 4 | `pool` | – |  |
| 5 | `position` | W |  |
| 6 | `token_a_destination` | W |  |
| 7 | `token_b_destination` | W |  |
| 8 | `token_a_vault` | W |  |
| 9 | `token_b_vault` | W |  |
| 10 | `token_a_mint` | – |  |
| 11 | `token_b_mint` | – |  |
| 12 | `position_nft_account` | – |  |
| 13 | `damm_event_authority` | – |  |
| 14 | `damm_program` | – | address `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| 15 | `token_a_program` | – |  |
| 16 | `token_b_program` | – |  |
<!-- /ocip:ix -->

#### `create_greenshoe`

Commits a budget (at least 10% of what the cross raised) to standing bids under P* for a week (ADR-0487).

<!-- ocip:ix cross_settle create_greenshoe -->
Discriminator `790ab1f3b0c3a708`. Arguments: `budget: u64`, `start_ts: i64`, `period_secs: i64`, `period_cap: u64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `greenshoe` | W | PDA ["greenshoe", cross] |
| 4 | `vault` | W | PDA ["greenshoe_vault", greenshoe] |
| 5 | `base_account` | W | PDA ["greenshoe_base", greenshoe] |
| 6 | `base_mint` | – |  |
| 7 | `quote_mint` | – |  |
| 8 | `creator_quote` | W |  |
| 9 | `lb_pair` | – |  |
| 10 | `base_token_program` | – |  |
| 11 | `quote_token_program` | – |  |
| 12 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `deploy_greenshoe_bid`

Places one level of the greenshoe as a DLMM limit order owned by the program. Permissionless.

<!-- ocip:ix cross_settle deploy_greenshoe_bid -->
Discriminator `1666e52b2a274335`. Arguments: `level: u8`, `bin_id: i32`, `amount: u64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `greenshoe` | W | PDA ["greenshoe", greenshoe.cross] |
| 3 | `vault` | W | PDA ["greenshoe_vault", greenshoe] |
| 4 | `lb_pair` | W |  |
| 5 | `bin_array_bitmap_extension` | WO |  |
| 6 | `reserve_y` | W |  |
| 7 | `quote_mint` | – |  |
| 8 | `limit_order` | WS |  |
| 9 | `dlmm_event_authority` | – |  |
| 10 | `dlmm_program` | – | address `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| 11 | `quote_token_program` | – |  |
| 12 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `finish_greenshoe`

Burns everything the bids bought and returns the unspent budget to the issuer's proceeds. Permissionless.

<!-- ocip:ix cross_settle finish_greenshoe -->
Discriminator `ed749332903fdcf5`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `greenshoe` | W | PDA ["greenshoe", cross] |
| 3 | `vault` | W | PDA ["greenshoe_vault", greenshoe] |
| 4 | `base_account` | W | PDA ["greenshoe_base", greenshoe] |
| 5 | `base_mint` | W |  |
| 6 | `quote_mint` | – |  |
| 7 | `proceeds_quote` | W |  |
| 8 | `base_token_program` | – |  |
| 9 | `quote_token_program` | – |  |
<!-- /ocip:ix -->

#### `open_dbc_pool_locked`

`open_dbc_pool` for the fair-launch design (ADR-0482): the same curve, but the program refuses a config under which anyone could withdraw the opening liquidity, or whose migrated pool is not compounding. Everything `open_dbc_pool` checks is checked here too. `args` is the Borsh encoding of `open_dbc_pool`'s two arguments, `config_parameters` then `pool`, one after the other, so `open_dbc_pool`'s own argument types stay what they were.

<!-- ocip:ix cross_settle open_dbc_pool_locked -->
Discriminator `c2efeac9304df95f`. Arguments: `args: bytes`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `settler` | – | PDA ["settler", cross] |
| 4 | `dbc_config` | W | PDA ["dbc_config", cross] |
| 5 | `base_mint` | W | PDA ["base_mint", cross] |
| 6 | `quote_mint` | – |  |
| 7 | `leftover_receiver` | – |  |
| 8 | `pool` | W |  |
| 9 | `base_vault` | W |  |
| 10 | `quote_vault` | W |  |
| 11 | `dbc_pool_authority` | – |  |
| 12 | `dbc_event_authority` | – |  |
| 13 | `dbc_program` | – | address `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| 14 | `cross_gate_program` | – | address `2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr` |
| 15 | `quote_token_program` | – |  |
| 16 | `token_2022_program` | – | address `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 17 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `open_dlmm_pair_badged`

`open_dlmm_pair` for a pair whose mints need a Meteora Token Badge (ADR-0485): tokenized stocks carry Token-2022 extensions (a pausable mint, a permanent delegate) that DLMM refuses without a badge. The two badge accounts follow the usual accounts, in order base then quote, each either the mint's `TokenBadge` PDA or the DLMM program id when that mint needs none. A batch window of zero opens the pair at once; any other window applies the rules of `open_dlmm_pair_batched`. `params` is the Borsh encoding of `open_dlmm_pair`'s argument.

<!-- ocip:ix cross_settle open_dlmm_pair_badged -->
Discriminator `834af8a9ba4f1d29`. Arguments: `params: bytes`, `window_secs: i64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `lb_pair` | W |  |
| 4 | `base_mint` | – |  |
| 5 | `quote_mint` | – |  |
| 6 | `reserve_x` | W |  |
| 7 | `reserve_y` | W |  |
| 8 | `oracle` | W |  |
| 9 | `creator_base` | – |  |
| 10 | `creator_quote` | – |  |
| 11 | `dlmm_event_authority` | – |  |
| 12 | `dlmm_program` | – | address `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| 13 | `base_token_program` | – |  |
| 14 | `quote_token_program` | – |  |
| 15 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `open_dlmm_pair_batched`

`open_dlmm_pair` for a batch-opened market (ADR-0483): the pair is created with a timestamp start at least `window_secs` away, so it cannot trade until the crosses of the window have run (or, with `has_alpha_vault`, only an Alpha Vault can buy before then), and the pair's creator can pause it. `params` is the Borsh encoding of `open_dlmm_pair`'s argument.

<!-- ocip:ix cross_settle open_dlmm_pair_batched -->
Discriminator `7f59563ad0861265`. Arguments: `params: bytes`, `window_secs: i64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `lb_pair` | W |  |
| 4 | `base_mint` | – |  |
| 5 | `quote_mint` | – |  |
| 6 | `reserve_x` | W |  |
| 7 | `reserve_y` | W |  |
| 8 | `oracle` | W |  |
| 9 | `creator_base` | – |  |
| 10 | `creator_quote` | – |  |
| 11 | `dlmm_event_authority` | – |  |
| 12 | `dlmm_program` | – | address `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| 13 | `base_token_program` | – |  |
| 14 | `quote_token_program` | – |  |
| 15 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `open_fixed_price_presale`

Opens a Meteora Presale Vault in fixed-price mode at exactly P* (ADR-0663): a second tranche for everyone who did not bid in the call, at the price the call discovered. `args` is the Borsh encoding of the presale's `InitializePresaleArgs`; `q_price` must be `floor(P* * 2^64 / price_scale)`. Remaining accounts are the base token's transfer-hook accounts, described by `hook`, the Borsh encoding of the presale's `RemainingAccountsInfo`.

<!-- ocip:ix cross_settle open_fixed_price_presale -->
Discriminator `34611f0884997c69`. Arguments: `args: bytes`, `q_price: u128`, `disable_withdraw: u8`, `hook: bytes`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `base` | S |  |
| 4 | `presale_mint` | – |  |
| 5 | `quote_token_mint` | – |  |
| 6 | `presale` | W |  |
| 7 | `fixed_price_presale_params` | W |  |
| 8 | `presale_authority` | – |  |
| 9 | `presale_vault` | W |  |
| 10 | `quote_token_vault` | W |  |
| 11 | `payer_presale_token` | W |  |
| 12 | `base_token_program` | – |  |
| 13 | `quote_token_program` | – |  |
| 14 | `system_program` | – | address `11111111111111111111111111111111` |
| 15 | `event_authority` | – |  |
| 16 | `presale_program` | – | address `presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj` |
<!-- /ocip:ix -->

#### `seed_damm_v2_batched`

`seed_damm_v2` for a batch-opened market (ADR-0483): the pool refuses every swap until a start the program checks is at least `window_secs` away, its fee decays from a higher opening fee, and its fees compound back into the pool. During the window the market clears as a series of short crosses instead of trading against the AMM; afterwards the pool opens at the price the last cross printed. `params` is the Borsh encoding of `seed_damm_v2`'s argument.

<!-- ocip:ix cross_settle seed_damm_v2_batched -->
Discriminator `b45c59900119f2e8`. Arguments: `params: bytes`, `window_secs: i64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `position_nft_mint` | W | PDA ["damm_position", cross] |
| 4 | `position_nft_account` | W |  |
| 5 | `pool` | W |  |
| 6 | `position` | W |  |
| 7 | `base_mint` | – |  |
| 8 | `quote_mint` | – |  |
| 9 | `token_a_vault` | W |  |
| 10 | `token_b_vault` | W |  |
| 11 | `creator_base` | W |  |
| 12 | `creator_quote` | W |  |
| 13 | `damm_pool_authority` | – |  |
| 14 | `damm_event_authority` | – |  |
| 15 | `damm_program` | – | address `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| 16 | `base_token_program` | – |  |
| 17 | `quote_token_program` | – |  |
| 18 | `token_2022_program` | – | address `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| 19 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `seed_futarchy_dao`

MetaDAO adapter (ADR-0657): opens a MetaDAO futarchy DAO whose spot pool starts at P* and puts the creator's liquidity into it at that price. `params` is the Borsh encoding of MetaDAO's `InitializeDaoParams`; its first field, `twap_initial_observation`, must be P* in MetaDAO's fixed point. Only for crosses whose tokens are legacy SPL tokens.

<!-- ocip:ix cross_settle seed_futarchy_dao -->
Discriminator `bacf1a1f7a34ca06`. Arguments: `params: bytes`, `base_amount: u64`, `quote_amount: u64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | – |  |
| 3 | `dao` | W |  |
| 4 | `base_mint` | – |  |
| 5 | `quote_mint` | – |  |
| 6 | `squads_multisig` | W |  |
| 7 | `squads_multisig_vault` | – |  |
| 8 | `squads_program` | – |  |
| 9 | `squads_program_config` | – |  |
| 10 | `squads_program_config_treasury` | W |  |
| 11 | `spending_limit` | W |  |
| 12 | `amm_base_vault` | W |  |
| 13 | `amm_quote_vault` | W |  |
| 14 | `creator_base` | W |  |
| 15 | `creator_quote` | W |  |
| 16 | `amm_position` | W |  |
| 17 | `event_authority` | – |  |
| 18 | `futarchy_program` | – | address `FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq` |
| 19 | `token_program` | – | address `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| 20 | `associated_token_program` | – |  |
| 21 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `settle_greenshoe_level`

After the week: cancels a placed level, taking back the unspent quote and the base it bought. Permissionless.

<!-- ocip:ix cross_settle settle_greenshoe_level -->
Discriminator `61e14a2e76ff1701`. Arguments: `level: u8`, `hook: RemainingAccountsInfo`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `rent_receiver` | W |  |
| 2 | `greenshoe` | W | PDA ["greenshoe", greenshoe.cross] |
| 3 | `vault` | W | PDA ["greenshoe_vault", greenshoe] |
| 4 | `base_account` | W | PDA ["greenshoe_base", greenshoe] |
| 5 | `lb_pair` | W |  |
| 6 | `bin_array_bitmap_extension` | WO |  |
| 7 | `reserve_x` | W |  |
| 8 | `reserve_y` | W |  |
| 9 | `base_mint` | – |  |
| 10 | `quote_mint` | – |  |
| 11 | `limit_order` | W |  |
| 12 | `memo_program` | – |  |
| 13 | `dlmm_event_authority` | – |  |
| 14 | `dlmm_program` | – | address `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| 15 | `base_token_program` | – |  |
| 16 | `quote_token_program` | – |  |
<!-- /ocip:ix -->

#### `withdraw_partner_migration_fee`

Withdraws the partner's slice of the DBC migration fee to an account owned by the fee recipient.

<!-- ocip:ix cross_settle withdraw_partner_migration_fee -->
Discriminator `e799311760c1c129`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `settler` | – | PDA ["settler", cross] |
| 3 | `dbc_pool_authority` | – |  |
| 4 | `dbc_config` | – | PDA ["dbc_config", cross] |
| 5 | `pool` | W |  |
| 6 | `destination` | W |  |
| 7 | `quote_vault` | W |  |
| 8 | `quote_mint` | – |  |
| 9 | `dbc_event_authority` | – |  |
| 10 | `dbc_program` | – | address `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| 11 | `quote_token_program` | – |  |
<!-- /ocip:ix -->

#### `withdraw_partner_surplus`

Withdraws the partner's share of the surplus quote above the migration threshold to an account owned by the cross's `proceeds_to` (the issuer's capital, ADR-0481).

<!-- ocip:ix cross_settle withdraw_partner_surplus -->
Discriminator `20d5762ec37a0dc9`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `settler` | – | PDA ["settler", cross] |
| 3 | `dbc_pool_authority` | – |  |
| 4 | `dbc_config` | – | PDA ["dbc_config", cross] |
| 5 | `pool` | W |  |
| 6 | `destination` | W |  |
| 7 | `quote_vault` | W |  |
| 8 | `quote_mint` | – |  |
| 9 | `dbc_event_authority` | – |  |
| 10 | `dbc_program` | – | address `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| 11 | `quote_token_program` | – |  |
<!-- /ocip:ix -->
<!-- /ocip-gen:ix-cross_settle -->

## 10. The gate (`cross_gate`)

`cross_gate` keeps one set of passes and locks for a mint and enforces them in two ways: as the Token-2022 transfer hook of the mint (`execute`), and as the Token ACL gate for mints that start every account frozen (`can_thaw_permissionless`, `can_freeze_permissionless`; sRFC-37). `cross_core` uses it for one purpose only: the order-entry check of §10.5.

### 10.1 Accounts

<!-- ocip:account GateConfig -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `mint` | `Pubkey` | 32 | 8 |
| 2 | `authority` | `Pubkey` | 32 | 40 |
| 3 | `mode` | `Mode` | 1 | 72 |
| 4 | `bump` | `u8` | 1 | 73 |
| 5 | `sas` | `Option<SasRequirement>` | 65 | 74 |
| 6 | `allowlist_root` | `Option<[u8; 32]>` | 33 | 139 |
<!-- /ocip:account -->

<!-- ocip:account Pass -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `mint` | `Pubkey` | 32 | 8 |
| 2 | `owner` | `Pubkey` | 32 | 40 |
| 3 | `bump` | `u8` | 1 | 72 |
<!-- /ocip:account -->

<!-- ocip:account Lock -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `mint` | `Pubkey` | 32 | 8 |
| 2 | `owner` | `Pubkey` | 32 | 40 |
| 3 | `amount` | `u64` | 8 | 72 |
| 4 | `unlock_ts` | `i64` | 8 | 80 |
| 5 | `bump` | `u8` | 1 | 88 |
<!-- /ocip:account -->

`GateConfig` is at `["config", mint]` and is created by the mint authority; `authority` is whoever it names, normally a program PDA. Modes: `Open` lets every wallet hold the token; `Allowlist` allows only wallets that hold a `Pass`. `sas` and `allowlist_root` configure self-service passes.

### 10.2 Enforcement

- **Transfer hook** (`execute`, SPL transfer-hook discriminator). Fails unless both token accounts carry the Token-2022 `transferring` flag (`NotTransferring`). In `Allowlist` mode the destination token account's owner MUST hold a pass for the mint (`RecipientNotAllowed`). If the source owner has an active lock, the source balance after the transfer MUST be at least the locked amount until `unlock_ts` (`Locked`). The hook's extra accounts are the gate config, the destination owner's pass and the source owner's lock.
- **Token ACL thaw** (`can_thaw_permissionless`): succeeds if the mode is `Open` or the owner holds a pass (`RecipientNotAllowed` otherwise).
- **Token ACL freeze** (`can_freeze_permissionless`): succeeds only if the mode is `Allowlist` and the owner holds no pass (`OwnerAllowed` otherwise).
- Both Token ACL checks require a `flag` account owned by the Token ACL program holding the single byte `1`, and a meta list that is this mint's thaw or freeze list (`NotCalledByTokenAcl`, `WrongMetaList`). The discriminators are `[8, 175, 169, 129, 137, 74, 61, 241]` (thaw) and `[214, 141, 109, 75, 248, 1, 45, 29]` (freeze).

A pass counts only if the account is owned by `cross_gate`, is non-empty, and records the same mint and owner.

### 10.3 Instructions

| Instruction | Signer | Effect and conditions |
|---|---|---|
| `create_config(authority, mode)` | mint authority, payer | Creates the config for a Token-2022 mint; the signer must be the mint authority (`NotMintAuthority`). `sas` and `allowlist_root` start empty. Event `ConfigCreated` |
| `init_hook_metas` | gate authority, payer | Writes the transfer-hook extra-account-meta list; the mint's hook program must be `cross_gate` (`WrongHookProgram`) |
| `init_gate_metas` | gate authority, payer | Writes the Token ACL thaw and freeze meta lists |
| `grant_pass(owner)` | gate authority | Creates the pass; event `PassChanged` (granted) |
| `revoke_pass` | gate authority | Closes the pass, rent to the authority; event `PassChanged` (revoked) |
| `set_lock(owner, amount, unlock_ts)` | gate authority | Creates or replaces a lock. While a lock is active (`now < unlock_ts`) its amount and `unlock_ts` can only be raised or extended (`LockCannotWeaken`). Event `LockChanged` |
| `close_lock` | anyone | Closes an expired lock (`LockActive` if not expired), rent to the authority |
| `set_mode(mode)` | gate authority | Event `ModeChanged` |
| `set_authority(new_authority)` | gate authority | Event `AuthorityChanged` |
| `set_sas_requirement(sas)` | gate authority | Sets or clears the SAS credential and schema; event `SasRequirementChanged` |
| `claim_pass` | anyone (payer) | Creates the pass for `owner` if `attestation` is a valid SAS attestation (§10.4); `SasNotConfigured`, `AttestationInvalid` |
| `revoke_unattested` | anyone | Closes a pass whose attestation is expired, closed or missing (`AttestationStillValid` if still valid); rent to the pass owner |
| `set_allowlist_root(root)` | gate authority | Sets or clears the Merkle root; event `AllowlistRootChanged` |
| `claim_pass_merkle(proof)` | anyone (payer) | Creates the pass for `owner` if `proof` places `leaf(mint, owner)` under the root (`AllowlistNotConfigured`, `NotOnAllowlist`) |
| `execute(amount)` | Token-2022 (hook) | §10.2 |
| `can_thaw_permissionless`, `can_freeze_permissionless` | Token ACL | §10.2 |

Authority-signed instructions fail with `Unauthorized` for any other signer. The instruction account lists are in `idls/cross_gate.json`; the instruction index is in §4.1.

### 10.4 Passes from attestations and allowlists

**SAS attestation.** A SAS attestation for `owner` is the account at the SAS program's PDA `["attestation", credential, schema, owner]`. It is valid when its address is that PDA, it is owned by the SAS program and non-empty, its first byte is `2`, and it is not expired (`expiry == 0` never expires). Layout read by `crates/sas-attestation`: discriminator `u8`; `nonce` (32); `credential` (32); `schema` (32); `data` (`u32` length and bytes); `signer` (32); `expiry` (`i64`); token account (32). The credential and schema must equal the gate's `SasRequirement`. A wrong address and an invalid attestation both fail with `AttestationInvalid`.

**Merkle allowlist.** The leaf for a wallet is `SHA-256(0x00 ‖ mint ‖ owner)`. An inner node is `SHA-256(0x01 ‖ min(a, b) ‖ max(a, b))` over the two child hashes compared as 32-byte strings. A proof has at most 32 elements. An odd node at any level is carried up unchanged. The root is stored in `GateConfig.allowlist_root`; `buildAllowlist` in `packages/sdk` builds roots and proofs. The `leaf` entry of the vectors in §8.4 is a worked leaf.

### 10.5 How `cross_core` checks a pass

When `Cross.gate_mint` is set, `commit_order` requires the optional `pass` account and accepts the order only if: the account is owned by `cross_gate` and non-empty; it decodes as a `Pass`; `pass.mint` equals `gate_mint`; `pass.owner` equals the order's owner; and the account's address equals `["pass", gate_mint, owner]` derived under the stored `pass.bump` with the `cross_gate` program id. Otherwise `NotEligible`.

## 11. The calendar (`cross_calendar`)

A calendar lists upcoming trading sessions as UTC instants and the Pyth feed ids approved for oracle-guarded crosses on it. A cross scheduled on a calendar must close exactly when a session starts.

<!-- ocip:account Calendar -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `admin` | `Pubkey` | 32 | 8 |
| 2 | `id` | `u64` | 8 | 40 |
| 3 | `timelock_secs` | `i64` | 8 | 48 |
| 4 | `sessions` | `Vec<Session>` | variable | 56 |
| 5 | `feeds` | `Vec<[u8; 32]>` | variable | — |
| 6 | `pending` | `Option<PendingUpdate>` | 1 | — |
| 7 | `pending_admin` | `Option<PendingAdmin>` | 41 | — |
| 8 | `bump` | `u8` | 1 | — |
<!-- /ocip:account -->

Nested types: `Session { start_ts: i64, end_ts: i64 }`, `PendingUpdate { sessions, feeds, eta: i64 }`, `PendingAdmin { admin: Pubkey, eta: i64 }`. The allocated size in §3.5 is `8 + 32 + 8 + 8 + (4 + 16 · MAX_SESSIONS) + (4 + 32 · MAX_FEEDS) + (1 + (4 + 16 · MAX_SESSIONS) + (4 + 32 · MAX_FEEDS) + 8) + (1 + 32 + 8) + 1`.

| Instruction | Signer | Effect and conditions |
|---|---|---|
| `create_calendar(id, timelock_secs, sessions, feeds)` | admin | Creates the calendar at `["calendar", admin, id]`. `timelock_secs ≥ MIN_TIMELOCK_SECS` (`TimelockTooShort`); sessions and feeds validated (below). Event `CalendarUpdated` |
| `propose_update(sessions, feeds)` | admin | Stores a pending update with `eta = now + timelock_secs`; replaces any earlier proposal and restarts the wait. Event `UpdateProposed` |
| `cancel_update` | admin | Clears the pending update (`NothingPending` if none). Event `UpdateCancelled` |
| `apply_update` | anyone | Applies the pending update once `now ≥ eta` (`TimelockActive` before; `NothingPending` if none). Event `CalendarUpdated` |
| `propose_admin(new_admin)` | admin | Stores `pending_admin` with `eta = now + timelock_secs`. No event |
| `apply_admin` | anyone | Sets `admin` to the pending admin once `now ≥ eta` (`TimelockActive`, `NothingPending`). Event `CalendarAdminChanged` |

Validation of a session list: at most `MAX_SESSIONS` sessions and `MAX_FEEDS` feeds (`TooMany`); every session has `start_ts < end_ts` and `start_ts` not before the previous session's `end_ts` (`BadSessions`). The signer checks fail with `Unauthorized`. There is no instruction to cancel a pending admin change.

`cross_core` uses two queries: `has_session_start(ts)`, true if some session has `start_ts == ts`, and `approves_feed(feed_id)`, true if the feed id is in `feeds` (§6.2 step 12). The calendar is read once, at `create_cross`; later calendar updates do not change an existing cross.

## 12. Events and errors

### 12.1 Events

Events are emitted with Anchor `emit!`: the program writes a log line `Program data: <base64>` where the decoded bytes are the 8-byte event discriminator (`sha256("event:" + Name)[0..8]`) followed by the Borsh-encoded fields.

<!-- ocip:events cross_core -->
**`cross_core` events**

| Event | Discriminator | Fields |
|---|---|---|
| `AdminChanged` | `e8221fe23e121372` | `previous: Pubkey`, `admin: Pubkey` |
| `AdminProposed` | `81f9e2e3c7526ef3` | `admin: Pubkey`, `proposed: Option<Pubkey>` |
| `BaseMintBound` | `8653fa971e80a762` | `cross: Pubkey`, `base_mint: Pubkey` |
| `ChallengeExpired` | `08af094000307c78` | `cross: Pubkey`, `id: u32` |
| `ChallengeResolved` | `6499267bacfaa669` | `cross: Pubkey`, `id: u32`, `upheld: bool`, `slash: u64` |
| `CrossCleared` | `a939302f8660df4b` | `cross: Pubkey`, `printed: bool`, `clearing: Option<ClearingSummary>`, `no_print_reason: Option<NoPrintReason>` |
| `CrossCreated` | `a8ab6c6897e596c9` | `cross: Pubkey`, `creator: Pubkey`, `kind: CrossKind`, `supply_mode: SupplyMode`, `disclosure: Disclosure`, `base_mint: Pubkey`, `quote_mint: Pubkey`, `open_ts: i64`, `close_ts: i64`, `reveal_end_ts: i64`, `protocol_fee_bps: u16`, `integrator_fee_bps: u16` |
| `CrossExtSnapshot` | `9e406e0a0b2b839e` | `cross: Pubkey`, `ext: CrossExt` |
| `CrossFinalized` | `c08163b3bd876185` | `cross: Pubkey`, `protocol_fee: u64`, `integrator_fee: u64`, `proceeds_quote: u64`, `dust_base: u64` |
| `DrawFinished` | `3d122684b04333d2` | `cross: Pubkey`, `purpose: u8`, `epoch: u8`, `begun_slot: u64`, `sampled_slots: [u64; 4]`, `seed: [u8; 32]`, `end_bucket: u8`, `close_ts: i64` |
| `DrawStarted` | `65b8f1a5dd4f137a` | `cross: Pubkey`, `slot: u64`, `purpose: u8` |
| `ExtensionPending` | `2759d39dcda30197` | `cross: Pubkey`, `reason: NoPrintReason` |
| `HaltChanged` | `987611417d9c2980` | `base_mint: Pubkey`, `halted: bool`, `reason: HaltReason` |
| `InsiderChallenged` | `615cf8ee65c690ba` | `cross: Pubkey`, `id: u32`, `challenger: Pubkey`, `subject: Pubkey`, `evidence: [u8; 32]` |
| `LockCreated` | `f4d83b4d532f3dc4` | `cross: Pubkey`, `owner: Pubkey`, `amount: u64`, `start_ts: i64`, `cliff_secs: u32`, `vest_secs: u32` |
| `LockReleased` | `bcf00fa9dbb81a6f` | `cross: Pubkey`, `owner: Pubkey`, `amount: u64`, `remaining: u64` |
| `OrderCancelled` | `6c388044a871a8ef` | `cross: Pubkey`, `order: Pubkey`, `owner: Pubkey` |
| `OrderClaimed` | `d8ba83260e8ab6f8` | `cross: Pubkey`, `order: Pubkey`, `owner: Pubkey`, `side: OrderSide`, `fill: u64`, `quote_out: u64`, `base_out: u64`, `fee: u64` |
| `OrderCommitted` | `7873435283d70d53` | `cross: Pubkey`, `order: Pubkey`, `owner: Pubkey`, `side: OrderSide`, `escrow: u64`, `index: u32`, `sealed: bool` |
| `OrderPlacement` | `f8fc336f71b7ce85` | `cross: Pubkey`, `order: Pubkey`, `ext: OrderExt` |
| `OrderRevealed` | `f154caad00306c5b` | `cross: Pubkey`, `order: Pubkey`, `side: OrderSide`, `price: u64`, `quantity: u64` |
| `PauseChanged` | `eebcd54e86d1b2da` | `paused: bool` |
| `PrintFed` | `96b667292bccc51a` | `base_mint: Pubkey`, `cross: Pubkey`, `price: u64`, `matched: u64` |
| `RulesSet` | `ca68d7b017476a48` | `cross: Pubkey`, `flags: u16`, `guards: GuardRules`, `ending: EndingRules`, `identity: IdentityRules`, `alloc: AllocationRules`, `insiders: u8`, `bond_quote: u64` |
| `SeriesCreated` | `02a4362618b5e9b4` | `series: Pubkey`, `authority: Pubkey` |
| `SeriesSpawned` | `d428b5cc763bdc26` | `series: Pubkey`, `cross: Pubkey`, `index: u64`, `close_ts: i64` |
<!-- /ocip:events -->

<!-- ocip:events cross_settle -->
**`cross_settle` events**

| Event | Discriminator | Fields |
|---|---|---|
| `DammV2Seeded` | `57507f6ac27cf4f4` | `cross: Pubkey`, `pool: Pubkey`, `clearing_price: u64`, `sqrt_price: u128`, `liquidity: u128` |
| `DbcMintBound` | `4bf31afb9699aca4` | `cross: Pubkey`, `base_mint: Pubkey` |
| `DbcPoolOpened` | `8e5a9cbbc1cde1a5` | `cross: Pubkey`, `config: Pubkey`, `pool: Pubkey`, `base_mint: Pubkey`, `clearing_price: u64`, `sqrt_start_price: u128` |
| `DlmmPairOpened` | `5a40693cb67e82a1` | `cross: Pubkey`, `lb_pair: Pubkey`, `clearing_price: u64`, `active_id: i32`, `bin_step: u16` |
| `FixedPricePresaleOpened` | `651bda33877d9168` | `cross: Pubkey`, `presale: Pubkey`, `clearing_price: u64`, `q_price: u128` |
| `FutarchyDaoSeeded` | `3b7fd4b56163d1dd` | `cross: Pubkey`, `dao: Pubkey`, `clearing_price: u64`, `base_amount: u64`, `quote_amount: u64` |
| `GreenshoeBidPlaced` | `d57fbf83c6d80c43` | `greenshoe: Pubkey`, `level: u8`, `bin_id: i32`, `amount: u64`, `limit_order: Pubkey` |
| `GreenshoeCreated` | `34b23f8d46f46b24` | `cross: Pubkey`, `greenshoe: Pubkey`, `budget: u64`, `start_ts: i64`, `expires_ts: i64` |
| `GreenshoeFinished` | `759dde893480c5a9` | `greenshoe: Pubkey`, `burned: u64`, `returned: u64` |
| `GreenshoeLevelSettled` | `6a97e0e0cd439a62` | `greenshoe: Pubkey`, `level: u8` |
| `PartnerFeeClaimed` | `548f2d9fae4d1118` | `cross: Pubkey`, `pool: Pubkey`, `base: u64`, `quote: u64`, `recipient: Pubkey` |
| `PartnerMigrationFeeWithdrawn` | `34a9f6ca58ec5494` | `cross: Pubkey`, `pool: Pubkey`, `amount: u64`, `recipient: Pubkey` |
| `PartnerPoolCreationFeeClaimed` | `ef052232ecc48d88` | `cross: Pubkey`, `pool: Pubkey`, `lamports: u64`, `recipient: Pubkey` |
| `PartnerSurplusWithdrawn` | `8490a192af01479e` | `cross: Pubkey`, `pool: Pubkey`, `amount: u64`, `recipient: Pubkey` |
| `PolFeesClaimed` | `d141fa038d863a52` | `cross: Pubkey`, `pool: Pubkey`, `position: Pubkey`, `token_a: u64`, `token_b: u64`, `recipient: Pubkey` |
| `RaydiumCpmmSeeded` | `4165cddf51a6bd1b` | `cross: Pubkey`, `pool: Pubkey`, `clearing_price: u64`, `base_amount: u64`, `quote_amount: u64` |
<!-- /ocip:events -->

<!-- ocip:events cross_gate -->
**`cross_gate` events**

| Event | Discriminator | Fields |
|---|---|---|
| `AllowlistRootChanged` | `8672555b97833bc9` | `mint: Pubkey`, `root: Option<[u8; 32]>` |
| `AuthorityChanged` | `1f13ae980452d7e2` | `mint: Pubkey`, `authority: Pubkey` |
| `ConfigCreated` | `c34968a1a6f50478` | `mint: Pubkey`, `authority: Pubkey`, `mode: Mode` |
| `LockChanged` | `53845d32789b51fc` | `mint: Pubkey`, `owner: Pubkey`, `amount: u64`, `unlock_ts: i64` |
| `ModeChanged` | `957b4e1ded4843e5` | `mint: Pubkey`, `mode: Mode` |
| `PassChanged` | `09651fec6ded5cae` | `mint: Pubkey`, `owner: Pubkey`, `granted: bool` |
| `SasRequirementChanged` | `62a504c689716a65` | `mint: Pubkey`, `sas: Option<SasRequirement>` |
<!-- /ocip:events -->

<!-- ocip:events cross_calendar -->
**`cross_calendar` events**

| Event | Discriminator | Fields |
|---|---|---|
| `CalendarAdminChanged` | `7b06056a7d8ef04b` | `calendar: Pubkey`, `admin: Pubkey` |
| `CalendarUpdated` | `8ded6af7464a4740` | `calendar: Pubkey`, `sessions: u32`, `feeds: u32` |
| `UpdateCancelled` | `ac042411a937d362` | `calendar: Pubkey` |
| `UpdateProposed` | `d3040569fc788d1e` | `calendar: Pubkey`, `eta: i64` |
<!-- /ocip:events -->

No event name, and so no event discriminator, is shared by two programs. The calendar's admin event was renamed from `AdminChanged` to `CalendarAdminChanged` (ADR-0027); `cross_core` keeps `AdminChanged`. Events the calendar emitted under the old name before that change carry the discriminator `e8221fe23e121372`, the same as `cross_core`'s `AdminChanged`. A consumer MUST still attribute an event to a program before decoding it (§12.3).

Instructions that emit no event: in `cross_core`, `init_protocol`, `set_protocol_fees`, `migrate_protocol`, `set_guardian`, `init_shard` and `merge_shard`; in `cross_gate`, `init_hook_metas`, `init_gate_metas`, `execute`, `can_thaw_permissionless` and `can_freeze_permissionless`; in `cross_calendar`, `propose_admin`. `CrossFinalized.dust_base` is the base atoms sent to `proceeds_base` and `CrossFinalized.proceeds_quote` the quote atoms sent to `proceeds_quote`; `OrderCommitted.index` is `orders_total` before the increment.

### 12.2 Errors

Custom error codes start at 6000 in declaration order.

<!-- ocip:errors cross_core -->
**`cross_core` errors**

| Code | Name | Message |
|---|---|---|
| 6000 | `Paused` | Protocol is paused for new crosses and orders |
| 6001 | `Unauthorized` | Signer is not authorised |
| 6002 | `InvalidParams` | Invalid parameters |
| 6003 | `InvalidTimeline` | Invalid timeline |
| 6004 | `FeeTooHigh` | Fee exceeds its cap |
| 6005 | `OffGrid` | Price is not on the cross's grid |
| 6006 | `Overflow` | Arithmetic overflow |
| 6007 | `NotInCallWindow` | Outside the call window |
| 6008 | `NotInRevealWindow` | Outside the reveal window |
| 6009 | `CallNotOver` | The call and reveal windows have not ended |
| 6010 | `CrossFull` | Cross has reached its order limit |
| 6011 | `SellsNotAccepted` | This cross does not accept sell orders |
| 6012 | `NotEligible` | Owner is not eligible for this cross |
| 6013 | `ShardMissing` | Shard account required |
| 6014 | `WrongShard` | Wrong shard for this order |
| 6015 | `WrongCross` | Order does not belong to this cross |
| 6016 | `NotSealed` | Cross is not sealed |
| 6017 | `AlreadyRevealed` | Order already revealed |
| 6018 | `CommitmentMismatch` | Reveal does not match the commitment |
| 6019 | `InsufficientEscrow` | Escrow does not cover the order |
| 6020 | `AlreadyMerged` | Shard already merged |
| 6021 | `ShardsNotMerged` | Not every shard has been merged |
| 6022 | `WrongState` | Cross is in the wrong state for this action |
| 6023 | `InvalidBook` | Book is inconsistent |
| 6024 | `OrdersOutstanding` | Orders remain unclaimed |
| 6025 | `MintAuthorityNotCross` | Mint mode requires the cross PDA to hold the mint authority |
| 6026 | `TokenAccountMissing` | The token account for this order side is required |
| 6027 | `WrongMint` | Mint or token program does not match the cross |
| 6028 | `WrongVault` | Vault does not match the cross |
| 6029 | `SettlementPending` | Settlement has not bound the base mint yet |
| 6030 | `NotSettler` | Only the registered settler may do this |
| 6031 | `DeadlineNotReached` | Settlement deadline has not passed |
| 6032 | `OracleAccountMissing` | This cross needs a Pyth price update account |
| 6033 | `CalendarMismatch` | Calendar account missing or does not match |
| 6034 | `NotACalendarSession` | The cross must close at the start of a calendar session |
| 6035 | `FeedNotApproved` | The oracle feed is not approved by the calendar |
| 6036 | `BaseDustAccountsMissing` | This cross holds base dust: base_vault, base_mint and proceeds_base are required |
| 6037 | `SettlementDeadlinePassed` | The settlement deadline has passed |
| 6038 | `LegacyCross` | This cross was created before the extension tail existed and cannot take rules |
| 6039 | `RulesLocked` | Rules can only be set by the creator, in the creating slot, before any order |
| 6040 | `HaltMismatch` | The halt state does not belong to this cross's base mint |
| 6041 | `FeedMismatch` | The lender print feed does not belong to this cross's base mint |
| 6042 | `GridPolicy` | The price grid does not follow the standard policy |
| 6043 | `OracleUnavailable` | A fresh, fully verified oracle update for the registered feed is required |
| 6044 | `CancelClosed` | Orders can no longer be cancelled |
| 6045 | `DrawRequired` | The draw for this cross has not been finished |
| 6046 | `BucketExcluded` | That ending bucket falls after the drawn end and never counts |
| 6047 | `ExtensionPending` | The extension is waiting for its draw |
| 6048 | `DrawPending` | A draw is already in flight |
| 6049 | `NothingToDraw` | There is nothing to draw now |
| 6050 | `DrawExpired` | The block hashes needed for the draw are no longer available; begin the draw again |
| 6051 | `ApplicantMismatch` | The applicant record is missing or does not match |
| 6052 | `IdentityLimit` | This identity has reached its order or escrow limit |
| 6053 | `ClassBookMissing` | The class book is missing or does not match |
| 6054 | `ClassNotAllowed` | The order does not qualify for the class it asked for |
| 6055 | `LotSize` | A lottery order must be exactly one lot |
| 6056 | `LockupMismatch` | The lock vault or lockup record is missing or does not match |
| 6057 | `NothingToRelease` | Nothing has vested yet |
| 6058 | `ChallengeWindowClosed` | The challenge window has closed |
| 6059 | `ChallengeMismatch` | The challenge record does not match |
| 6060 | `ChallengesOutstanding` | Insider challenges are still open, or their window has not passed |
| 6061 | `SeriesInactive` | The series is paused or has spawned all its crosses |
| 6062 | `SeriesPreviousMissing` | The previous cross of the series is missing or has not resolved |
| 6063 | `SpawnTooEarly` | The next cross is not due yet |
| 6064 | `NoSessionAhead` | The calendar has no session ahead |
| 6065 | `ReferralAccountMissing` | The referrer's quote token account is missing or does not match |
| 6066 | `NotRefundOnly` | This order has a fill; claim it instead |
<!-- /ocip:errors -->

<!-- ocip:errors cross_settle -->
**`cross_settle` errors**

| Code | Name | Message |
|---|---|---|
| 6000 | `WrongCross` | Account is not a cross_core cross |
| 6001 | `NotCreator` | Only the cross creator may open the DBC pool |
| 6002 | `AlreadyBound` | Base mint already bound |
| 6003 | `WrongSettler` | Cross does not name this adapter's settler |
| 6004 | `WrongMint` | Quote mint does not match the cross |
| 6005 | `NotCleared` | Cross has not cleared |
| 6006 | `BadConfig` | DBC config must be Token-2022 with partner mint authority |
| 6007 | `StartPriceNotClearingPrice` | DBC start price must equal the clearing price |
| 6008 | `PoolNotOpened` | DBC pool has not been opened for this cross |
| 6009 | `Overflow` | Arithmetic overflow |
| 6010 | `WrongDestination` | The destination does not belong to the account the cross names for this payout |
| 6011 | `DesignMigration` | The locked design requires migration into DAMM v2 |
| 6012 | `DesignNotCompounding` | The locked design requires a compounding migrated pool with a compounding fee |
| 6013 | `DesignUnlockedLiquidity` | The locked design leaves liquidity withdrawable at migration |
| 6014 | `DesignPartnerVesting` | The settler cannot vest liquidity: partner liquidity may only be locked permanently |
| 6015 | `DesignLockTooLow` | The locked design requires at least 20% of the liquidity locked permanently |
| 6016 | `WrongPair` | Not a DLMM pair of this cross's mints that is open for trading |
| 6017 | `GreenshoeBudget` | The greenshoe budget is below 10% of what the cross raised, above a level's share, or exceeds the budget |
| 6018 | `GreenshoeWindow` | Bids are only accepted inside the greenshoe week, and the period and window parameters must be sane |
| 6019 | `GreenshoeLevel` | That greenshoe level is invalid, already placed, not placed, or already settled |
| 6020 | `GreenshoeBin` | The bid must sit in the bin nearest its level, strictly below the active bin |
| 6021 | `GreenshoeRateLimit` | This period's greenshoe deployment cap is used up |
| 6022 | `GreenshoeNotExpired` | The greenshoe week has not ended |
| 6023 | `BadArgs` | The argument bytes are not the Borsh encoding of the expected parameters |
| 6024 | `BadgeAccounts` | Pass exactly two badge accounts: base then quote, or the DLMM program id for none |
| 6025 | `BatchWindow` | A batch window must be between 30 seconds and 7 days |
| 6026 | `BatchActivation` | A batch-opened pool needs a timestamp start at least the window away |
| 6027 | `BatchNotCompounding` | A batch-opened DAMM v2 pool must compound its fees |
| 6028 | `BatchFeeNotDecaying` | A batch-opened DAMM v2 pool must open with a fee that decays over time |
| 6029 | `GraduationNotApproved` | This cross's graduation is decided by a holder vote: pass the outcome of a passed vote for this venue as the last remaining account |
| 6030 | `FutarchyNeedsLegacyTokens` | MetaDAO's futarchy program accepts only legacy SPL Token mints: both tokens of this cross must be legacy tokens |
| 6031 | `PresaleNotFixedPrice` | A tranche at the clearing price must be a fixed-price presale |
<!-- /ocip:errors -->

<!-- ocip:errors cross_gate -->
**`cross_gate` errors**

| Code | Name | Message |
|---|---|---|
| 6000 | `NotTransferring` | Hook executed outside a Token-2022 transfer |
| 6001 | `RecipientNotAllowed` | Owner does not hold a pass for this token |
| 6002 | `Locked` | Transfer would take the balance below an active lock |
| 6003 | `NotMintAuthority` | Signer is not the mint authority |
| 6004 | `WrongHookProgram` | Mint's transfer hook does not point at this program |
| 6005 | `Unauthorized` | Signer is not the gate authority |
| 6006 | `LockCannotWeaken` | An active lock can only be raised or extended |
| 6007 | `LockActive` | Lock has not expired |
| 6008 | `NotCalledByTokenAcl` | Gate check was not invoked by Token ACL |
| 6009 | `WrongMetaList` | Extra-account-meta list is not this mint's thaw or freeze list |
| 6010 | `AllowlistNotConfigured` | This gate has no allowlist |
| 6011 | `NotOnAllowlist` | Proof does not place this wallet on the allowlist |
| 6012 | `SasNotConfigured` | This gate does not accept SAS attestations |
| 6013 | `AttestationInvalid` | Attestation is missing, foreign, expired or not for this wallet |
| 6014 | `AttestationStillValid` | Attestation is still valid |
| 6015 | `OwnerAllowed` | Owner holds a pass; permissionless freeze is not allowed |
<!-- /ocip:errors -->

<!-- ocip:errors cross_calendar -->
**`cross_calendar` errors**

| Code | Name | Message |
|---|---|---|
| 6000 | `TimelockTooShort` | Timelock must be at least seven days |
| 6001 | `TooMany` | Too many sessions or feeds |
| 6002 | `BadSessions` | Sessions must be increasing and must not overlap |
| 6003 | `NothingPending` | No pending update |
| 6004 | `TimelockActive` | Timelock has not passed |
| 6005 | `Unauthorized` | Signer is not the calendar admin |
| 6006 | `Overflow` | Arithmetic overflow |
<!-- /ocip:errors -->

### 12.3 Attributing events (indexers)

The Solana runtime does not say which program wrote a `Program data:` line. An indexer MUST track the invoke stack from the `Program <id> invoke [n]`, `Program <id> success` and `Program <id> failed` log lines and accept an event only when the program on top of the stack is the program whose events it expects. This accepts `cross_core` events when `cross_core` is called directly or through CPI (a venue, `cross_settle`) and rejects look-alike payloads from any other program. If the logs are truncated (`Log truncated`) or the stack is unbalanced, the transaction's events cannot be attributed and MUST NOT be guessed; the indexer falls back to reading account state (§14.2).


## 13. Verification

Anyone can recompute whether a cross cleared where the rule says it should, from two accounts on chain and nothing else. The result is a **fairness proof** (`opening-cross/fairness-proof/v1`), implemented by `packages/verifier` and served by `GET /v1/crosses/:address/proof`.

### 13.1 Inputs

- The `Cross` account at the cross address. It MUST be owned by the `cross_core` program and carry the `Cross` discriminator (§3.5).
- The `Levels` book account at `["book", cross]` under `cross_core` (§3.3).
- A cluster RPC. A verifier SHOULD read at `finalized` commitment.

After `clear` the book is not written again, so the two reads are consistent. The verifier needs no event, transaction or API.

### 13.2 Procedure

1. Decode the cross and the book. A missing account is an error, not a failed proof.
2. Select the state name: `Live`, `Cleared`, `NoPrint`, `Finalized`. If the state is `Live`, stop: the proof is returned with `verified = false`, a `recomputed` object with `printed = false` and every other field `null`, and the note "The cross has not cleared yet; nothing to verify."
3. Build the book levels: for each tick `i < ticks` with a non-zero buy or sell aggregate, a level at price `min_price + i · tick` with the two aggregates and the two order counts. Levels are listed in ascending price.
4. Recompute the clearing with the exhaustive procedure of §7.3 over the grid, using one aggregate buy "order" and one aggregate sell "order" per level and the cross's `reference_price`. If there is none, the recomputed outcome is no print with reason `NoCross`.
5. Apply the print guards of §7.7 with the cross's `min_matched` and `max_imbalance_bps`: `BelowMinimumVolume` first, then `ImbalanceTooHigh`. A refusal makes the recomputed outcome a no print with that reason.
6. Read the on-chain outcome: `printed` is whether `clearing` is present; `price`, `matched` and `rationed` (`none`, `buy` or `sell`) from it; `noPrintReason` as the numeric index of the `NoPrintReason` enum, or `null`.
7. Decide `verified`, by the on-chain reason:
   - `OracleDivergence` or `OracleUnavailable`: the verdict depends on a Pyth update that is not stored (§7.8). `verified` is true if and only if the cross did not print. A note says that the book alone cannot reproduce the verdict and gives the book's own clearing.
   - `SettlementExpired`: the cross cleared and was abandoned by its adapter. `verified` is true if and only if the recomputation printed. A note says every order was refunded.
   - Printed on chain: `verified` is true if and only if the recomputation printed with the same `price`, `matched` and `rationed`. If the cross has an oracle guard, a note says that it was configured and passed.
   - Otherwise (no print on chain): `verified` is true if and only if the recomputation did not print and its reason equals the on-chain reason.
8. Emit the proof (§13.3).

### 13.3 The fairness proof

A JSON object. Integers that may exceed 2^53 are decimal strings; `ticks`, `buyOrders`, `sellOrders` and the numeric `noPrintReason` are JSON numbers.

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `opening-cross/fairness-proof/v1` |
| `program` | address | The `cross_core` program id |
| `cross` | address | The cross |
| `state` | string | `Live`, `Cleared`, `NoPrint` or `Finalized` |
| `params.minPrice`, `params.tick` | string | The grid |
| `params.ticks` | number | |
| `params.priceScale` | string | |
| `params.referencePrice` | string or null | |
| `params.minMatched` | string | |
| `params.maxImbalanceBps` | number or null | |
| `params.oracleGuard` | boolean | Whether the cross has an oracle guard |
| `book[]` | array | One entry per non-empty level, ascending: `price`, `buy`, `sell` (strings), `buyOrders`, `sellOrders` (numbers) |
| `onchain.printed` | boolean | `clearing` is present on the account |
| `onchain.price`, `onchain.matched` | string or null | From `clearing` |
| `onchain.rationed` | `none`, `buy`, `sell` or null | |
| `onchain.noPrintReason` | number or null | Index into the `NoPrintReason` enumeration (§3.4) |
| `recomputed.printed` | boolean | |
| `recomputed.price`, `recomputed.matched` | string or null | |
| `recomputed.rationed` | `none`, `buy`, `sell` or null | |
| `recomputed.noPrintReason` | string or null | The variant name: `NoCross`, `BelowMinimumVolume` or `ImbalanceTooHigh` |
| `verified` | boolean | §13.2 step 7 |
| `notes` | string[] | Explanations that do not change `verified` |

The two `noPrintReason` fields have different types by design of version 1: the on-chain one is the enumeration index, the recomputed one is a name.

A real proof, captured on 2026-10-13 from the devnet deployment (`GET /v1/crosses/6im5Hf6WRK7XUGrb9J2Ffh4GoKo1wGJdQkj8PcxJon4w/proof`). The cross is a launch whose schedule sells 1,000 tokens at 1.20 and which received one bid of 600 at 1.30. The volume is 600, the imbalance is 400 at every price from 1.20 to 1.30, so the lowest price, 1.20, wins and the sell side is rationed (§7.3):

```json ocip:proof-sample
{
  "schema": "opening-cross/fairness-proof/v1",
  "program": "F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ",
  "cross": "6im5Hf6WRK7XUGrb9J2Ffh4GoKo1wGJdQkj8PcxJon4w",
  "state": "Finalized",
  "params": {
    "minPrice": "1000000",
    "tick": "50000",
    "ticks": 40,
    "priceScale": "1000000",
    "referencePrice": null,
    "minMatched": "0",
    "maxImbalanceBps": null,
    "oracleGuard": false
  },
  "book": [
    { "price": "1200000", "buy": "0", "sell": "1000000000", "buyOrders": 0, "sellOrders": 1 },
    { "price": "1300000", "buy": "600000000", "sell": "0", "buyOrders": 1, "sellOrders": 0 }
  ],
  "onchain": { "printed": true, "price": "1200000", "matched": "600000000", "rationed": "sell", "noPrintReason": null },
  "recomputed": { "printed": true, "price": "1200000", "matched": "600000000", "rationed": "sell", "noPrintReason": null },
  "verified": true,
  "notes": []
}
```

### 13.4 What a proof shows and what it does not

A proof with `verified = true` shows that the price, matched volume and rationed side stored on the cross are what the rule produces from the book stored on chain, and that the print guards were applied as stated.

It does not show that: the book equals the sum of the orders that were placed (that needs the order and event history); each individual fill and payment equals the rule's value (that is `claim`'s computation, tested by the vectors in §16 but not part of the proof); the oracle verdict was correct (§7.8); the tokens behind the cross are what their issuer says they are; or that the program running on chain equals the source in the repository (`docs/evidence/L4-verifiable-build.md` records byte-for-byte equality of the devnet binaries with local builds as of that file's date). There is no zero-knowledge or multi-party proof: the "proof" is a recomputation anyone can repeat.

### 13.5 Verifier requirements

A Verifier MUST: check the owner and discriminator of the accounts it decodes; implement §7.3 so that it reproduces every vector in §16; treat an unreadable or missing account as an error distinct from `verified = false`; and report `verified = false` rather than a pass for a `Live` cross. It SHOULD read at `finalized` commitment and SHOULD retry on rate-limit and transient errors.

The reference command is `opening-cross-verify <cross-address> [--rpc <url>]` (RPC from `RPC_URL` or `https://api.devnet.solana.com` by default). It prints the proof as JSON and exits `0` when `verified` is true, `1` when it is false (including a cross that has not cleared), `2` when the cross could not be read.

## 14. Requirements by role

### 14.1 Integrators (venues)

A venue creates crosses, builds order transactions for its users, and earns the integrator fee. It MAY call `cross_core` directly or by CPI (`crates/opening-cross-cpi` provides typed bindings generated from the IDLs, and `examples/venue` routes a user's order into a cross with one CPI).

An Integrator MUST:

- set `integrator` and `integrator_fee_bps` at creation, understanding that the protocol fee is derived from them (§7.6) and that a cross with `integrator_fee_bps = 0` pays no fee at all;
- create every shard (`init_shard`, one per `0 ≤ i < shards`) before `reveal_end_ts`, because a cross whose shards are not all merged cannot clear;
- follow the order entry rules of §8.3 and the account lists of §6.3;
- when it creates a sealed cross, give users the reveal window (`reveal_end_ts > close_ts`) and tell them that an unrevealed order is refunded (§8.2).

An Integrator SHOULD: check the issuer powers of the base and quote mints before creating a cross (a freeze or pause authority, a transfer hook, a transfer fee, a permanent delegate: the program accepts SPL Token and Token-2022 mints and does not inspect extensions; the reference API refuses mints with blocking properties and returns warnings for the rest, `POST /v1/tx/create-cross`); run or contract a keeper (§14.3); and publish the cross address so that third parties can verify it (§13).

### 14.2 Indexers

An Indexer MUST: follow finalized transactions; attribute events by invoke stack as in §12.3; decode an account as a `Cross`, `Order` or `Levels` only if it is owned by `cross_core` and carries the matching discriminator; ignore event discriminators it does not know; and treat the chain as the source of truth when the two disagree.

The reference indexer reconciles its view with the chain and records every disagreement. The fields it compares for each cross are: `state`, `base_mint`, the number of orders committed (`orders_total`), the clearing `price` and `matched`, `no_print_reason` and `orders_open`; and, for each order it believes open, whether its account exists. Events can be lost (log truncation, source outage), which is why the comparison exists. An Indexer SHOULD do the same.

### 14.3 Keepers

Every instruction a keeper needs is permissionless and cannot redirect funds, so any number of keepers can run at once; a duplicate fails harmlessly. The reference keeper decides each step from the cross account read in the same pass, never from an index:

| State of the cross | Action |
|---|---|
| `Live`, `now ≥ reveal_end_ts` | `merge_shard` for every shard whose bit in `merged_mask` is clear (one per transaction keeps each within the compute budget), then `clear`. For a cross with an oracle guard, post a fresh Pyth update and pass it to `clear`; without one the cross cannot be cleared (`OracleAccountMissing`) |
| `Cleared`, deferred-mint, `base_bound` false | If `settle_deadline_ts > 0` and `now ≥ settle_deadline_ts`: `abandon_settlement`. Otherwise wait for the adapter |
| `Cleared` (bound) or `NoPrint` | `claim` every open order; when `orders_open = 0`, `finalize` |
| `Finalized` | Nothing |

A Keeper MUST NOT assume it is the only keeper, MUST re-read the cross before each step, and SHOULD discover open orders from a list but re-read each order account before use. If the number of open orders it finds differs from `orders_open` it SHOULD NOT send `finalize` (the program would refuse it while orders remain) and SHOULD report the difference.

The reference keeper additionally withholds `clear` while a mint it depends on is in a state that stops transfers (paused, an active transfer hook, a pending multiplier change inside a halt window) and retries refused steps for a frozen token account after a delay. These are operating policies, not protocol rules; the program has no such check.

## 15. Signed promises

A promise is a claim made before an outcome is known, signed, and graded against the chain afterwards (ADR-0015). The only kind defined is `CLEAR_BAND`: where an open-book cross's final clearing price will land, as a band of grid ticks. Sealed crosses have no indicative price and receive no promise.

### 15.1 Document

A **signed promise** is a JSON object `{ "promise": <promise>, "signer": <address>, "signature": <hex> }`. `promise` is the **body** plus its `id`.

| Field of the body | Type | Meaning |
|---|---|---|
| `schema` | string | `opening-cross/promise/v1` |
| `kind` | string | `CLEAR_BAND` |
| `cluster` | string | `devnet`, `mainnet-beta` or `localnet`; non-empty |
| `program` | address | The `cross_core` program whose accounts are the truth |
| `subject.cross` | address | |
| `subject.bucket` | integer ≥ 0 | Third of the call window in which the promise was issued: 0 early, 1 middle, 2 late (bucket bounds, §15.3) |
| `subject.grid` | object | `minPrice`, `tick`, `priceScale` (decimal strings, `tick > 0`), `ticks` (integer ≥ 2) |
| `subject.ordersCommitted` | integer | `orders_total` when issued |
| `issuedAt` | integer | Cluster time, Unix seconds |
| `deadline` | integer ≥ `issuedAt` | After this time with no outcome the promise is reported unresolved |
| `claim.pointTick`, `claim.loTick`, `claim.hiTick` | integers | Grid tick indices with `0 ≤ lo ≤ point ≤ hi < ticks` |
| `claim.nominalCoverageBps` | integer or null | Coverage claimed, strictly between 0 and 10000 for a calibrated band; null when provisional |
| `claim.status` | string | `CALIBRATED` or `PROVISIONAL` |
| `claim.reason` | string or null | Why a band is provisional; null when calibrated |
| `claim.calibration` | object | `cell`, `n`, `crosses`, `quantileTicks` (integer or null), `samplesHash` (64 lowercase hex) |
| `outcomeSpec` | object | `{ "source": "cross_core.Cross.clearing.price", "rule": "HIT_IN_TICKS" }` |
| `inputsHash` | string | SHA-256 of the canonical inputs document (§15.4); 64 lowercase hex |
| `modelId` | string | Non-empty. The reference value is `indicative-clearing/adr-0003+split-conformal/v1` |
| `policyHash` | string | SHA-256 of the canonical policy in force; 64 lowercase hex |

A body MUST satisfy: calibrated implies a coverage in `(0, 10000)`, a non-null `quantileTicks` and a null `reason`; provisional implies a null coverage and a non-empty `reason`. A provisional band has `loTick = pointTick = hiTick` and claims no coverage.

### 15.2 Identifier and signature

**Canonical form.** The body is serialized as RFC 8785 (JCS) JSON restricted to objects, arrays, strings, booleans, null and safe integers. Floating-point numbers and non-safe integers MUST be refused. Object members are sorted by UTF-16 code units, strings use JSON string escaping, and there is no whitespace.

**Identifier.** `id` = lowercase hex SHA-256 of the UTF-8 canonical body (all fields except `id`). Altering one byte changes the id.

**Signature.** The signer signs, with ed25519, the UTF-8 bytes of

```
"opening-cross/promise/v1\n" + id
```

The prefix keeps a promise signature from being replayed as any other message. `signature` is the 64-byte signature as 128 lowercase hex characters; `signer` is the Solana address of the ed25519 public key. A checker MUST verify the id against the body first, then the signature against `signer`, and when it expects a particular signer MUST compare `signer` to it before anything else. The result is one of `ok`, `ID_MISMATCH`, `BAD_SIGNATURE`, `MALFORMED`, `WRONG_SIGNER`.

### 15.3 `CLEAR_BAND` semantics

- The **point** is the price the open book would clear at if the call closed now, computed with §7.3 over the cross's book and reference tick. No promise is issued when the call is not open or the book does not cross.
- The **band** is `[point − h, point + h]` clamped to the grid, where `h` is the cell's conformal quantile when the cell is calibrated, and `0` when it is provisional.
- A cell (one per time bucket, `clear-band/bucket-<b>`) is **calibrated** only when all of the following hold on its graded samples (one sample per cross: its last promise in the bucket): the ⌈(n+1)·nominal⌉-th smallest absolute tick error exists (`n` large enough for a bounded band); at least `minCalibrationSamples` samples; spanning at least `minDistinctDays` distinct UTC days of outcome; at least `minHeldOutSamples` prequential held-out samples; and the prequential coverage does not fall below nominal (the Wilson 95% upper bound is not below the nominal share). Otherwise the status is `PROVISIONAL` and `reason` lists what is missing.
- **Default policy** (`DEFAULT_POLICY`): `nominalCoverageBps = 9000`, `minCalibrationSamples = 30`, `minDistinctDays = 2`, `minHeldOutSamples = 20`, `bucketBoundsBps = [3333, 6667]`. A bucket index is the number of bounds not above `floor((now − open_ts) · 10000 / (close_ts − open_ts))`, clamped to `[0, 9999]` basis points.
- `deadline = reveal_end_ts + grace`, with a default grace of seven days.

### 15.4 Inputs and the point check

The **inputs document** published with a promise is the JSON object:

```json
{ "grid": { "minPrice": "…", "tick": "…", "ticks": 21, "priceScale": "…" },
  "referenceTick": 10,
  "levels": [ [tick, "buy quantity", "sell quantity"], … ] }
```

with `levels` listing, in ascending tick order, only ticks with a non-zero buy or sell quantity, and `referenceTick` the reference price as a tick index or `null`. `inputsHash` is the SHA-256 of its canonical form (§15.2). A checker recomputes the point by running §7.3 over `levels` and compares the tick to `claim.pointTick`.

### 15.5 Grading

A grade is a pure function of the promise and an outcome read from the cross account:

| Outcome | Grade | Detail |
|---|---|---|
| Cross not yet cleared | `UNRESOLVED` | Reason `HORIZON_NOT_ELAPSED`, or `DEADLINE_PASSED_WITHOUT_OUTCOME` when `now > deadline` |
| Cross did not print | `VOID` | Reason `NO_PRINT:<reason>` |
| Cleared, band claimed a coverage | `HIT` if `loTick ≤ outcomeTick ≤ hiTick`, else `MISS` | `errorTicks = abs(outcomeTick − pointTick)`; interval score `(hi − lo) + (2 / α) · (shortfall below lo + excess above hi)` with `α = 1 − nominal` |
| Cleared, provisional | `SCORED` | `errorTicks` recorded; nothing to hit or miss |

`outcomeTick = (clearing.price − min_price) / tick`. Every promise is counted exactly once in exactly one of the five statuses; a report MUST NOT drop `MISS`, `VOID` or `UNRESOLVED`.

### 15.6 Anchoring

A signature proves who made a promise, not when. Promise ids issued since the last anchor are folded into a Merkle root that is written to the chain in an SPL Memo transaction signed by the promiser key, so chain time bounds each promise from above.

- Leaves: `SHA-256(0x00 ‖ id_bytes)`, where `id_bytes` is the 32-byte decoded id. Inner nodes: `SHA-256(0x01 ‖ left ‖ right)`.
- The ids are deduplicated and sorted as strings; an odd node at any level is promoted unchanged, never duplicated.
- Memo text: `opening-cross/promises/v1 root=<64 hex> n=<count>`.
- An inclusion proof is a list of `{ hash, side }` steps, `side` being `L` or `R` for the sibling's position.
- The Merkle tree here is a different construction from the gate allowlist tree of §10.4 (positional sides and promotion of odd nodes, against sorted pairs).

### 15.7 Vectors

A complete promise built by the reference code from the E2 book of §7.9 (reference price 100, tick 10 of 21), signed with a fixed ed25519 test key, and an anchor digest of three ids. The key is a published test key with no value; it exists so that a checker can verify the signature without holding anything secret.

```json ocip:promise-vector
{
  "seedHex": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "signer": "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
  "signingDomain": "opening-cross/promise/v1\n",
  "inputs": {
    "grid": { "minPrice": "90", "tick": "1", "ticks": 21, "priceScale": "1" },
    "referenceTick": 10,
    "levels": [[9, "0", "4"], [10, "7", "23"], [11, "5", "0"]]
  },
  "canonicalBody": "{\"claim\":{\"calibration\":{\"cell\":\"clear-band/bucket-0\",\"crosses\":0,\"n\":0,\"quantileTicks\":null,\"samplesHash\":\"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945\"},\"hiTick\":10,\"loTick\":10,\"nominalCoverageBps\":null,\"pointTick\":10,\"reason\":\"NEED_9_SAMPLES_FOR_A_BOUNDED_BAND (have 0); SAMPLES 0<30; DISTINCT_DAYS 0<2; HELD_OUT 0<20\",\"status\":\"PROVISIONAL\"},\"cluster\":\"devnet\",\"deadline\":608800,\"inputsHash\":\"8925ac221b9671f685f4d40e7c3db90a929c3299a94b92df87506a526d166c29\",\"issuedAt\":1500,\"kind\":\"CLEAR_BAND\",\"modelId\":\"indicative-clearing/adr-0003+split-conformal/v1\",\"outcomeSpec\":{\"rule\":\"HIT_IN_TICKS\",\"source\":\"cross_core.Cross.clearing.price\"},\"policyHash\":\"73b6c8bc5a2846a0980121d21bcd88baa7b92ee11eb32e3d75f546c8cd69a64e\",\"program\":\"F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ\",\"schema\":\"opening-cross/promise/v1\",\"subject\":{\"bucket\":0,\"cross\":\"4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw\",\"grid\":{\"minPrice\":\"90\",\"priceScale\":\"1\",\"tick\":\"1\",\"ticks\":21},\"ordersCommitted\":6}}",
  "signed": {
    "promise": {
      "schema": "opening-cross/promise/v1",
      "kind": "CLEAR_BAND",
      "cluster": "devnet",
      "program": "F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ",
      "subject": {
        "cross": "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
        "bucket": 0,
        "grid": { "minPrice": "90", "tick": "1", "ticks": 21, "priceScale": "1" },
        "ordersCommitted": 6
      },
      "issuedAt": 1500,
      "deadline": 608800,
      "claim": {
        "pointTick": 10,
        "loTick": 10,
        "hiTick": 10,
        "nominalCoverageBps": null,
        "status": "PROVISIONAL",
        "reason": "NEED_9_SAMPLES_FOR_A_BOUNDED_BAND (have 0); SAMPLES 0<30; DISTINCT_DAYS 0<2; HELD_OUT 0<20",
        "calibration": {
          "cell": "clear-band/bucket-0",
          "n": 0,
          "crosses": 0,
          "quantileTicks": null,
          "samplesHash": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        }
      },
      "outcomeSpec": { "source": "cross_core.Cross.clearing.price", "rule": "HIT_IN_TICKS" },
      "inputsHash": "8925ac221b9671f685f4d40e7c3db90a929c3299a94b92df87506a526d166c29",
      "modelId": "indicative-clearing/adr-0003+split-conformal/v1",
      "policyHash": "73b6c8bc5a2846a0980121d21bcd88baa7b92ee11eb32e3d75f546c8cd69a64e",
      "id": "fee3a4dd75b9ba44f9821d185d86daa055310f00f61462af34f635f87af23c14"
    },
    "signer": "9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj",
    "signature": "fce9fb8f0881773bf3a867679b6a412913ad7a60c943e24064053f51120048ab50f28feb856117cb2b086ce24cab484570d3253723890d6ccda2cdb7e7bdc10c"
  },
  "digest": {
    "ids": [
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
      "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6"
    ],
    "root": "dd67a4e94fcb4fff954bcb093257364a5b5d0832bda9ffb7a5b6340e45ca647b",
    "memo": "opening-cross/promises/v1 root=dd67a4e94fcb4fff954bcb093257364a5b5d0832bda9ffb7a5b6340e45ca647b n=3",
    "proofForSecond": [
      { "hash": "6a3fc11b79f836bda340e75c8906e961b8adf4d6a08a2b992e3f38cd6ff38ebf", "side": "L" },
      { "hash": "a23bd5b06da9048238a65b3f1d9d0b9e15fae3dde262688e6489aa4c763d1820", "side": "R" }
    ]
  }
}
```

`canonicalBody` is the JCS serialization of the body; `id` is its SHA-256. A checker run over `signed`, `inputs` and `digest` MUST get: id valid, signature valid for `signer`, `inputsHash` equal to the hash of `inputs`, point tick equal to `claim.pointTick`, and the Merkle root and the proof for the second id as listed.

### 15.8 Trust model

The promiser's key is a trust root for the record: promises by any other key are not the promiser's. Losing the key ends new promises, not old checks. Calibration is only as good as the graded history; on a young deployment every band is provisional and claims nothing. Whether an issued band covers at its nominal rate on a public cluster is NOT VERIFIED at the time of writing (`docs/HUMAN_TASKS.md`, HD2).

## 16. Conformance

### 16.1 Clearing vectors

`packages/verifier/conformance/v1.json`, schema `opening-cross/conformance/v1`, holds the clearing vectors.

```json ocip:conformance
{
  "schema": "opening-cross/conformance/v1",
  "file": "packages/verifier/conformance/v1.json",
  "cases": 525,
  "generator": "cargo run -p clearing-core --example conformance_vectors"
}
```

The file is `{ schema, rule, generator, units, cases[] }`. `rule` names `docs/adr/0003-clearing-rule.md`; `generator` is the command that writes the file; `units` states that prices are grid prices in quote atoms per `priceScale`, quantities and fills are in base atoms, and every integer is a decimal string.

A **case** is:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | |
| `grid` | `{ min, tick, ticks }` | decimal strings for `min`, `tick`; `ticks` a number |
| `reference` | string or null | The reference price |
| `guards` | `{ minMatched, maxImbalanceBps }` | `minMatched` a string; `maxImbalanceBps` a number or null |
| `orders` | array | `{ side, price, quantity }` with `side` either `buy` or `sell` and the other two decimal strings, in a fixed order |
| `expect` | object | Printed: `{ printed: true, price, matched, rationed, fills[] }` with `rationed` one of `none`, `buy`, `sell` and `fills[i]` the fill of `orders[i]`. Not printed: `{ printed: false, noPrintReason, wouldClearAt? }` with `noPrintReason` one of `NoCross`, `BelowMinimumVolume`, `ImbalanceTooHigh`, and `wouldClearAt` the price the book cleared at before a guard refused it (absent for `NoCross`) |

The 525 cases are 25 curated edge cases (empty and one-sided books, a bid below the ask, the tie-breaks, the reference price below, inside and above the range, interior gap prices, rationing both ways, the grid edges, one-atom marginal orders, quantities near `u64::MAX`, the full 256-tick grid, prime-quantity ratios, and each guard at and just beyond its bound, and a fine grid with a large book) and 500 seeded random books (SplitMix64, fixed seed).

**What an implementation must reproduce.** For every case, the same outcome in the canonical comparison: for a printed case the tuple `(price, matched, rationed, fills)`; for a refusal `(noPrintReason, wouldClearAt or none)`. The generator evaluates, in order: the clearing (§7.3), the volume guard, the imbalance guard (§7.7); the oracle guard and the settlement deadline are outside the vectors. Orders are aggregated into levels, so the cases state the fill of every order as the program computes it.

### 16.2 Running them

| What | Command | Result |
|---|---|---|
| The independent TypeScript reference against the committed file | `pnpm --filter @opening-cross/verifier conformance`, or the `opening-cross-conformance [vectors.json]` binary | Prints `{ schema, cases, failures }` and exits `0` only if `failures` is `0` |
| Regenerate the file from `clearing-core` and compare | `cargo run -q --release -p clearing-core --example conformance_vectors > /tmp/v1.json && diff /tmp/v1.json packages/verifier/conformance/v1.json` | CI fails on any byte of difference |
| Your own implementation | `import { loadVectors, runConformance } from '@opening-cross/verifier'` and pass a function from case to expected-shape result | `runConformance` returns the cases the function got wrong; an empty list is conformant. A function that throws fails every case without crashing the run |
| The deployed program | `tests/core/test/conformance.test.ts` (LiteSVM; Linux, not Windows) | Places the orders of each case as a real cross, clears and claims every order, and compares fills |

The packages are not on a registry yet (`docs/HUMAN_TASKS.md`, H12): use them from a clone.

Recorded results (`docs/evidence/D5-conformance.md`): the independent TypeScript implementation reproduces 525 of 525; the program reproduces the 523 it can represent on LiteSVM with no mismatch, and two cases lie outside the program's limits (a level total above `u64`; 2000 ticks above `MAX_TICKS`). Those two are covered on chain by separate cases at the limits.

### 16.3 Conformance by class

- **Core**: implements §3 to §8 and §12 and reproduces the vectors with the fills its `claim` pays.
- **Verifier**: passes `runConformance` with no failures, and reproduces §13 on the sample proof of §13.3.
- **Indexer, Keeper, Integrator, Adapter**: no vectors exist for these classes. Their requirements (§9, §14) are checked in the reference repository by integration tests, not by a portable suite. A claim of conformance to these classes is therefore a self-declaration against the MUST statements.
- **Promise checker**: reproduces the promise vector of §15.7.

### 16.4 Adding vectors

The rules for adding vectors are in [sRFC-0001](sRFC-0001-process.md). A published vector file is never edited: new cases go in a new file.

## 17. Security considerations

This section states what the protocol is designed to guarantee, what it does not, and the status of the evidence. Nothing here is a claim of correctness or readiness.

### 17.1 Status

- **Devnet only.** Nothing is deployed to mainnet.
- **No external audit** has been done. One is required before any mainnet value (`docs/security/AUDIT_PACKAGE.md`, `docs/HUMAN_TASKS.md` H6).
- **Single-key upgrade authority** on devnet. Moving it behind a multisig with a timelock is rehearsed on LiteSVM, not done (ADR-0013). Until then the code of every program can be replaced by one key.
- The invariants below are enforced in code and exercised by tests and property tests (`docs/security/INVARIANTS.md`, 13 invariants; `docs/security/THREAT_MODEL.md`, 23 threats and the open gaps). They are not formally verified.
- Incentive compatibility of the rule is refuted for multi-unit buyers and not proven for single-unit buyers (§7.3).

### 17.2 Properties the code is designed to provide

- **One price.** Every filled order trades at `P*` (I1). No buyer pays above, and no seller receives below, their limit (I2).
- **Order independence.** The result is a function of the aggregates in the book, not of arrival order.
- **Refunds are always reachable.** A pause never blocks reveal, clear, claim or finalize (I11); a cross that does not print refunds every order in full (I8); an unrevealed sealed order refunds in full; a deferred-mint cross whose adapter fails refunds after a deadline.
- **No double payment.** Each order is paid exactly once: `claim` closes the account (I7).
- **Parameters are immutable.** Nothing writes the grid, windows, fees, guards, gate or oracle after `create_cross` (I10). The admin cannot change an existing cross's fees.
- **The vaults empty.** After a `finalize` that is given the accounts it needs (§6.4), both vaults are empty (I6); rounding favours the vault and the bond covers the difference (I5).
- **Fee ceiling.** The protocol fee is at most 100 bps and at most one fifth of a cross's total fees; nothing is charged on bids, cancels or refunds (I12).
- **Supply.** In the mint modes the base supply is created only at claim, equal to the filled quantity, and the mint authority is revoked at `finalize` if the cross printed (I9).

### 17.3 Properties that follow from the rule and are not defects of the code

- **Visible book.** In an open cross every order is public as it is placed. A late bidder sees the others. The uniform price means being early or late does not change the price paid, but it does let a bidder decide after seeing the book. There is no random or hidden close time.
- **Optional reveal.** In a sealed cross a bidder who has not revealed can watch other reveals land and then not reveal, for a full refund. The final book therefore depends on reveal decisions made after other reveals were public. Side, owner, escrow amount and timing are public even when price and quantity are not.
- **Capacity.** `orders_total` counts every order ever placed, including cancelled ones, against `max_orders`. Cancelled orders do not free capacity.
- **Oracle guard.** The caller of `clear` chooses which fully verified Pyth update within `max_staleness_secs` to pass, so among the updates that are valid at that moment the caller decides whether the price is judged divergent. A cross with an oracle guard cannot be cleared without an update. This follows from the rule; no test exercises an adversarial choice.
- **Identity.** The rule rations by size, not by identity, and the program has no per-identity cap. Identity gating (§10) is optional per cross and depends on the attester.
- **Issuer powers.** The program does not check mint extensions. A mint with a freeze authority, a pause authority, a transfer hook, a transfer fee or a permanent delegate can stall or tax escrow or settlement outside the program's control. The reference API and keeper check this; the program does not (§14.1).
- **Dust.** Rounding leaves less than `marginal_orders` atoms of base dust, which goes to `proceeds_base`. `finalize` refuses (`BaseDustAccountsMissing`) a call that leaves out the optional base accounts when the cross holds dust, so dust cannot be stranded by a careless caller (ADR-0025; `tests/core/test/finalize-dust.test.ts`). The quote vault is always swept.

### 17.4 Trust placed in operators

- The **admin** can change the fee schedule (capped), the fee recipient and the guardian, and can propose a successor. The **guardian** can pause new crosses and new orders. Neither can touch escrowed funds or an existing cross through the program's instructions; the upgrade authority can replace the program (§17.1).
- A **gate authority** controls passes and locks for its mint; a **calendar admin** controls sessions and feeds subject to the timelock of at least seven days.
- A **settler** controls whether a deferred-mint cross binds a mint; the deadline bounds the harm to a refund.
- An **RPC** or an **API** operator can serve stale or false data. A verifier MUST read from chain (§13) and not rely on the reference API's answer alone.

### 17.5 Reporting

There is no bug-bounty programme in the repository. Vulnerability reporting instructions are **not specified** here.

## 18. Versioning and compatibility

- **The identifier.** `OCIP-1` names this interface. Revisions of OCIP-1 are numbered (`Revision 1`, …) and listed in the changelog (Appendix C).
- **Document schemas** carry their own version in the schema string and are independent of the revision: `opening-cross/fairness-proof/v1`, `opening-cross/conformance/v1`, `opening-cross/promise/v1`, `opening-cross/router-quote/v1`, `opening-cross/best-execution/v1`. A change that removes or retypes a field of a published schema, or changes what a field means, requires a new schema version. Adding an optional field does not.
- **Programs.** A program id plus Anchor discriminators identify an interface. OCIP-1 is one program id per program, upgraded in place, with `migrate_protocol`-style instructions for account growth; it does not use versioned program ids. An instruction's discriminator changes only if its name changes. Account growth is handled by an explicit migration instruction: `migrate_protocol` zeroes every added byte, so a trailing `Option` field added later reads as `None`.
- **Breaking changes** (OCIP-2): any change that alters, for an input in a published vector, the price, matched volume, rationed side, any fill, any payment or any refund; removes or reorders arguments of an instruction; changes a seed; changes the commitment preimage; or changes an account's field order.
- **Compatible changes**: new instructions, new events, new error codes appended at the end, new account types, new vectors in new files, new routes of the non-normative API.
- **Consumers** MUST ignore unknown event discriminators (§14.2), SHOULD tolerate unknown enumeration variants by reporting them as unknown, and MUST NOT assume an account is exactly its current size (§3.5).
- **Vectors.** `v1.json` is immutable. A correction to an expected value in it is a breaking change to the standard and needs the process in sRFC-0001.
- **Known gaps between the specification and the product** are tracked row by row in `docs/FEATURE_STATUS.md`; this document does not repeat them.

## 19. The rules extension (revision 2)

Revision 2 adds rules to a cross without changing a revision 1 account or instruction. Everything in this section is in `programs/cross_core/src` (`ext.rs`, `rules.rs`, `orders.rs`, `draw.rs`, `identity.rs`, `lock.rs`, `neutral.rs`, `halt.rs`, `feed.rs`, `series.rs`, `refunds.rs`, `classbook.rs`, `create.rs`) and is decided in ADR-0450 to ADR-0462.

### 19.1 Compatibility

A cross created by revision 1 has no extension tail and behaves exactly as §5 to §7 say. An implementation of revision 2 MUST read such a cross as having every rule off, MUST NOT give it rules, and MUST settle it with the revision 2 instructions without any migration. The clearing rule of §7 is unchanged by every rule below except the supply cap (rule 1 of §19.5) and the marginal split by allocation class (rule 5 of §19.5), and both of those only change which orders are filled and by how much at the margin; the clearing price and the matched volume are still those of §7.3, computed on the capped supply. New `NoPrintReason` values and new errors are appended, so every revision 1 value keeps its meaning.

### 19.2 The extension tail

A cross created by revision 2 is allocated `8 + Cross::INIT_SPACE + CrossExt::INIT_SPACE` bytes: the `Cross` account of §3.7 and, immediately after its maximum encoded size, a Borsh-encoded `CrossExt` (§19.8) padded with zero bytes. The tail starts at byte offset `8 + Cross::INIT_SPACE` (the account index of §3.5 gives the size of the struct part). Its first byte is the version, `1`. A decoder MUST decode the tail only if the account is longer than the struct, the version byte is `1` and `rules_set` is true; otherwise the cross has no rules. The `Cross` struct is decoded as in §3.7, ignoring the tail; both Anchor's decoder and the generated clients do.

An `Order` account of a cross whose rules need a per-order record carries an `OrderExt` after its struct in the same way (version `1`). A cross without such rules creates orders of revision 1 size.

### 19.3 Setting the rules

`set_rules` (§19.9) writes the tail once. It MUST fail unless: the signer is `cross.creator` (`Unauthorized`); the cross has a tail (`LegacyCross`); the cluster slot equals `created_slot`, the slot in which `create_cross` ran, no order exists, the cross is `Live` and the rules were not set before (`RulesLocked`); and every field is consistent (`InvalidParams`, `GridPolicy`, `HaltMismatch`, `FeedMismatch`, `Unauthorized`, `WrongMint`, `CalendarMismatch`, `FeedNotApproved`). A client sends `create_cross` and `set_rules` in one transaction. A bidder reads the rules before its first order, and they cannot change afterwards.

### 19.4 Remaining accounts

The accounts a rule needs beyond an instruction's own list are passed as remaining accounts, in the order below. Each is checked against the stored rules; a missing or wrong one fails the instruction (`ApplicantMismatch`, `ClassBookMissing`, `LockupMismatch`, `HaltMismatch`, `WrongMint`, `FeedMismatch`, `OracleAccountMissing`, `CalendarMismatch`, `ReferralAccountMissing`) and never skips the rule.

| Instruction | Remaining accounts, in order |
|---|---|
| `set_rules` | the halt state (`FLAG_RESUMES_HALT`); the lender feed (`FLAG_FEEDS_LENDERS`); the creator's quote account, the quote vault, the quote mint and the quote token program (a bond); the base mint (`FLAG_GUARD_SCALED_UI`); the calendar (extra oracle feeds on a cross with a calendar) |
| `commit_order`, `commit_order_ext` | the applicant record (identity rules); the class book (classes or insiders); the priority pass (class 3 outside the early window) |
| `cancel_order` | the applicant record (identity rules); the class book (a revealed buy on a cross with a class book) |
| `reveal_order` | the class book (a buy on a cross with a class book) |
| `merge_shard` | none; auxiliary shards (index 32 to 47) are passed as the shard |
| `clear` | the halt state (`halt_source`); the base mint (`halt_source`, a supply to read, or `FLAG_GUARD_SCALED_UI`); the class book; the lender feed (`FLAG_FEEDS_LENDERS`); one account per extra oracle feed; the calendar (`off_hours_widen_bps > 0`) |
| `claim` | the lock vault and the lockup record, only for a fill that is locked |
| `finalize` | the referrer's quote token account (`referral.share_bps > 0` and a non-zero protocol fee) |
| `spawn_next` | the lender feed, the rules' other accounts as for `set_rules` |

### 19.5 The rules

1. **Print guards** (ADR-0451). In this order, a cleared cross does not print and every order is refunded when: the counted volume is below `min_matched` (`BelowMinimumVolume`); the imbalance exceeds the cap (`ImbalanceTooHigh`); `floor(counted · P* / price_scale) < min_raise_quote` (`BelowMinimumRaise`); `counted · 10,000 < min_float_bps · total_supply` (`FloatTooLow`); `total_supply · 100 > max_fdv_x100 · counted` (`FdvTooHigh`); `|P* − anchor| · 10,000 > move_bps · anchor` (`PriceMoved`). `counted` is the matched volume less the upper bound on declared insiders' allocation (rule 6 of §19.5). `total_supply` is declared, or the base mint's supply at the clear. A zero value switches a guard off. A positive `max_matched` caps the supply: `S(p)` and `S⁻(p)` of §7.2 become `min(·, max_matched)`. `FLAG_STANDARD_GRID` requires `2 · min_price ≥ grid_estimate`, `100 · tick ≤ grid_estimate` and the estimate on the grid (`GridPolicy`).
2. **Ending** (ADR-0452). With `ending_secs > 0` the last `ending_secs` before `close_ts` is cut into `buckets` equal windows; an order is placed in the bucket of the instant it lands and writes to shard `32 + bucket`. With `random_end`, a draw picks the last counted bucket, buckets after it are never merged (`BucketExcluded`) and their orders are refunded at claim. `cancel_order` fails (`CancelClosed`) from `close_ts − ending_secs − cancel_cutoff_secs`, and always for an order placed in an ending bucket or an extension. The draw is `draw_begin`, then `draw_finish` at least 20 slots later: the seed is `sha256("opening-cross/draw/v1" ‖ cross ‖ epoch ‖ purpose ‖ h1 ‖ h2 ‖ h3 ‖ h4)` of the `SlotHashes` entries for the first recorded slots at or after `begin + 4`, `+ 8`, `+ 12`, `+ 16`, each within 32 slots of its target; the end bucket is the first eight seed bytes, little-endian, modulo `buckets`. The draw is not a verifiable random function. With `extension_max_secs > 0`, a cross that fails any guard sets `ext_pending` instead of failing once; a second draw sets a new close `extension_min_secs + (seed[8..16] mod (extension_max_secs − extension_min_secs + 1))` seconds after the draw, orders placed then write to shards `40 + j` and cannot be cancelled, and the next clear is final. An extension nobody draws lets the cross clear as it stands three days after the reveal window.
3. **Identity** (ADR-0453). `identity.max_orders` and `identity.cap_quote` bound, per wallet holding the gate pass, the live orders and the quote escrowed in live buy orders. They require a gate on the cross.
4. **Locks** (ADR-0454). A fill with a cliff or a vesting length is paid to the lock vault and recorded in a `Lockup` of the order's nonce; `release_locked` pays `vested − released`, where `vested` is `0` before `start_ts + cliff_secs`, `amount` from then on if `vest_secs = 0`, and `floor(amount · (now − unlock) / vest_secs)` capped at `amount` otherwise.
5. **Allocation classes** (ADR-0453). The volume `R` of a rationed marginal buy tick is shared as in `clearing_core::alloc`: class 1 receives `reserve_bps[0]` of `R` (a lottery of whole lots when `lottery_unit > 0`, pro rata otherwise), classes 2 and 3 each receive `min(Q_c, R · reserve_bps / 10,000)` pro rata within the class, and the remainder is shared pro rata over everyone's remaining quantity. The lottery window starts at `seed[16..24] mod tickets`.
6. **Insiders** (ADR-0454). Declared insiders' buys are flagged, locked, and their allocation, bounded above, is left out of `counted`. A bond posted at `set_rules` is held in the quote vault for `challenge_secs` after the clear; the arbiter named by `set_arbiter` may slash it on a challenge; a challenge unanswered for 14 days expires (`expire_challenge`); `finalize` waits for the window and for no open challenge.
7. **Halt** (ADR-0455). A cross naming a halt state does not print while it is halted or flagged for a corporate action, nor while the mint is paused; only a printing cross created by the halt state's authority or venue signer with `FLAG_RESUMES_HALT` lifts a halt. A print by a publisher's cross with at least the feed's minimum volume updates the lender feed.
8. **Oracles** (ADR-0459). The reference is the median of the usable prices of the cross's guard and its extra feeds; the guard needs `quorum` usable prices and (if `max_spread_bps > 0`) their spread within it; the divergence bound is widened by `off_hours_widen_bps` while no session of the cross's calendar is open. `FLAG_GUARD_SCALED_UI` voids a print if the base mint's effective scaled-UI multiplier differs from the one recorded at `set_rules`.
9. **Referral** (ADR-0460). `finalize` pays `floor(protocol_fee · share_bps / 10,000)` to the referrer's quote account and the rest of the protocol fee to the fee recipient.
10. **Pushed refunds** (ADR-0457). `push_refunds` returns up to twelve orders whose settlement is a refund only, to their owners' token accounts for the escrowed mint, and fails for an order with a fill (`NotRefundOnly`).
11. **Series** (ADR-0456). `spawn_next` creates the next cross of a `Series` when due, with the series address as creator, the close computed from the interval or the calendar, and the series' rules.

### 19.6 Enumerations introduced by revision 2

<!-- ocip-gen:enums -->
- `ChallengeStatus`: 0 `Open`, 1 `Upheld`, 2 `Rejected`
- `HaltReason`: 0 `None`, 1 `IssuerPause`, 2 `VenueHalt`, 3 `CircuitBreaker`, 4 `CorporateAction`
- `ProposalKind`: 0 `Spend`, 1 `OpenNav`, 2 `CloseNav`
<!-- /ocip-gen:enums -->

### 19.7 Accounts introduced by revision 2

<!-- ocip-gen:accounts -->
#### `Applicant` (`cross_core`)

<!-- ocip:account Applicant -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `cross` | `Pubkey` | 32 | 8 |
| 2 | `owner` | `Pubkey` | 32 | 40 |
| 3 | `orders` | `u8` | 1 | 72 |
| 4 | `escrow` | `u64` | 8 | 73 |
| 5 | `bump` | `u8` | 1 | 81 |
<!-- /ocip:account -->

#### `ArbiterRegistry` (`cross_core`)

<!-- ocip:account ArbiterRegistry -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `arbiter` | `Pubkey` | 32 | 8 |
| 2 | `bump` | `u8` | 1 | 40 |
<!-- /ocip:account -->

#### `Challenge` (`cross_core`)

<!-- ocip:account Challenge -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `cross` | `Pubkey` | 32 | 8 |
| 2 | `id` | `u32` | 4 | 40 |
| 3 | `challenger` | `Pubkey` | 32 | 44 |
| 4 | `subject` | `Pubkey` | 32 | 76 |
| 5 | `evidence` | `[u8; 32]` | 32 | 108 |
| 6 | `deposit` | `u64` | 8 | 140 |
| 7 | `filed_ts` | `i64` | 8 | 148 |
| 8 | `status` | `ChallengeStatus` | 1 | 156 |
| 9 | `slashed` | `u64` | 8 | 157 |
| 10 | `bump` | `u8` | 1 | 165 |
<!-- /ocip:account -->

#### `ClassBook` (`cross_core`)

<!-- ocip:account ClassBook -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `cross` | `Pubkey` | 32 | 8 |
| 2 | `qty` | `[[u64; 256]; 3]` | 6144 | 40 |
| 3 | `tickets` | `[u32; 256]` | 1024 | 6184 |
| 4 | `insider_qty` | `[u64; 256]` | 2048 | 7208 |
<!-- /ocip:account -->

#### `HaltState` (`cross_core`)

<!-- ocip:account HaltState -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `base_mint` | `Pubkey` | 32 | 8 |
| 2 | `authority` | `Pubkey` | 32 | 40 |
| 3 | `venue_signer` | `Option<Pubkey>` | 33 | 72 |
| 4 | `halted` | `bool` | 1 | 105 |
| 5 | `reason` | `HaltReason` | 1 | 106 |
| 6 | `corporate_action` | `bool` | 1 | 107 |
| 7 | `since_ts` | `i64` | 8 | 108 |
| 8 | `since_slot` | `u64` | 8 | 116 |
| 9 | `issuer_unpaused` | `bool` | 1 | 124 |
| 10 | `breaker` | `Option<Breaker>` | 69 | 125 |
| 11 | `last_resume_cross` | `Option<Pubkey>` | 33 | 194 |
| 12 | `last_resume_price` | `u64` | 8 | 227 |
| 13 | `last_resume_ts` | `i64` | 8 | 235 |
| 14 | `bump` | `u8` | 1 | 243 |
<!-- /ocip:account -->

#### `Lockup` (`cross_core`)

<!-- ocip:account Lockup -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `cross` | `Pubkey` | 32 | 8 |
| 2 | `owner` | `Pubkey` | 32 | 40 |
| 3 | `nonce` | `u64` | 8 | 72 |
| 4 | `amount` | `u64` | 8 | 80 |
| 5 | `released` | `u64` | 8 | 88 |
| 6 | `start_ts` | `i64` | 8 | 96 |
| 7 | `cliff_secs` | `u32` | 4 | 104 |
| 8 | `vest_secs` | `u32` | 4 | 108 |
| 9 | `bump` | `u8` | 1 | 112 |
<!-- /ocip:account -->

#### `PrintFeed` (`cross_core`)

<!-- ocip:account PrintFeed -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `base_mint` | `Pubkey` | 32 | 8 |
| 2 | `quote_mint` | `Pubkey` | 32 | 40 |
| 3 | `authority` | `Pubkey` | 32 | 72 |
| 4 | `publishers` | `[Pubkey; 4]` | 128 | 104 |
| 5 | `publisher_count` | `u8` | 1 | 232 |
| 6 | `min_matched` | `u64` | 8 | 233 |
| 7 | `price` | `u64` | 8 | 241 |
| 8 | `price_scale` | `u64` | 8 | 249 |
| 9 | `matched` | `u64` | 8 | 257 |
| 10 | `cross` | `Pubkey` | 32 | 265 |
| 11 | `ts` | `i64` | 8 | 297 |
| 12 | `slot` | `u64` | 8 | 305 |
| 13 | `prints` | `u64` | 8 | 313 |
| 14 | `bump` | `u8` | 1 | 321 |
<!-- /ocip:account -->

#### `Series` (`cross_core`)

<!-- ocip:account Series -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `authority` | `Pubkey` | 32 | 8 |
| 2 | `series_id` | `u64` | 8 | 40 |
| 3 | `base_mint` | `Pubkey` | 32 | 48 |
| 4 | `quote_mint` | `Pubkey` | 32 | 80 |
| 5 | `base_token_program` | `Pubkey` | 32 | 112 |
| 6 | `quote_token_program` | `Pubkey` | 32 | 144 |
| 7 | `config` | `SeriesConfig` | 852 | 176 |
| 8 | `next_index` | `u64` | 8 | 1028 |
| 9 | `last_cross` | `Option<Pubkey>` | 33 | 1036 |
| 10 | `last_close_ts` | `i64` | 8 | 1069 |
| 11 | `last_price` | `u64` | 8 | 1077 |
| 12 | `active` | `bool` | 1 | 1085 |
| 13 | `bump` | `u8` | 1 | 1086 |
<!-- /ocip:account -->

#### `Grant` (`treasury`)

<!-- ocip:account Grant -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `treasury` | `Pubkey` | 32 | 8 |
| 2 | `id` | `u64` | 8 | 40 |
| 3 | `beneficiary` | `Pubkey` | 32 | 48 |
| 4 | `total` | `u64` | 8 | 80 |
| 5 | `released` | `u64` | 8 | 88 |
| 6 | `lockup_end` | `i64` | 8 | 96 |
| 7 | `expiry_ts` | `i64` | 8 | 104 |
| 8 | `milestones` | `[Milestone; 4]` | 16 | 112 |
| 9 | `milestone_count` | `u8` | 1 | 128 |
| 10 | `credential` | `Pubkey` | 32 | 129 |
| 11 | `schema` | `Pubkey` | 32 | 161 |
| 12 | `burned` | `bool` | 1 | 193 |
| 13 | `bump` | `u8` | 1 | 194 |
<!-- /ocip:account -->

#### `Position` (`treasury`)

<!-- ocip:account Position -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `treasury` | `Pubkey` | 32 | 8 |
| 2 | `owner` | `Pubkey` | 32 | 40 |
| 3 | `amount` | `u64` | 8 | 72 |
| 4 | `debt` | `u128` | 16 | 80 |
| 5 | `pending` | `u64` | 8 | 96 |
| 6 | `bump` | `u8` | 1 | 104 |
<!-- /ocip:account -->

#### `Proposal` (`treasury`)

<!-- ocip:account Proposal -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `treasury` | `Pubkey` | 32 | 8 |
| 2 | `id` | `u64` | 8 | 40 |
| 3 | `proposer` | `Pubkey` | 32 | 48 |
| 4 | `kind` | `ProposalKind` | 1 | 80 |
| 5 | `amount` | `u64` | 8 | 81 |
| 6 | `destination` | `Pubkey` | 32 | 89 |
| 7 | `desc_hash` | `[u8; 32]` | 32 | 121 |
| 8 | `created_ts` | `i64` | 8 | 153 |
| 9 | `vote_end_ts` | `i64` | 8 | 161 |
| 10 | `executable_ts` | `i64` | 8 | 169 |
| 11 | `expires_ts` | `i64` | 8 | 177 |
| 12 | `yes` | `u64` | 8 | 185 |
| 13 | `no` | `u64` | 8 | 193 |
| 14 | `executed` | `bool` | 1 | 201 |
| 15 | `bump` | `u8` | 1 | 202 |
<!-- /ocip:account -->

#### `RoundRecord` (`treasury`)

<!-- ocip:account RoundRecord -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `treasury` | `Pubkey` | 32 | 8 |
| 2 | `round` | `u64` | 8 | 40 |
| 3 | `revenue` | `u64` | 8 | 48 |
| 4 | `due` | `u64` | 8 | 56 |
| 5 | `missed` | `bool` | 1 | 64 |
| 6 | `tranche_released` | `bool` | 1 | 65 |
| 7 | `bump` | `u8` | 1 | 66 |
<!-- /ocip:account -->

#### `VoteRecord` (`treasury`)

<!-- ocip:account VoteRecord -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `proposal` | `Pubkey` | 32 | 8 |
| 2 | `voter` | `Pubkey` | 32 | 40 |
| 3 | `yes` | `u64` | 8 | 72 |
| 4 | `no` | `u64` | 8 | 80 |
| 5 | `bump` | `u8` | 1 | 88 |
<!-- /ocip:account -->
<!-- /ocip-gen:accounts -->

### 19.8 Nested types

<!-- ocip-gen:structs -->
<!-- ocip:struct AllocationRules -->
**`AllocationRules`** (`cross_core`)

| Field | Type |
|---|---|
| `reserve_bps` | `[u16; 3]` |
| `small_cap_quote` | `u64` |
| `lottery_unit` | `u64` |
| `min_lock_secs` | `u32` |
| `lock_vest_secs` | `u32` |
| `early_until_ts` | `i64` |
| `priority_gate` | `Option<Pubkey>` |
| `class1_cliff_secs` | `u32` |
| `class1_vest_secs` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct Breaker -->
**`Breaker`** (`cross_core`)

| Field | Type |
|---|---|
| `feed_id` | `[u8; 32]` |
| `window_slots` | `u32` |
| `move_bps` | `u32` |
| `last_price` | `i64` |
| `last_exponent` | `i32` |
| `last_slot` | `u64` |
| `last_publish_ts` | `i64` |
<!-- /ocip:struct -->

<!-- ocip:struct BreakerSetup -->
**`BreakerSetup`** (`cross_core`)

| Field | Type |
|---|---|
| `feed_id` | `[u8; 32]` |
| `window_slots` | `u32` |
| `move_bps` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct ClearingExt -->
**`ClearingExt`** (`cross_core`)

| Field | Type |
|---|---|
| `class_qty` | `[u64; 3]` |
| `tickets` | `u32` |
| `rho` | `u32` |
| `cleared_ts` | `i64` |
| `insider_ub` | `u64` |
<!-- /ocip:struct -->

<!-- ocip:struct CommitOrderExtArgs -->
**`CommitOrderExtArgs`** (`cross_core`)

| Field | Type |
|---|---|
| `nonce` | `u64` |
| `side` | `OrderSide` |
| `escrow` | `u64` |
| `commitment` | `[u8; 32]` |
| `price` | `u64` |
| `quantity` | `u64` |
| `order_bump` | `u8` |
| `class` | `u8` |
| `lock_secs` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct CompactRules -->
**`CompactRules`** (`cross_core`)

| Field | Type |
|---|---|
| `flags` | `u16` |
| `guards` | `GuardRules` |
| `ending` | `EndingRules` |
| `identity` | `IdentityRules` |
| `alloc` | `AllocationRules` |
| `neutrality` | `NeutralityInput` |
| `referral` | `ReferralRules` |
| `oracle_set` | `OracleSetInput` |
<!-- /ocip:struct -->

<!-- ocip:struct CrossExt -->
**`CrossExt`** (`cross_core`)

| Field | Type |
|---|---|
| `version` | `u8` |
| `rules_set` | `bool` |
| `created_slot` | `u64` |
| `flags` | `u16` |
| `guards` | `GuardRules` |
| `ending` | `EndingRules` |
| `draw` | `DrawState` |
| `identity` | `IdentityRules` |
| `alloc` | `AllocationRules` |
| `neutrality` | `NeutralityRules` |
| `neutral_state` | `NeutralityState` |
| `clearing` | `ClearingExt` |
| `referral` | `ReferralRules` |
| `oracle_set` | `OracleSet` |
<!-- /ocip:struct -->

<!-- ocip:struct DrawState -->
**`DrawState`** (`cross_core`)

| Field | Type |
|---|---|
| `epoch` | `u8` |
| `pending_slot` | `u64` |
| `pending_purpose` | `u8` |
| `seed` | `[u8; 32]` |
| `seed_epoch` | `u8` |
| `seed_ready` | `bool` |
| `end_bucket` | `u8` |
| `ext_pending` | `bool` |
| `extension_used` | `bool` |
| `aux_merged` | `u64` |
<!-- /ocip:struct -->

<!-- ocip:struct EndingRules -->
**`EndingRules`** (`cross_core`)

| Field | Type |
|---|---|
| `ending_secs` | `u32` |
| `buckets` | `u8` |
| `cancel_cutoff_secs` | `u32` |
| `random_end` | `bool` |
| `extension_min_secs` | `u32` |
| `extension_max_secs` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct GuardRules -->
**`GuardRules`** (`cross_core`)

| Field | Type |
|---|---|
| `min_raise_quote` | `u64` |
| `max_matched` | `u64` |
| `total_supply` | `u64` |
| `min_float_bps` | `u16` |
| `max_fdv_x100` | `u32` |
| `anchor_price` | `u64` |
| `move_bps` | `u16` |
| `grid_estimate` | `u64` |
| `halt_source` | `Option<Pubkey>` |
| `multiplier_bits` | `u64` |
<!-- /ocip:struct -->

<!-- ocip:struct IdentityRules -->
**`IdentityRules`** (`cross_core`)

| Field | Type |
|---|---|
| `cap_quote` | `u64` |
| `max_orders` | `u8` |
<!-- /ocip:struct -->

<!-- ocip:struct NeutralityInput -->
**`NeutralityInput`** (`cross_core`)

| Field | Type |
|---|---|
| `insiders` | `Vec<Pubkey>` |
| `insider_cliff_secs` | `u32` |
| `insider_vest_secs` | `u32` |
| `bond_quote` | `u64` |
| `challenge_secs` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct NeutralityRules -->
**`NeutralityRules`** (`cross_core`)

| Field | Type |
|---|---|
| `insiders` | `[Pubkey; 8]` |
| `insider_count` | `u8` |
| `insider_cliff_secs` | `u32` |
| `insider_vest_secs` | `u32` |
| `bond_quote` | `u64` |
| `challenge_secs` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct NeutralityState -->
**`NeutralityState`** (`cross_core`)

| Field | Type |
|---|---|
| `bond_held` | `u64` |
| `slashed` | `u64` |
| `open_challenges` | `u16` |
| `challenges` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct OracleSet -->
**`OracleSet`** (`cross_core`)

| Field | Type |
|---|---|
| `extra_feeds` | `[[u8; 32]; 2]` |
| `extra_count` | `u8` |
| `quorum` | `u8` |
| `max_spread_bps` | `u32` |
| `off_hours_widen_bps` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct OracleSetInput -->
**`OracleSetInput`** (`cross_core`)

| Field | Type |
|---|---|
| `extra_feeds` | `Vec<[u8; 32]>` |
| `quorum` | `u8` |
| `max_spread_bps` | `u32` |
| `off_hours_widen_bps` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct OrderExt -->
**`OrderExt`** (`cross_core`)

| Field | Type |
|---|---|
| `version` | `u8` |
| `epoch` | `u8` |
| `bucket` | `u8` |
| `class` | `u8` |
| `flags` | `u8` |
| `lock_cliff` | `u32` |
| `lock_vest` | `u32` |
| `placed_ts` | `i64` |
| `ticket` | `u32` |
<!-- /ocip:struct -->

<!-- ocip:struct ReferralRules -->
**`ReferralRules`** (`cross_core`)

| Field | Type |
|---|---|
| `referrer` | `Pubkey` |
| `share_bps` | `u16` |
<!-- /ocip:struct -->

<!-- ocip:struct RulesInput -->
**`RulesInput`** (`cross_core`)

| Field | Type |
|---|---|
| `flags` | `u16` |
| `guards` | `GuardRules` |
| `ending` | `EndingRules` |
| `identity` | `IdentityRules` |
| `alloc` | `AllocationRules` |
| `neutrality` | `NeutralityRules` |
| `referral` | `ReferralRules` |
| `oracle_set` | `OracleSet` |
<!-- /ocip:struct -->

<!-- ocip:struct SeriesConfig -->
**`SeriesConfig`** (`cross_core`)

| Field | Type |
|---|---|
| `kind` | `CrossKind` |
| `disclosure` | `Disclosure` |
| `price_scale` | `u64` |
| `grid` | `SeriesGrid` |
| `start_ts` | `i64` |
| `interval_secs` | `i64` |
| `calendar` | `Option<Pubkey>` |
| `call_secs` | `i64` |
| `reveal_secs` | `i64` |
| `min_matched` | `u64` |
| `max_imbalance_bps` | `Option<u32>` |
| `integrator_fee_bps` | `u16` |
| `integrator` | `Pubkey` |
| `gate_mint` | `Option<Pubkey>` |
| `shards` | `u8` |
| `max_orders` | `u32` |
| `proceeds_to` | `Pubkey` |
| `oracle` | `Option<OracleGuard>` |
| `max_crosses` | `u64` |
| `rules` | `RulesInput` |
<!-- /ocip:struct -->

<!-- ocip:struct SeriesGrid -->
**`SeriesGrid`** (`cross_core`)

| Field | Type |
|---|---|
| `relative` | `bool` |
| `min_price` | `u64` |
| `tick` | `u64` |
| `ticks` | `u16` |
| `tick_bps` | `u16` |
| `center` | `u64` |
<!-- /ocip:struct -->

<!-- ocip:struct SasRequirement -->
**`SasRequirement`** (`cross_gate`)

| Field | Type |
|---|---|
| `credential` | `Pubkey` |
| `schema` | `Pubkey` |
<!-- /ocip:struct -->

<!-- ocip:struct PendingAdmin -->
**`PendingAdmin`** (`cross_calendar`)

| Field | Type |
|---|---|
| `admin` | `Pubkey` |
| `eta` | `i64` |
<!-- /ocip:struct -->

<!-- ocip:struct PendingUpdate -->
**`PendingUpdate`** (`cross_calendar`)

| Field | Type |
|---|---|
| `sessions` | `Vec<Session>` |
| `feeds` | `Vec<[u8; 32]>` |
| `eta` | `i64` |
<!-- /ocip:struct -->

<!-- ocip:struct Session -->
**`Session`** (`cross_calendar`)

| Field | Type |
|---|---|
| `start_ts` | `i64` |
| `end_ts` | `i64` |
<!-- /ocip:struct -->

<!-- ocip:struct ExtParams -->
**`ExtParams`** (`treasury`)

| Field | Type |
|---|---|
| `vote_period_secs` | `i64` |
| `timelock_secs` | `i64` |
| `quorum_bps` | `u16` |
| `threshold_bps` | `u16` |
| `max_proposal_bps` | `u16` |
| `proposer_min_bps` | `u16` |
| `min_lockup_secs` | `i64` |
| `nav_period_secs` | `i64` |
| `nav_cap_bps` | `u16` |
| `insiders` | `[Pubkey; 4]` |
| `stream_secs` | `i64` |
| `rev_share_bps` | `u16` |
| `rev_credential` | `Pubkey` |
| `rev_schema` | `Pubkey` |
| `round_secs` | `i64` |
| `rev_start` | `i64` |
| `pay_grace_secs` | `i64` |
| `tranche_min_revenue` | `u64` |
| `tranche_amount` | `u64` |
| `disclosure_period_secs` | `i64` |
| `request_min_bps` | `u16` |
| `assign_required` | `bool` |
| `assign_credential` | `Pubkey` |
| `assign_schema` | `Pubkey` |
| `window_secs` | `i64` |
| `recovery` | `Pubkey` |
<!-- /ocip:struct -->

<!-- ocip:struct GrantParams -->
**`GrantParams`** (`treasury`)

| Field | Type |
|---|---|
| `beneficiary` | `Pubkey` |
| `total` | `u64` |
| `lockup_end` | `i64` |
| `expiry_ts` | `i64` |
| `milestones` | `[Milestone; 4]` |
| `milestone_count` | `u8` |
| `credential` | `Pubkey` |
| `schema` | `Pubkey` |
<!-- /ocip:struct -->

<!-- ocip:struct Milestone -->
**`Milestone`** (`treasury`)

| Field | Type |
|---|---|
| `bps` | `u16` |
| `requires_attestation` | `bool` |
| `released` | `bool` |
<!-- /ocip:struct -->
<!-- /ocip-gen:structs -->

### 19.9 Instructions introduced by revision 2

<!-- ocip-gen:ix-cross_core -->
#### `challenge_insider`

Alleges that `subject` was an undeclared insider; posts a deposit (ADR-0454).

<!-- ocip:ix cross_core challenge_insider -->
Discriminator `32b38b720dc2e17c`. Arguments: `subject: Pubkey`, `evidence: [u8; 32]`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `challenger` | WS |  |
| 2 | `cross` | W |  |
| 3 | `challenge` | W |  |
| 4 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `close_applicant`

Returns an applicant record's rent to its owner once the cross is finalized.

<!-- ocip:ix cross_core close_applicant -->
Discriminator `75bbd9c14c6e709d`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `owner` | W |  |
| 3 | `applicant` | W |  |
<!-- /ocip:ix -->

#### `commit_order_ext`

`commit_order` with an allocation class and a lock (ADR-0453, ADR-0454).

<!-- ocip:ix cross_core commit_order_ext -->
Discriminator `1b5f4b78ee474af0`. Arguments: `args: CommitOrderExtArgs`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `owner` | WS |  |
| 2 | `protocol` | – | PDA ["protocol"] |
| 3 | `cross` | W |  |
| 4 | `order` | W |  |
| 5 | `shard` | WO |  |
| 6 | `pass` | O |  |
| 7 | `escrow_mint` | – |  |
| 8 | `escrow_vault` | W |  |
| 9 | `owner_escrow` | W |  |
| 10 | `escrow_token_program` | – |  |
| 11 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `create_series`

Creates a recurring series of escrow crosses (ADR-0456).

<!-- ocip:ix cross_core create_series -->
Discriminator `b5093478c5dd2a8e`. Arguments: `series_id: u64`, `config: SeriesConfig`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `authority` | WS |  |
| 2 | `series` | W | PDA ["series", authority, series_id] |
| 3 | `base_mint` | – |  |
| 4 | `quote_mint` | – |  |
| 5 | `base_token_program` | – |  |
| 6 | `quote_token_program` | – |  |
| 7 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `draw_begin`

Starts the draw that closes an epoch or sets the extension length (ADR-0452). Anyone may call it once the call, and any reveal window, is over.

<!-- ocip:ix cross_core draw_begin -->
Discriminator `ecbed0feadfdbd2b`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | W |  |
<!-- /ocip:ix -->

#### `draw_finish`

Finishes a draw from the block hashes that followed `draw_begin`, and applies it.

<!-- ocip:ix cross_core draw_finish -->
Discriminator `2491c96ecf6a982d`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | W |  |
| 2 | `slot_hashes` | – | address `SysvarS1otHashes111111111111111111111111111` |
<!-- /ocip:ix -->

#### `expire_challenge`

Anyone closes an insider challenge the arbiter has not ruled on within fourteen days; the challenger's deposit returns and the bond is untouched.

<!-- ocip:ix cross_core expire_challenge -->
Discriminator `495214e3d8423a29`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | W |  |
| 2 | `challenge` | W |  |
| 3 | `challenger` | W |  |
<!-- /ocip:ix -->

#### `init_class_book`

Creates the class book a cross with allocation classes or declared insiders needs.

<!-- ocip:ix cross_core init_class_book -->
Discriminator `b50a1b7331ebae38`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `cross` | – |  |
| 3 | `class_book` | W | PDA ["classes", cross] |
| 4 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `init_halt_state`

Registers the halt state of a base mint (ADR-0455). Signed by the mint authority or the protocol admin.

<!-- ocip:ix cross_core init_halt_state -->
Discriminator `7d63fab7602ea61a`. Arguments: `venue_signer: Option<Pubkey>`, `breaker: Option<BreakerSetup>`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `authority` | WS |  |
| 2 | `base_mint` | – |  |
| 3 | `protocol` | – | PDA ["protocol"] |
| 4 | `halt` | W | PDA ["halt", base_mint] |
| 5 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `init_lock_vault`

Creates the vault that holds the cross's locked tokens.

<!-- ocip:ix cross_core init_lock_vault -->
Discriminator `201d07bdffc742ab`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `cross` | – |  |
| 3 | `base_mint` | – |  |
| 4 | `lock_vault` | W | PDA ["lock_vault", cross] |
| 5 | `base_token_program` | – |  |
| 6 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `init_print_feed`

Registers the lender price feed of a base mint (ADR-0451).

<!-- ocip:ix cross_core init_print_feed -->
Discriminator `51deb4f1731f7377`. Arguments: `publishers: Vec<Pubkey>`, `min_matched: u64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `authority` | WS |  |
| 2 | `base_mint` | – |  |
| 3 | `quote_mint` | – |  |
| 4 | `protocol` | – | PDA ["protocol"] |
| 5 | `feed` | W | PDA ["print_feed", base_mint] |
| 6 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `log_ext`

Emits the cross's extension tail as an event (permissionless, read-only).

<!-- ocip:ix cross_core log_ext -->
Discriminator `a3ce08799f8a6221`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
<!-- /ocip:ix -->

#### `observe_price`

Anyone feeds a verified oracle update to the asset's circuit breaker.

<!-- ocip:ix cross_core observe_price -->
Discriminator `93b204150ed5519f`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `halt` | W |  |
| 2 | `price_update` | – |  |
<!-- /ocip:ix -->

#### `push_refunds`

Refunds up to twelve orders that are owed nothing but their escrow (a cross that did not print, or orders that were not filled) in one transaction, to their owners' own token accounts. Anyone may call it.

<!-- ocip:ix cross_core push_refunds -->
Discriminator `e3083d1aaddec719`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | W |  |
| 2 | `quote_mint` | – |  |
| 3 | `quote_vault` | W | PDA ["quote_vault", cross] |
| 4 | `base_mint` | O |  |
| 5 | `base_vault` | WO | PDA ["base_vault", cross] |
| 6 | `quote_token_program` | – |  |
| 7 | `base_token_program` | – |  |
<!-- /ocip:ix -->

#### `release_locked`

Pays the vested part of a lockup to its owner. Anyone may call it.

<!-- ocip:ix cross_core release_locked -->
Discriminator `43af87ee17bf823c`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `cross` | – |  |
| 2 | `owner` | W |  |
| 3 | `lockup` | W |  |
| 4 | `lock_vault` | W | PDA ["lock_vault", cross] |
| 5 | `base_mint` | – |  |
| 6 | `owner_base` | W |  |
| 7 | `base_token_program` | – |  |
<!-- /ocip:ix -->

#### `resolve_challenge`

The arbiter rules on a challenge, slashing part of the bond when it is upheld.

<!-- ocip:ix cross_core resolve_challenge -->
Discriminator `51bf7c7783f89d6d`. Arguments: `upheld: bool`, `slash: u64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `arbiter` | S |  |
| 2 | `registry` | – | PDA ["arbiter"] |
| 3 | `cross` | W |  |
| 4 | `challenge` | W |  |
| 5 | `challenger` | W |  |
| 6 | `fee_recipient` | W |  |
| 7 | `quote_mint` | – |  |
| 8 | `quote_vault` | W | PDA ["quote_vault", cross] |
| 9 | `challenger_quote` | W |  |
| 10 | `fee_recipient_quote` | W |  |
| 11 | `quote_token_program` | – |  |
<!-- /ocip:ix -->

#### `series_withdraw`

The series' authority withdraws tokens the series holds.

<!-- ocip:ix cross_core series_withdraw -->
Discriminator `72f66ca6d0f0aaae`. Arguments: `amount: u64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `authority` | S |  |
| 2 | `series` | – |  |
| 3 | `mint` | – |  |
| 4 | `from` | W |  |
| 5 | `to` | W |  |
| 6 | `token_program` | – |  |
<!-- /ocip:ix -->

#### `set_arbiter`

The protocol admin names the arbiter that rules on insider challenges.

<!-- ocip:ix cross_core set_arbiter -->
Discriminator `0fcdc2b4acd571d3`. Arguments: `arbiter: Pubkey`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `admin` | WS |  |
| 2 | `protocol` | – | PDA ["protocol"] |
| 3 | `registry` | W | PDA ["arbiter"] |
| 4 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `set_corporate_action`

The issuer authority flags or unflags a corporate action.

<!-- ocip:ix cross_core set_corporate_action -->
Discriminator `5c0a689a2b30c45a`. Arguments: `flag: bool`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `signer` | S |  |
| 2 | `halt` | W |  |
<!-- /ocip:ix -->

#### `set_feed_publishers`

Changes who may publish to a lender price feed, and the minimum print size.

<!-- ocip:ix cross_core set_feed_publishers -->
Discriminator `776f91d3490f9d9a`. Arguments: `publishers: Vec<Pubkey>`, `min_matched: u64`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `authority` | S |  |
| 2 | `feed` | W |  |
<!-- /ocip:ix -->

#### `set_halt`

The issuer authority or the venue signer halts the asset. Only a printing resume cross lifts the halt.

<!-- ocip:ix cross_core set_halt -->
Discriminator `d4c0b3421749c50f`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `signer` | S |  |
| 2 | `halt` | W |  |
<!-- /ocip:ix -->

#### `set_rules`

Fixes the rules of a cross (ADR-0450): the creator, in the slot the cross was created in, before any order exists. Remaining accounts: the lender print feed when the cross feeds it.

<!-- ocip:ix cross_core set_rules -->
Discriminator `4294c42be8d2aea9`. Arguments: `input: CompactRules`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `creator` | WS |  |
| 2 | `cross` | W |  |
<!-- /ocip:ix -->

#### `set_series_active`

The series' authority pauses or resumes spawning.

<!-- ocip:ix cross_core set_series_active -->
Discriminator `2fa403c9b1d49fdf`. Arguments: `active: bool`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `authority` | S |  |
| 2 | `series` | W |  |
<!-- /ocip:ix -->

#### `spawn_next`

Spawns the next cross of a series when it is due. Permissionless. Remaining accounts: the lender print feed, when the series' rules feed it.

<!-- ocip:ix cross_core spawn_next -->
Discriminator `00547321e4e0416d`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `payer` | WS |  |
| 2 | `protocol` | – | PDA ["protocol"] |
| 3 | `series` | W |  |
| 4 | `cross` | W | PDA ["cross", series, series.next_index] |
| 5 | `book` | W | PDA ["book", cross] |
| 6 | `base_mint` | – |  |
| 7 | `quote_mint` | – |  |
| 8 | `quote_vault` | W | PDA ["quote_vault", cross] |
| 9 | `base_vault` | W | PDA ["base_vault", cross] |
| 10 | `series_quote` | W |  |
| 11 | `previous` | O |  |
| 12 | `calendar_account` | O |  |
| 13 | `base_token_program` | – |  |
| 14 | `quote_token_program` | – |  |
| 15 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

#### `sync_pause`

Anyone copies the mint's pause state into its halt state.

<!-- ocip:ix cross_core sync_pause -->
Discriminator `4064d0cc9b84312a`. Arguments: none.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `halt` | W |  |
| 2 | `base_mint` | – |  |
<!-- /ocip:ix -->
<!-- /ocip-gen:ix-cross_core -->

### 19.10 Conformance

`packages/verifier/conformance/v2.json` (`opening-cross/conformance/v2`) covers rules 1 and 5 and the insider bound of rule 6: a case gives the grid, the orders with their classes, the rules and the expected price, volume, fills or refusal. It is generated by `cargo run -p clearing-core --example conformance_vectors_v2` from the code that runs on chain, and `packages/verifier` reproduces every case with an independent implementation (`packages/verifier/src/reference2.ts`). A fairness proof of a cross with rules has schema `opening-cross/fairness-proof/v2` and adds the rules, the draw and the allocation figures to the fields of §13.3. Its JSON Schema is `packages/verifier/schema/fairness-proof.v2.schema.json`; the schema of version 1 is unchanged and a cross without rules still gets version 1. Version 2 also carries `rules.ending` (the ending period and the last counted bucket), `rules.checks` (what was re-derived from the account beyond the clearing: that the main shards and exactly the auxiliary shards the drawn end requires were merged, and that the recorded last counted bucket is the first word of the draw's seed modulo the number of buckets; a check is `null` when the seed it needs was replaced by a later draw and the `DrawFinished` event was not supplied) and `rules.limits` (what the proof does not establish: that the block hashes behind a draw were honest, a no-print reason that depends on the state of the asset or on an oracle update at the moment of the clear, and per-order fills). A proof with a failed check is not verified.

`packages/verifier/conformance/v3.json` (`opening-cross/conformance/v3`) covers the functions around the clearing rule that decide which orders it clears: the ending bucket an order lands in (`CrossExt::placement`), the auxiliary shards a clear requires (`required_aux`), the bucket a draw leaves out, the three words a draw's seed decides (the last counted bucket, an extension's length, where the lottery starts) and the vesting of a lock (`Lockup::vested`). It is written by `packages/verifier/conformance/generate_v3.py` with Python integers from the specification and the program source; **it is not generated by running the Rust code**, and the file says so. Its placement cases tagged `rust-unit-test` repeat the assertions of the Rust unit test of `placement`. `packages/verifier/src/ending.ts` reproduces every case.

## Appendix A. Public read API (non-normative)

The reference deployment serves a read API (`services/api/src/server.ts`, Fastify). Everything below is informative: no conformance class requires it, a Verifier MUST NOT trust it over the chain, and routes may change. Integers in responses are decimal strings (`bigint` fields are serialized as strings and byte arrays as hex). Errors are a 4xx or 5xx status with `{ "error": "…" }`. A per-address rate limit may answer `429` with `retry-after`. All routes accept GET unless the table says otherwise. Transaction routes return unsigned transactions; the API holds no keys.

<!-- ocip-routes:begin -->
| Method | Route | Purpose |
|---|---|---|
| GET | `/v1/health` | Indexed slot, indexer heartbeat, reconciliation alerts in the last hour |
| GET | `/v1/stats` | Protocol totals and the network they were counted on |
| GET | `/v1/metrics/execution` | What bidders got across finalized crosses that printed |
| GET | `/v1/metrics/fairness` | Concentration of fills across wallets, with an interval |
| GET | `/v1/metrics/external-flow` | Share of flow from wallets that are not the operator's |
| GET | `/v1/crosses` | List crosses (`state`, `limit` 1 to 200) |
| GET | `/v1/crosses/:address` | One cross read from chain, with fairness and mint safety when available |
| GET | `/v1/crosses/:address/orders` | Indexed orders with fills |
| GET | `/v1/crosses/:address/book` | The resting book and the price it would clear at now |
| GET | `/v1/crosses/:address/proof` | The fairness proof of §13 |
| GET | `/v1/crosses/:address/promise` | The latest signed promise for a cross |
| GET | `/v1/crosses/:address/authenticity` | Whether each token of the cross is the issuer's real token (mainnet mints) |
| GET | `/v1/promises/signer` | The key that signs promises |
| GET | `/v1/promises/:id` | A signed promise with its grade and anchor proof |
| GET | `/v1/promises/:id/inputs` | The inputs document of §15.4 |
| GET | `/v1/accuracy` | Every signed promise counted by outcome |
| GET | `/v1/tokens/:mint/safety` | What the issuer of a mint can do to escrowed balances |
| GET | `/v1/tokens/:mint/authenticity` | Whether a mint is the issuer's real token (mainnet mints) |
| GET | `/v1/premium/summary` | Stock-token premium by order size and session |
| GET | `/v1/premium/latest` | The newest premium measurement per token |
| GET | `/v1/orders` | Orders by address, at most 100 (`addresses`) |
| GET | `/v1/orders/:address` | One order |
| GET | `/v1/owners/:owner/orders` | All orders of one wallet |
| GET | `/v1/router/quote` | Ranked venues for one order |
| POST | `/v1/route/quote` | Best execution for one order on one cross |
| GET | `/v1/replay/:address` | Every on-chain event of one cross in order |
| GET | `/v1/replay` | Recent crosses with outcome and timings |
| POST | `/v1/tx/place-order` | Unsigned transaction: `commit_order` |
| POST | `/v1/tx/cancel` | Unsigned transaction: `cancel_order` |
| POST | `/v1/tx/reveal` | Unsigned transaction: `reveal_order` |
| POST | `/v1/tx/settle` | Unsigned transactions: `merge_shard` for each shard, then `clear` |
| POST | `/v1/tx/claim` | Unsigned transaction: `claim` |
| POST | `/v1/tx/finalize` | Unsigned transaction: `finalize` |
| POST | `/v1/tx/init-shards` | Unsigned transactions: the missing `init_shard` instructions |
| POST | `/v1/tx/create-cross` | Unsigned transactions: `create_cross` and the shards, after a mint-safety check |
| WS | `/v1/stream` | A WebSocket of every event as the indexer commits it (`?cross=` filters) |
<!-- ocip-routes:end -->

`GET /v1/crosses/:address` returns a presentation of the cross: `state`, `disclosure` (`sealed` or `open`), `supplyMode` (`escrow`, `mint` or `deferred-mint`), `kind`, the window, the grid, decimals, fees, order counts, `clearing` (`price`, `matched`, `rationed`), `noPrintReason` as a name, `gateMint` and `oracleGuard`. Only accounts owned by `cross_core` with the right discriminator are ever decoded.

The reference deployment at the time of writing is a devnet instance; its base URLs are published in `apps/web/public/llms.txt` and may change.

## Appendix B. The `treasury` program (informative)

`treasury` is a companion program for ownership coins (ADR-0014). It is not required by any OCIP-1 conformance class and is described only so that its interface is complete. One treasury per coin mint holds quote tokens in a vault owned by the treasury PDA. The team spends at most `allowance` per `period_secs`, only while a Solana Attestation Service attestation for the treasury is live; if the attestation lapses for `grace_secs`, anyone may trigger liquidation, which freezes spending and snapshots the vault and the coin supply, after which holders redeem coins for a pro-rata share. The coin's mint authority must already be revoked (`SupplyNotFixed`), which a launched cross satisfies after `finalize`.

<!-- ocip:account Treasury -->
| # | Field | Type | Size | Offset |
|---|---|---|---|---|
| 1 | `authority` | `Pubkey` | 32 | 8 |
| 2 | `coin_mint` | `Pubkey` | 32 | 40 |
| 3 | `quote_mint` | `Pubkey` | 32 | 72 |
| 4 | `quote_decimals` | `u8` | 1 | 104 |
| 5 | `allowance` | `u64` | 8 | 105 |
| 6 | `period_secs` | `i64` | 8 | 113 |
| 7 | `period_start` | `i64` | 8 | 121 |
| 8 | `spent_in_period` | `u64` | 8 | 129 |
| 9 | `credential` | `Pubkey` | 32 | 137 |
| 10 | `schema` | `Pubkey` | 32 | 169 |
| 11 | `grace_secs` | `i64` | 8 | 201 |
| 12 | `lapsed_since` | `Option<i64>` | 9 | 209 |
| 13 | `state` | `TreasuryState` | 1 | 218 |
| 14 | `snapshot_vault` | `u64` | 8 | 219 |
| 15 | `snapshot_supply` | `u64` | 8 | 227 |
| 16 | `bump` | `u8` | 1 | 235 |
| 17 | `vault_bump` | `u8` | 1 | 236 |
<!-- /ocip:account -->

<!-- ocip:struct TreasuryParams -->
**`TreasuryParams`**

| Field | Type |
|---|---|
| `allowance` | `u64` |
| `period_secs` | `i64` |
| `grace_secs` | `i64` |
| `credential` | `Pubkey` |
| `schema` | `Pubkey` |
<!-- /ocip:struct -->

- `TreasuryState`: 0 `Active`, 1 `Liquidating`

| Instruction | Effect |
|---|---|
| `create_treasury(params)` | Creates the treasury and its vault; `allowance > 0`, `period_secs > 0`, `grace_secs ≥ 0` (`InvalidParams`) |
| `spend(amount)` | Authority only; fails while liquidating (`Liquidating`), without a live attestation (`NotAttested`), or above the period's remaining allowance (`OverAllowance`). Whole elapsed periods roll forward; unspent allowance does not carry over |
| `record_lapse` | Anyone; records that the attestation is not live and starts the grace clock once (`StillAttested` if it is live) |
| `record_attested` | Anyone; clears a recorded lapse once a live attestation is back (`NotAttested` otherwise) |
| `trigger_liquidation` | Anyone; after `grace_secs` of lapse (`NoLapse`, `GraceNotOver`); snapshots the vault balance and the coin supply |
| `redeem(amount)` | A holder burns `amount` coins for `floor(snapshot_vault · amount / snapshot_supply)` quote atoms (`NotLiquidating`; `amount > 0`, `InvalidParams`) |

<!-- ocip:ix treasury create_treasury -->
Discriminator `fe62d93319588c2d`. Arguments: `params: TreasuryParams`.

| # | Account | Flags | Notes |
|---|---|---|---|
| 1 | `authority` | WS |  |
| 2 | `coin_mint` | – |  |
| 3 | `quote_mint` | – |  |
| 4 | `treasury` | W | PDA ["treasury", coin_mint] |
| 5 | `vault` | W | PDA ["vault", treasury] |
| 6 | `quote_token_program` | – |  |
| 7 | `system_program` | – | address `11111111111111111111111111111111` |
<!-- /ocip:ix -->

<!-- ocip:events treasury -->
**`treasury` events**

| Event | Discriminator | Fields |
|---|---|---|
| `AssignmentRecorded` | `56c29651a825b231` | `treasury: Pubkey` |
| `AttestationLapsed` | `e9c73fc36bfe0d20` | `treasury: Pubkey`, `at: i64` |
| `DisclosurePosted` | `1b63e722d7227259` | `treasury: Pubkey`, `hash: [u8; 32]`, `at: i64`, `count: u32` |
| `DisclosureRequested` | `38fc5dce86d233ba` | `treasury: Pubkey`, `holder: Pubkey`, `open_since: i64` |
| `DistributionClaimed` | `1ce06237f0d7d104` | `treasury: Pubkey`, `owner: Pubkey`, `amount: u64` |
| `DistributionDeposited` | `d6c6b7cd38c41ba2` | `treasury: Pubkey`, `from: Pubkey`, `amount: u64`, `total_staked: u64` |
| `GrantCreated` | `a2fe833841d65506` | `treasury: Pubkey`, `grant: Pubkey`, `id: u64`, `beneficiary: Pubkey`, `total: u64`, `lockup_end: i64`, `expiry_ts: i64` |
| `GrantExpired` | `fd4def49d91e6ab0` | `grant: Pubkey`, `burned: u64` |
| `LiquidationStarted` | `d19e3e17b2c408f1` | `treasury: Pubkey`, `vault: u64`, `supply: u64` |
| `MilestoneReleased` | `31e15bdf22a56db5` | `grant: Pubkey`, `index: u8`, `amount: u64` |
| `NavRedeemed` | `e5c6e8fd3e11b189` | `treasury: Pubkey`, `holder: Pubkey`, `burned: u64`, `paid: u64`, `period_burned: u64` |
| `ProposalCreated` | `ba08a06c510d33ce` | `treasury: Pubkey`, `proposal: Pubkey`, `id: u64`, `proposer: Pubkey`, `kind: ProposalKind`, `amount: u64`, `destination: Pubkey`, `vote_end_ts: i64` |
| `ProposalExecuted` | `5cd5bdc965536f53` | `proposal: Pubkey`, `kind: ProposalKind`, `amount: u64` |
| `Redeemed` | `0e1db7471fa56b26` | `treasury: Pubkey`, `holder: Pubkey`, `burned: u64`, `paid: u64` |
| `RoundMissed` | `8781a64fb432eb24` | `treasury: Pubkey`, `round: u64`, `nav_open: bool` |
| `RoundPaid` | `e1dcd21394157f9a` | `treasury: Pubkey`, `round: u64`, `revenue: u64`, `due: u64`, `payer: Pubkey` |
| `Spent` | `2b33a464bff4ae62` | `treasury: Pubkey`, `amount: u64`, `to: Pubkey`, `spent_in_period: u64` |
| `Staked` | `0b922dcde63ad5f0` | `treasury: Pubkey`, `owner: Pubkey`, `amount: u64`, `total_staked: u64` |
| `TrancheReleased` | `e11925f6e0b7c1f9` | `treasury: Pubkey`, `round: u64`, `amount: u64` |
| `TreasuryCreated` | `be3b3a694cea15c7` | `treasury: Pubkey`, `coin_mint: Pubkey`, `authority: Pubkey`, `allowance: u64`, `period_secs: i64` |
| `TreasuryExtended` | `e2de244e6e9ad167` | `treasury: Pubkey`, `governance: bool`, `nav: bool`, `revenue: bool`, `disclosure: bool`, `assignment_required: bool`, `wind_down: bool` |
| `UnclaimedSwept` | `145c13ed8767ffa8` | `treasury: Pubkey`, `amount: u64`, `to: Pubkey` |
| `Unstaked` | `1bb39cd72f47c307` | `treasury: Pubkey`, `owner: Pubkey`, `amount: u64`, `total_staked: u64` |
| `Voted` | `bd4a657f6dd65f82` | `proposal: Pubkey`, `voter: Pubkey`, `support: bool`, `amount: u64`, `yes: u64`, `no: u64` |
| `VoteReclaimed` | `3ac621fe6d26f87f` | `proposal: Pubkey`, `voter: Pubkey`, `amount: u64` |
<!-- /ocip:events -->

<!-- ocip:errors treasury -->
**`treasury` errors**

| Code | Name | Message |
|---|---|---|
| 6000 | `InvalidParams` | Invalid parameters |
| 6001 | `SupplyNotFixed` | The coin's supply must be fixed: its mint authority must be revoked |
| 6002 | `Unauthorized` | Only the treasury authority may spend |
| 6003 | `Liquidating` | The treasury is in liquidation |
| 6004 | `NotLiquidating` | The treasury is not in liquidation |
| 6005 | `NotAttested` | No live attestation for this treasury |
| 6006 | `StillAttested` | The attestation is still live |
| 6007 | `WrongAttestationAccount` | That is not this treasury's attestation account |
| 6008 | `OverAllowance` | Spend exceeds this period's allowance |
| 6009 | `NoLapse` | No lapse has been recorded |
| 6010 | `GraceNotOver` | The grace period after the lapse has not ended |
| 6011 | `Overflow` | Arithmetic overflow |
| 6012 | `NotExtended` | This treasury has no extension: call init_ext first |
| 6013 | `AlreadyExtended` | This treasury is already extended |
| 6014 | `Disabled` | This feature is not enabled for the treasury |
| 6015 | `NavMode` | NAV mode is on: team spending is frozen while holders can redeem |
| 6016 | `AssignmentRequired` | The IP and asset assignment has not been recorded |
| 6017 | `AlreadyAssigned` | The assignment is already recorded |
| 6018 | `DisclosureOverdue` | A holder's disclosure request is overdue |
| 6019 | `NotHolder` | Only a holder of enough coins may do this |
| 6020 | `WrongProposalId` | The id must be the next one |
| 6021 | `WrongProposal` | That account does not belong to this proposal or treasury |
| 6022 | `VotingClosed` | Voting on this proposal is closed |
| 6023 | `VotingOpen` | Voting on this proposal is still open |
| 6024 | `TimelockPending` | The timelock after the vote has not ended |
| 6025 | `ProposalExpired` | The proposal expired before it was executed |
| 6026 | `ProposalFailed` | The proposal did not reach quorum and a majority |
| 6027 | `AlreadyExecuted` | The proposal was already executed |
| 6028 | `OverProposalCap` | The spend exceeds the share of the vault one proposal may move |
| 6029 | `WrongDestination` | The destination is not the one the proposal names |
| 6030 | `NavClosed` | The NAV window is not open |
| 6031 | `NavLimit` | This period's NAV redemption limit is used up |
| 6032 | `InsiderExcluded` | Insiders cannot redeem at NAV |
| 6033 | `ZeroPayout` | The redemption would pay nothing |
| 6034 | `NothingToClaim` | There is nothing to claim |
| 6035 | `RoundOpen` | The round has not ended yet |
| 6036 | `RoundClosed` | The payment window for this round has closed |
| 6037 | `RoundNotLate` | The payment window for this round has not closed |
| 6038 | `BadRevenueData` | The attestation's data is not a revenue figure |
| 6039 | `TrancheNotEligible` | This round is not eligible for a tranche |
| 6040 | `GrantInvalid` | The grant terms are invalid |
| 6041 | `LockupTooShort` | The grant lockup is shorter than the treasury's minimum |
| 6042 | `MilestoneNotReady` | The lockup has not ended |
| 6043 | `AlreadyReleased` | The milestone was already released |
| 6044 | `GrantExpired` | The grant has expired or was burned |
| 6045 | `GrantNotExpired` | The grant has not expired |
| 6046 | `WrongBeneficiary` | The coin account is not the grant's beneficiary |
| 6047 | `WindowOpen` | The withdraw-only window is still open |
| 6048 | `AlreadySwept` | The leftover was already swept |
| 6049 | `WrongRecovery` | The recovery account does not match |
| 6050 | `WoundDown` | The treasury was wound down and swept |
<!-- /ocip:errors -->

## Appendix C. Changelog

| Revision | Date | Change |
|---|---|---|
| 1 | 2026-10-13 | First draft. Written from the program sources, IDLs, `clearing-core`, `packages/verifier`, `packages/promises` and `services/api` at the commit that adds this file. Includes the worked examples, hash vectors, promise vector and sample fairness proof of §7.9, §8.4, §15.7 and §13.3 |
| 2 | 2026-10-13 | Revision 2: the rules extension of `cross_core` (§19): an extension tail on `Cross` and `Order`, `set_rules`, print guards, a hard-to-game ending with a draw, identity limits and allocation classes, locks and issuer neutrality, halt states and a lender feed, recurring series, pushed refunds, several oracles, a referral share. Revision 1 crosses are unchanged. The instruction, account, event, error and enumeration tables are produced from the IDLs by `scripts/ocip-sync.mjs` |

## Appendix D. References

Design records: ADR-0003 (clearing rule), ADR-0004 (gating), ADR-0005 (`cross_core`), ADR-0006 (DBC continuation), ADR-0010 (fees), ADR-0011 (calendar), ADR-0012 (identity gating), ADR-0014 (treasury), ADR-0015 (promises), ADR-0021 (Raydium devnet build) in [`docs/adr`](../adr). Evidence: [`D5-conformance.md`](../evidence/D5-conformance.md), [`D5-verifier-devnet-sweep.md`](../evidence/D5-verifier-devnet-sweep.md), [`C2-cross-core-devnet.md`](../evidence/C2-cross-core-devnet.md), [`L4-verifiable-build.md`](../evidence/L4-verifiable-build.md). Security: [`INVARIANTS.md`](../security/INVARIANTS.md), [`THREAT_MODEL.md`](../security/THREAT_MODEL.md). Status of every feature: [`FEATURE_STATUS.md`](../FEATURE_STATUS.md). Change process: [sRFC-0001](sRFC-0001-process.md).
