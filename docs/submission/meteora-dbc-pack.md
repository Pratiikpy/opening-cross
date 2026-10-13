# Pack 2: Meteora DBC sidetrack (Superteam Earn)

Listing: https://superteam.fun/earn/listing/meteora-dbc · "Best use of Meteora's Dynamic Bonding Curve (DBC)" · 20,000 USDC across 5 places (10,000, 5,000, 3,000, 1,500, 500) · deadline 2026-10-13T06:59:00Z (13 Oct, 12:29 IST).
Requirements re-read from the live listing API on 2026-10-12 (see [README](README.md), "Live re-check"). Rules in force: judging criteria below; closed-source repositories must add GitHub user `dannxbt` with read access.

## 1. Form fields (final text)

The form has nine fields (identical to the 2026-10-03 capture in `research/SIDETRACKS.md`). HUMAN means only Prateek can supply or confirm it.

| # | Field | Required | Final value |
|---|---|---|---|
| 1 | Project Name | yes | `Opening Bell` |
| 2 | Project Description | yes | Text in section 2 |
| 3 | Project Github Link | yes | https://github.com/Pratiikpy/opening-cross (private today: **H21**, make it public or grant `dannxbt` and `hackathon@colosseum.com` read access before submitting; a private link with no access fails the Meteora rule) |
| 4 | Project Website | no | https://opening-bell-psi.vercel.app |
| 5 | Project X Link | no | HUMAN: no X account exists yet (HUMAN_TASKS H7). Leave blank rather than link a placeholder |
| 6 | Link to pitch deck or Loom/video | yes | HUMAN: the uploaded Meteora cut, script in [`video/meteora-demo.md`](video/meteora-demo.md) (at most 3 minutes). Fallback if it is not ready: the Colosseum demo video |
| 7 | Did you submit to the official Crypto World's Fair on Colosseum? | yes | `Yes`, only after the Colosseum submission is confirmed (answering Yes before it exists would be false) |
| 8 | Link to Colosseum project | no | HUMAN: the project URL the Colosseum portal shows after submission |
| 9 | Link to your Colosseum profile | no | HUMAN: your colosseum.com profile URL |

## 2. Project description (paste)

> Opening Bell is a launch layer for new markets on Solana, built on an open call-auction protocol, Opening Cross. Orders are escrowed on chain during a call period; at the close one uniform clearing price P* is found where demand meets supply, and every filled order pays P*. Then the market opens on Meteora at exactly that price. For Meteora, `cross_settle` is the adapter: it creates a transfer-hook DBC config and a DBC pool whose start price equals P* (the program rejects any other start price), moves the token's mint authority to the cross, mints each winner's allocation at P*, and revokes mint authority at finalize, so the first trade on the curve starts where the auction ended. The same settlement can instead seed a DAMM v2 pool at P* or a DLMM pair whose active bin is the one nearest P*. Everything is proved on Solana devnet against Meteora's deployed programs with real transactions, and every cross can be recomputed by an independent verifier from on-chain data. It is devnet only: nothing is on mainnet and there is no external audit yet.

(Length: about 190 words. If the form limits characters, cut after "…the auction ended.")

## 3. Meteora depth, instruction by instruction

Everything in the "Proven" table was run on Solana devnet against Meteora's own deployed programs, with the transactions linked. The evidence files hold the full step tables, the refusals tested, and what was not covered.

Meteora program ids used (devnet and mainnet share them for DBC, DAMM v2, DLMM, Presale Vault): DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, DAMM v2 (cp-amm) `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, DLMM (lb_clmm) `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, Presale Vault `presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj`. Our programs on devnet: `cross_core` `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`, `cross_gate` `2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr`, `cross_settle` `2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ`. All five programs equal the local builds byte for byte on devnet (`docs/evidence/L4-verifiable-build.md` section 3).

### 3.1 Proven on devnet

| Meteora instruction (CPI target) | Our instruction | What it does | Proof (devnet transaction) | Evidence file |
|---|---|---|---|---|
| DBC `create_config_with_transfer_hook` and `initialize_virtual_pool_with_token2022_transfer_hook` | `cross_settle::open_dbc_pool` (152,915 compute units) | Builds the issuer's pre-committed curve config with `cross_gate` as the transfer hook and `PartnerUpdateAndMintAuthority`, then creates the pool. The program rejects a start price that differs from `sqrt(P*)` by more than one unit (refusal tested: `StartPriceNotClearingPrice`; non-creator refused: `NotCreator`; second pool for the same cross refused). Pool `sqrt_price` read back from chain equals the expected value 22592555198148962256 | [3cUyecZW…](https://explorer.solana.com/tx/3cUyecZWb1sa5gch4vH9rsvr1ZrH8VqB3YDr1f5ZkB87kbVM1DWF67yEb9s3GY5yckbHYcsNknS5yfBfUjVid1wa?cluster=devnet) | `A1-dbc-continuation-devnet.md` |
| (our program, DBC mint authority) | `cross_settle::bind_dbc_mint` (56,129 compute units) | Installs `cross_gate` in the pool's mint (`create_config`, `init_hook_metas`, `set_authority`), moves mint authority to the cross, binds the mint with `cross_core::bind_base_mint` | [3uttgSXJ…](https://explorer.solana.com/tx/3uttgSXJaPuSGNy5VuS2m15eG7mJyUMTfwynuVSuHTwYNvU8RDTFdCvPkzj1WHTvC4tS27HKXdoKprZq5YNHsrR3?cluster=devnet) | same |
| DBC swap on the opened pool | n/a (trader) | A winner buys from the live pool: paid 50,000,000 quote atoms, received 32,999,998 base atoms against 33,000,000 expected from P* and the 1% fee; the `cross_gate` hook ran in that swap | [3Bffnhc9…](https://explorer.solana.com/tx/3Bffnhc9CyjoBWVh9JmaM9bXsEdiVGbfTv79VVeNCeNjnWuo87sGATCE8DpwTarhD5KXnotVvRG7ThQDiH2KQzhN?cluster=devnet) | same |
| (claims, finalize) | `cross_core::claim`, `finalize` | Fills minted at P*, escrow above P* refunded, mint authority None after finalize; supply equals the DBC vault plus exactly the claimed fills | [43EnuSeP…](https://explorer.solana.com/tx/43EnuSePgE9c2qNUxErVgim4wgJLRSKLJxXSQCVVTCBbf1uXATHEGsiK7BWUVhHrYni5DhFFAStUJC4M2vaP9jAG?cluster=devnet), [3ya7Ges6…](https://explorer.solana.com/tx/3ya7Ges6uDk797QFmMzkMv3PruVjQFZ8j71Gb6jSd1Chm88fvVoFtSvFhnJVsoSDguLeAYCYcF1f9jMWtYdMqyta?cluster=devnet) | same |
| DAMM v2 `initialize_customizable_pool` | `cross_settle::seed_damm_v2` | Opens a full-range pool at P* 1.3. Pool `sqrt_price` 21032524265936792269 equals the expected value; vaults hold the deposits; the position NFT is owned by the creator; a wrong start price and a non-creator are refused. A real swap by a second wallet returned 6,444,695 quote for 5,000,000 base against 6,444,696.1 from an independent constant-product model (0.30% fee) | [35i6AVE8…](https://explorer.solana.com/tx/35i6AVE8aN2ou7cezW9QASmtkdxWJZvt9wCXQyJG2sTG5AZHMKCfMso3UTiXc4CmUonUgeMerbPLw7dHYXiWNmvR?cluster=devnet), [3jEhEYkf…](https://explorer.solana.com/tx/3jEhEYkfakJJ2LAotJn1eFgVtWzLinmeQiQcYs3M298bQtQpuPueW8ghAQreW2P1jAZcndJcAy438L1gFEtWyMaG?cluster=devnet) | `A2-damm-v2-devnet.md` |
| DLMM `initialize_customizable_permissionless_lb_pair2` | `cross_settle::open_dlmm_pair` | Opens a pair whose active bin (262, bin step 10) is the bin nearest P*: bin price 1.299356 against P* 1.3, off by 0.0495%, inside the half-bin-step bound. An active bin two steps away is refused. Liquidity added in three bins; a real swap received 6,490,285 quote, equal to the independent bin-price model | [5oJPttBp…](https://explorer.solana.com/tx/5oJPttBpAFEgRTBGpJpHNDK65F1HS9DTXX76M3dKgUMXbSeye9G5RpZaNeZ6Yf3uhNUmy9DzvosWuHNYTUPkcAmj?cluster=devnet), [3wfUm3xy…](https://explorer.solana.com/tx/3wfUm3xyyhRRTkFctFUYyPF1LE8wNPFd3taADBdjm2awrBt7CpTHJm3SMeqhp5Kd2HuKQDsuaNp39Eb2mrmYzD8o?cluster=devnet), [525DF97v…](https://explorer.solana.com/tx/525DF97vgqKXNCPBzTNnD6hUA83W5bi2zYxVxFhjy6EBs679pJptuLrHio3FJrbCMYgr7y13PTwM6gJGx2Bd7M19?cluster=devnet) | `A3-dlmm-devnet.md` |
| DBC with `cross_gate` transfer hook through the whole curve (DP1 to DP6) | n/a (proof script on our hook) | Partner mints outside the vault without disturbing DBC reserves; a wallet without a pass cannot buy (`RecipientNotAllowed`); locks block selling a locked balance; the curve completes; DBC removes the hook at graduation; **DBC to DAMM v2 migration succeeds** with extra supply outstanding and an active lock record (pool `isMigrated=true`) | [5S9M1mhb…](https://explorer.solana.com/tx/5S9M1mhb1AGKWXtiLVF5EPdhtuAfRoFGQ6VGGJD9HG9h1XiuDLbt7PRgpBuPabtAYUB6JsnkNAbRcNWdQTsNie95?cluster=devnet), [4wCSaRUm…](https://explorer.solana.com/tx/4wCSaRUm9Br7UjDnCibQ6w4LngqVKQDhQKNpLEAuhh28VFd2CDeFuqoss8opDZn2KyFubs4ybNHLr5od7z1meDjA?cluster=devnet), [5bkQxL73…](https://explorer.solana.com/tx/5bkQxL73gvGoE4k7CSr289ujCvw8rZVGoMX7b2hZDhiTFFgukojLJLxNPhKASvnejcxnRBuY3sXNKjdregizWM21?cluster=devnet) | `DP-dbc-hook.md`, findings in `DP-dbc-hook-findings.md` |
| DBC volatility-aware dynamic fee parameters | issuer config (ADR-0018) | Base 100 bps; fee rises to the designed 200 bps cap during a burst that moved the price 8,511 bps, then decays to 101.66 bps after a quiet period; 7 swaps match the model within 0.012 bps. Finding recorded: a swap pays for volatility earlier swaps left behind | [2EkZAD9Q…](https://explorer.solana.com/tx/2EkZAD9QYcZWVJjLDTn9Gh5eZE4SdubQMkANvfZi7XFbuCNPvWh1yVG7j1JjTU1Kn85vaKeH9kLKAja6nGRqG8wr?cluster=devnet), [2m4JM8a1…](https://explorer.solana.com/tx/2m4JM8a1yftEuYPKq5PAymcsviuvmfH6MCNMSVfgLJXmjAVFbYCsRSzfHACzrNYERx5m5Hsrs4T3hedtwStMH3NU?cluster=devnet) | `DP-volatility-fee.md` |
| Presale Vault partner-mint path | proof script only | Partner mints the presale supply, revokes mint authority, a buyer deposits and claims at the fixed price 0.1, unsold base refunded, supply unchanged | [5gAh2vwY…](https://explorer.solana.com/tx/5gAh2vwYqfXqCRrMWVaJ4TC7CCf6qJD3HeeTLEpCJWe6kG9LfvXUFDzgKYw2ZTfjxwELdQuHHwCGaq6XxHQLFq17?cluster=devnet), [4AhyAKnU…](https://explorer.solana.com/tx/4AhyAKnUWUtacGhaiHWvr2z3thVkGog4ChFwTkw56YBBN4Vs6GFrNPywyPXoYjthJrdGc2G6uUCLfWieW7QCwqtt?cluster=devnet) | `DP11-presale-vault.md` |

### 3.2 Not covered, said plainly

- DBC to DAMM v2 migration of a pool **opened by `open_dbc_pool`**: DP6 ran on a hand-built config, not on the adapter's pool (`A1` header, "Not covered").
- An allowlist-mode gate on the adapter's DBC pool: the adapter installs the gate in open mode, so the A1 swap shows the hook running, not a pass being enforced. Enforcement through the curve is proven separately in DP5 on a hand-built hooked config.
- More than one winning bidder on the DBC path (A1 had one winner; the second bid sat below P*).
- Proven since the first version of this pack, on Meteora's real binaries in LiteSVM and then on devnet (`D1-damm-lock-compounding-devnet.md`, `D5-dlmm-conviction-ladder-devnet.md`, `D7-fee-sharing-vault-devnet.md`): DAMM v2 permanent lock, vesting schedule and compounding fee mode (`D1-damm-lock-compounding.md`), a DLMM conviction ladder (`D5-dlmm-conviction-ladder.md`), and a Dynamic Fee Sharing vault that takes a DAMM v2 position's fees and splits them (`D7-fee-sharing-vault.md`). Still not proved: Alpha Vault, Met Lock, Zap, the Presale Vault inside a cross, and the DBC fee bridges.
- Mainnet: nothing is deployed. The listing says "We prefer projects who have gone live on mainnet". This project has no mainnet traction and the submission must not imply any.
- Token Badge for gated mints on DAMM v2 is not requested yet (HUMAN_TASKS H9).
- The Raydium CPMM adapter (A4) is not Meteora and is not part of the depth claim.

### 3.3 Mapping to the five judging criteria

| Meteora criterion | Our answer | Evidence |
|---|---|---|
| Depth of Meteora integration | Four Meteora programs driven by real CPIs and proved on devnet: DBC (config, pool, mint-authority handover, swap), DAMM v2 (customizable pool at P*), DLMM (customizable pair at the nearest bin), Presale Vault (partner-mint path). The DBC config uses the transfer-hook variant with a fee-claimer PDA. | `A1`, `A2`, `A3`, `DP-dbc-hook`, `DP11`, `DP-volatility-fee` |
| Technical execution | One clearing rule in a `no_std` crate shared by the program and a 525-vector conformance generator; an independent TypeScript implementation reproduces all 525 and the program reproduces the 523 it can represent on LiteSVM, 0 mismatches; 100,000 real orders placed at 21,633 compute units each and settled in 33 transactions (783,740 compute units); verifier sweep over every devnet cross: 38 verified, 0 mismatched. Every refusal path was tested, not only the happy path. Known miss: devnet landing latency p90 17,652 ms against a 5,000 ms target, measured on a throttled public RPC. | `D5-conformance`, `DP13-scale`, `DP13-devnet-latency`, `D5-verifier-devnet-sweep` |
| Originality and Taste | The uniform-price call auction is not new on Solana (Metaplex Genesis has a launch auction bucket; Uncross runs one for tokenized stocks on devnet). What the search found nowhere else: the auction as the price-setting front of a DBC, with the pool's start price enforced equal to P* by the program, one protocol for launches and reopens, sealed commit-reveal bids, identity-gated hook trading, and independent verification. We do not claim to be first. | `DP10-reopen-novelty`, `DP12-genesis` |
| Impact potential | Newly tokenized and thinly traded names have no agreed opening price; this gives them one, and the market starts there on Meteora liquidity. Meteora stock-pair and ICM-pair use cases (named in the listing) are served by any quote mint the adapters accept. Impact is argued, not measured: no external issuer or user yet. | `PROBLEMS_AND_SOLVERS.md`, `docs/FEATURE_STATUS.md` |
| Traction/Volume | **None on mainnet. No external users.** Devnet only: the live indexer shows 51 crosses opened and 38 with a clearing price (read from `/v1/stats`, 2026-10-12), all from our own test runs. | live API, `W2-live-deployment` |

### 3.4 Eligibility question to settle before submitting (HUMAN)

A commenter on the listing asked "Is a devnet deployment eligible?" and got "Should be not sure". Ask Meteora directly in Telegram `t.me/meteora_dev` or the developer Discord channel linked on the listing, quoting: "Our DBC continuation is proved on devnet against the deployed DBC, DAMM v2 and DLMM programs. Is a devnet-only project eligible for the DBC sidetrack, and is `dannxbt` read access enough for a private repository?" Record the answer in the checklist.

## 4. Demo and video

The listing asks for one link to a deck or video. Use the Meteora cut: [`video/meteora-demo.md`](video/meteora-demo.md) (at most 3 minutes, a shot list tied to the transactions above). The Colosseum pitch and demo scripts are in [`video/pitch-script.md`](video/pitch-script.md) and [`video/demo-script.md`](video/demo-script.md). Footage that must still be recorded is listed in [`video/footage-plan.md`](video/footage-plan.md).

## 5. Discretionary grants

The listing says select teams building AI or RWA use cases with DBC may be eligible for discretionary infrastructure grants. Our RWA fit is tokenized-stock reopens and launches. If the Meteora team asks, the evidence to send is section 3.1. HUMAN: decide whether to ask.

## 6. Submit checklist for this target

See [`checklist.md`](checklist.md), section "Meteora DBC".
