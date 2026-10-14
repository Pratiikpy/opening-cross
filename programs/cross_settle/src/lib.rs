//! Opening Cross settlement adapters (ADR-0006).
//!
//! **Meteora DBC continuation.** After a deferred-mint launch clears at P*, the issuer opens a
//! Meteora Dynamic Bonding Curve whose start price is P*, so trading continues from the price the
//! cross discovered. The adapter:
//! 1. `open_dbc_pool`: verifies the cross cleared, checks that the DBC config's start price
//!    equals P* (to one unit in the last place), then creates the DBC transfer-hook config and
//!    pool with PDAs as signers. DBC creates the base mint and gives its mint authority to this
//!    adapter's per-cross settler PDA.
//! 2. `bind_dbc_mint`: installs `cross_gate` as the open-mode hook for the mint, moves the mint
//!    authority to the cross PDA and binds the mint in `cross_core`, after which claims mint each
//!    winner's fill at P* and `finalize` revokes the authority for good.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, SetAuthority, TokenAccount, TokenInterface};

declare_program!(dynamic_bonding_curve);
declare_program!(cross_core);
declare_program!(cross_gate);
declare_program!(cp_amm);
declare_program!(lb_clmm);
declare_program!(raydium_cp_swap);

use cross_core::accounts::Cross;

mod batch;
mod design;
mod greenshoe;
mod partner;
mod pol;
pub use greenshoe::*;
pub use partner::*;
pub use pol::*;

#[cfg(not(feature = "devnet-raydium"))]
declare_id!("2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ");
/// The devnet-Raydium build is a separate deployment under its own program id (ADR-0021): Raydium's
/// mainnet CPMM id is not deployed on devnet, so the binary that CPIs into Raydium's devnet program
/// cannot reuse the id of the mainnet-bound binary.
#[cfg(feature = "devnet-raydium")]
declare_id!("4nH5srCTtRFtJuHNmH2Q3x1TSMZ8w3VWBfX7PwwNMpJ5");

/// The Raydium CPMM program `seed_raydium_cpmm` may CPI into. The default build accepts only the
/// mainnet deployment; `devnet-raydium` accepts only Raydium's devnet deployment
/// (`devnet` feature of raydium-io/raydium-cp-swap, `programs/cp-swap/src/lib.rs`).
#[cfg(not(feature = "devnet-raydium"))]
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = raydium_cp_swap::ID;
#[cfg(feature = "devnet-raydium")]
pub const RAYDIUM_CPMM_PROGRAM: Pubkey = pubkey!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");

pub const SETTLER_SEED: &[u8] = b"settler";
pub const DBC_CONFIG_SEED: &[u8] = b"dbc_config";
pub const BASE_MINT_SEED: &[u8] = b"base_mint";
pub const DAMM_POSITION_SEED: &[u8] = b"damm_position";

/// DBC's `PartnerUpdateAndMintAuthority`: the partner (`fee_claimer`) receives the mint authority.
const PARTNER_UPDATE_AND_MINT_AUTHORITY: u8 = 4;
/// DBC token type for Token-2022 base mints.
const TOKEN_TYPE_TOKEN_2022: u8 = 1;
/// `withdraw_migration_fee` flag for the partner (DBC `SenderFlag::Partner`).
const PARTNER_MIGRATION_FEE_FLAG: u8 = 0;

#[program]
pub mod cross_settle {
    use super::*;

    /// Step 1: create the DBC config and pool at the clearing price. Only the cross creator may
    /// call it, because the curve shape and fees are the issuer's choice; the start price is not.
    pub fn open_dbc_pool(
        ctx: Context<OpenDbcPool>,
        config_parameters: dynamic_bonding_curve::types::ConfigParameters,
        pool: dynamic_bonding_curve::types::InitializePoolParameters,
    ) -> Result<()> {
        open_pool(ctx.accounts, &ctx.bumps, config_parameters, pool)
    }

    /// `open_dbc_pool` for the fair-launch design (ADR-0482): the same curve, but the program refuses a
    /// config under which anyone could withdraw the opening liquidity, or whose migrated pool is not
    /// compounding. Everything `open_dbc_pool` checks is checked here too. `args` is the Borsh encoding
    /// of `open_dbc_pool`'s two arguments, `config_parameters` then `pool`, one after the other, so
    /// `open_dbc_pool`'s own argument types stay what they were.
    pub fn open_dbc_pool_locked(ctx: Context<OpenDbcPool>, args: Vec<u8>) -> Result<()> {
        let mut rest = &args[..];
        let config_parameters =
            dynamic_bonding_curve::types::ConfigParameters::deserialize(&mut rest)
                .map_err(|_| SettleError::BadArgs)?;
        let pool = dynamic_bonding_curve::types::InitializePoolParameters::deserialize(&mut rest)
            .map_err(|_| SettleError::BadArgs)?;
        require!(rest.is_empty(), SettleError::BadArgs);
        design::check_locked_design(&config_parameters)?;
        open_pool(ctx.accounts, &ctx.bumps, config_parameters, pool)
    }

    /// Step 2: install the open-mode hook config, hand the mint authority to the cross and bind
    /// the mint in `cross_core`. Permissionless once step 1 has run; the payer funds rent.
    pub fn bind_dbc_mint(ctx: Context<BindDbcMint>) -> Result<()> {
        let cross = read_cross(&ctx.accounts.cross)?;
        require!(!cross.base_bound, SettleError::AlreadyBound);
        require!(
            cross.settler == Some(ctx.accounts.settler.key()),
            SettleError::WrongSettler
        );
        require!(
            Option::<Pubkey>::from(ctx.accounts.base_mint.mint_authority)
                == Some(ctx.accounts.settler.key()),
            SettleError::PoolNotOpened
        );

        let cross_key = ctx.accounts.cross.key();
        let settler_bump = [ctx.bumps.settler];
        let settler_seeds: &[&[u8]] = &[SETTLER_SEED, cross_key.as_ref(), &settler_bump];

        // Gate config in open mode; passes and locks are managed by the issuer.
        cross_gate::cpi::create_config(
            CpiContext::new_with_signer(
                ctx.accounts.cross_gate_program.key(),
                cross_gate::cpi::accounts::CreateConfig {
                    payer: ctx.accounts.payer.to_account_info(),
                    mint_authority: ctx.accounts.settler.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    config: ctx.accounts.gate_config.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[settler_seeds],
            ),
            ctx.accounts.settler.key(),
            cross_gate::types::Mode::Open,
        )?;
        cross_gate::cpi::init_hook_metas(CpiContext::new_with_signer(
            ctx.accounts.cross_gate_program.key(),
            cross_gate::cpi::accounts::InitHookMetas {
                payer: ctx.accounts.payer.to_account_info(),
                authority: ctx.accounts.settler.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                config: ctx.accounts.gate_config.to_account_info(),
                extra_metas: ctx.accounts.gate_extra_metas.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[settler_seeds],
        ))?;
        // Hand gate management to the issuer.
        cross_gate::cpi::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.cross_gate_program.key(),
                cross_gate::cpi::accounts::SetAuthority {
                    authority: ctx.accounts.settler.to_account_info(),
                    config: ctx.accounts.gate_config.to_account_info(),
                },
                &[settler_seeds],
            ),
            cross.creator,
        )?;

        token_interface::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                SetAuthority {
                    current_authority: ctx.accounts.settler.to_account_info(),
                    account_or_mint: ctx.accounts.base_mint.to_account_info(),
                },
                &[settler_seeds],
            ),
            anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType::MintTokens,
            Some(cross_key),
        )?;

        cross_core::cpi::bind_base_mint(CpiContext::new_with_signer(
            ctx.accounts.cross_core_program.key(),
            cross_core::cpi::accounts::BindBaseMint {
                settler: ctx.accounts.settler.to_account_info(),
                cross: ctx.accounts.cross.to_account_info(),
                base_mint: ctx.accounts.base_mint.to_account_info(),
            },
            &[settler_seeds],
        ))?;

        emit!(DbcMintBound {
            cross: cross_key,
            base_mint: ctx.accounts.base_mint.key()
        });
        Ok(())
    }
    /// DAMM v2 adapter: seeds a Meteora DAMM v2 pool for the cross's market at exactly P*.
    /// Token A is the base asset and token B the quote, so DAMM's price (B per A) is the cross's
    /// price. The issuer supplies the liquidity from its own accounts and receives the position
    /// NFT; the adapter guarantees only that the pool opens at the price the cross discovered.
    pub fn seed_damm_v2(
        ctx: Context<SeedDammV2>,
        params: cp_amm::types::InitializeCustomizablePoolParameters,
    ) -> Result<()> {
        seed_damm(ctx.accounts, &ctx.bumps, params)
    }

    /// `seed_damm_v2` for a batch-opened market (ADR-0483): the pool refuses every swap until a start the program
    /// checks is at least `window_secs` away, its fee decays from a higher opening fee, and its fees compound
    /// back into the pool. During the window the market clears as a series of short crosses instead of trading
    /// against the AMM; afterwards the pool opens at the price the last cross printed.
    /// `params` is the Borsh encoding of `seed_damm_v2`'s argument.
    pub fn seed_damm_v2_batched(
        ctx: Context<SeedDammV2>,
        params: Vec<u8>,
        window_secs: i64,
    ) -> Result<()> {
        let params = decode_args::<cp_amm::types::InitializeCustomizablePoolParameters>(&params)?;
        batch::check_batched_pool(&params, Clock::get()?.unix_timestamp, window_secs)?;
        seed_damm(ctx.accounts, &ctx.bumps, params)
    }

    /// DLMM adapter: opens a Meteora DLMM pair for the cross's market whose active bin is the
    /// bin nearest P* (within half a bin step). Token X is the base asset and token Y the quote,
    /// so a bin's price (Y per X) is in the cross's units. Liquidity is added afterwards by the
    /// issuer with DLMM's own instructions; adding liquidity cannot move the active bin.
    pub fn open_dlmm_pair(
        ctx: Context<OpenDlmmPair>,
        params: lb_clmm::types::CustomizableParams,
    ) -> Result<()> {
        open_pair(ctx.accounts, params, [None, None])
    }

    /// `open_dlmm_pair` for a batch-opened market (ADR-0483): the pair is created with a timestamp start at least
    /// `window_secs` away, so it cannot trade until the crosses of the window have run (or, with `has_alpha_vault`, only an
    /// Alpha Vault can buy before then), and the pair's creator can pause it.
    /// `params` is the Borsh encoding of `open_dlmm_pair`'s argument.
    pub fn open_dlmm_pair_batched(
        ctx: Context<OpenDlmmPair>,
        params: Vec<u8>,
        window_secs: i64,
    ) -> Result<()> {
        let params = decode_args::<lb_clmm::types::CustomizableParams>(&params)?;
        batch::check_batched_pair(&params, Clock::get()?.unix_timestamp, window_secs)?;
        open_pair(ctx.accounts, params, [None, None])
    }

    /// `open_dlmm_pair` for a pair whose mints need a Meteora Token Badge (ADR-0485): tokenized stocks carry Token-2022 extensions
    /// (a pausable mint, a permanent delegate) that DLMM refuses without a badge. The two badge accounts follow the usual accounts, in
    /// order base then quote, each either the mint's `TokenBadge` PDA or the DLMM program id when that mint needs none. A batch window
    /// of zero opens the pair at once; any other window applies the rules of `open_dlmm_pair_batched`.
    /// `params` is the Borsh encoding of `open_dlmm_pair`'s argument.
    pub fn open_dlmm_pair_badged<'info>(
        ctx: Context<'info, OpenDlmmPair<'info>>,
        params: Vec<u8>,
        window_secs: i64,
    ) -> Result<()> {
        let params = decode_args::<lb_clmm::types::CustomizableParams>(&params)?;
        require!(
            ctx.remaining_accounts.len() == 2,
            SettleError::BadgeAccounts
        );
        if window_secs != 0 {
            batch::check_batched_pair(&params, Clock::get()?.unix_timestamp, window_secs)?;
        }
        let badge = |i: usize| {
            let info = &ctx.remaining_accounts[i];
            (info.key() != lb_clmm::ID).then(|| info.clone())
        };
        open_pair(ctx.accounts, params, [badge(0), badge(1)])
    }

    /// Raydium CPMM adapter: opens a Raydium constant-product pool for the cross's market whose
    /// opening price — the ratio of the two initial deposits — is P* to within one quote atom.
    /// Raydium orders the pool's mints by key, so the base may be token 0 or token 1.
    pub fn seed_raydium_cpmm(
        ctx: Context<SeedRaydiumCpmm>,
        base_amount: u64,
        quote_amount: u64,
        open_time: u64,
    ) -> Result<()> {
        let cross = read_cross(&ctx.accounts.cross)?;
        require_keys_eq!(
            cross.creator,
            ctx.accounts.creator.key(),
            SettleError::NotCreator
        );
        require!(cross.base_bound, SettleError::PoolNotOpened);
        let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;
        require!(
            deposit_matches_price(base_amount, quote_amount, clearing.price, cross.price_scale)
                .ok_or(SettleError::Overflow)?,
            SettleError::StartPriceNotClearingPrice
        );
        let base_is_token_0 = cross.base_mint < cross.quote_mint;
        let (mint_0, mint_1) = if base_is_token_0 {
            (cross.base_mint, cross.quote_mint)
        } else {
            (cross.quote_mint, cross.base_mint)
        };
        require_keys_eq!(
            ctx.accounts.token_0_mint.key(),
            mint_0,
            SettleError::WrongMint
        );
        require_keys_eq!(
            ctx.accounts.token_1_mint.key(),
            mint_1,
            SettleError::WrongMint
        );
        let (amount_0, amount_1) = if base_is_token_0 {
            (base_amount, quote_amount)
        } else {
            (quote_amount, base_amount)
        };

        raydium_cp_swap::cpi::initialize(
            CpiContext::new(
                ctx.accounts.raydium_program.key(),
                raydium_cp_swap::cpi::accounts::Initialize {
                    creator: ctx.accounts.creator.to_account_info(),
                    amm_config: ctx.accounts.amm_config.to_account_info(),
                    authority: ctx.accounts.raydium_authority.to_account_info(),
                    pool_state: ctx.accounts.pool_state.to_account_info(),
                    token_0_mint: ctx.accounts.token_0_mint.to_account_info(),
                    token_1_mint: ctx.accounts.token_1_mint.to_account_info(),
                    lp_mint: ctx.accounts.lp_mint.to_account_info(),
                    creator_token_0: ctx.accounts.creator_token_0.to_account_info(),
                    creator_token_1: ctx.accounts.creator_token_1.to_account_info(),
                    creator_lp_token: ctx.accounts.creator_lp_token.to_account_info(),
                    token_0_vault: ctx.accounts.token_0_vault.to_account_info(),
                    token_1_vault: ctx.accounts.token_1_vault.to_account_info(),
                    create_pool_fee: ctx.accounts.create_pool_fee.to_account_info(),
                    observation_state: ctx.accounts.observation_state.to_account_info(),
                    token_program: ctx.accounts.spl_token_program.to_account_info(),
                    token_0_program: ctx.accounts.token_0_program.to_account_info(),
                    token_1_program: ctx.accounts.token_1_program.to_account_info(),
                    associated_token_program: ctx
                        .accounts
                        .associated_token_program
                        .to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
            ),
            amount_0,
            amount_1,
            open_time,
        )?;
        emit!(RaydiumCpmmSeeded {
            cross: ctx.accounts.cross.key(),
            pool: ctx.accounts.pool_state.key(),
            clearing_price: clearing.price,
            base_amount,
            quote_amount
        });
        Ok(())
    }

    /// Claims the DBC partner's trading fees (the settler PDA is the partner) to an account owned by the
    /// cross's protocol fee recipient. Permissionless: nobody chooses the destination (ADR-0480).
    pub fn claim_partner_fee<'info>(
        ctx: Context<'info, ClaimPartnerFee<'info>>,
        max_base: u64,
        max_quote: u64,
        hook: dynamic_bonding_curve::types::TransferHookAccountsInfo,
    ) -> Result<()> {
        ctx.accounts.run(
            ctx.bumps.settler,
            ctx.remaining_accounts,
            max_base,
            max_quote,
            hook,
        )
    }

    /// Withdraws the partner's share of the surplus quote above the migration threshold to an account
    /// owned by the cross's `proceeds_to` (the issuer's capital, ADR-0481).
    pub fn withdraw_partner_surplus(ctx: Context<WithdrawPartnerSurplus>) -> Result<()> {
        ctx.accounts.surplus(ctx.bumps.settler)
    }

    /// Withdraws the partner's slice of the DBC migration fee to an account owned by the fee recipient.
    pub fn withdraw_partner_migration_fee(ctx: Context<WithdrawPartnerSurplus>) -> Result<()> {
        ctx.accounts.migration_fee(ctx.bumps.settler)
    }

    /// Commits a budget (at least 10% of what the cross raised) to standing bids under P* for a week (ADR-0487).
    pub fn create_greenshoe(
        ctx: Context<CreateGreenshoe>,
        budget: u64,
        start_ts: i64,
        period_secs: i64,
        period_cap: u64,
    ) -> Result<()> {
        ctx.accounts
            .run(&ctx.bumps, budget, start_ts, period_secs, period_cap)
    }

    /// Places one level of the greenshoe as a DLMM limit order owned by the program. Permissionless.
    pub fn deploy_greenshoe_bid<'info>(
        ctx: Context<'info, DeployGreenshoeBid<'info>>,
        level: u8,
        bin_id: i32,
        amount: u64,
    ) -> Result<()> {
        ctx.accounts
            .run(ctx.remaining_accounts, level, bin_id, amount)
    }

    /// After the week: cancels a placed level, taking back the unspent quote and the base it bought. Permissionless.
    pub fn settle_greenshoe_level<'info>(
        ctx: Context<'info, SettleGreenshoeLevel<'info>>,
        level: u8,
        hook: lb_clmm::types::RemainingAccountsInfo,
    ) -> Result<()> {
        ctx.accounts.run(level, ctx.remaining_accounts, hook)
    }

    /// Burns everything the bids bought and returns the unspent budget to the issuer's proceeds. Permissionless.
    pub fn finish_greenshoe(ctx: Context<FinishGreenshoe>) -> Result<()> {
        ctx.accounts.run()
    }

    /// Claims the fees of the protocol-owned DAMM v2 position a DBC migration leaves with the settler, to
    /// accounts owned by the cross's `proceeds_to` (ADR-0482).
    pub fn claim_pol_fees(ctx: Context<ClaimPolFees>) -> Result<()> {
        ctx.accounts.run(ctx.bumps.settler)
    }

    /// Claims the pool-creation fee the partner is owed, in lamports, to the fee recipient's wallet.
    pub fn claim_partner_pool_creation_fee(
        ctx: Context<ClaimPartnerPoolCreationFee>,
    ) -> Result<()> {
        ctx.accounts.run(ctx.bumps.settler)
    }
}

/// The body shared by `open_dbc_pool` and `open_dbc_pool_locked`.
fn open_pool(
    a: &OpenDbcPool,
    bumps: &OpenDbcPoolBumps,
    config_parameters: dynamic_bonding_curve::types::ConfigParameters,
    pool: dynamic_bonding_curve::types::InitializePoolParameters,
) -> Result<()> {
    let cross = read_cross(&a.cross)?;
    require_keys_eq!(cross.creator, a.creator.key(), SettleError::NotCreator);
    require!(!cross.base_bound, SettleError::AlreadyBound);
    require!(
        cross.settler == Some(a.settler.key()),
        SettleError::WrongSettler
    );
    require_keys_eq!(cross.quote_mint, a.quote_mint.key(), SettleError::WrongMint);
    let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;

    require!(
        config_parameters.token_type == TOKEN_TYPE_TOKEN_2022,
        SettleError::BadConfig
    );
    require!(
        config_parameters.token_update_authority == PARTNER_UPDATE_AND_MINT_AUTHORITY,
        SettleError::BadConfig
    );
    let expected =
        sqrt_price_q64(clearing.price, cross.price_scale).ok_or(SettleError::Overflow)?;
    require!(
        config_parameters.sqrt_start_price.abs_diff(expected) <= 1,
        SettleError::StartPriceNotClearingPrice
    );

    let cross_key = a.cross.key();
    let config_bump = [bumps.dbc_config];
    let config_seeds: &[&[u8]] = &[DBC_CONFIG_SEED, cross_key.as_ref(), &config_bump];
    dynamic_bonding_curve::cpi::create_config_with_transfer_hook(
        CpiContext::new_with_signer(
            a.dbc_program.key(),
            dynamic_bonding_curve::cpi::accounts::CreateConfigWithTransferHook {
                config: a.dbc_config.to_account_info(),
                fee_claimer: a.settler.to_account_info(),
                leftover_receiver: a.leftover_receiver.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                transfer_hook_program: a.cross_gate_program.to_account_info(),
                payer: a.creator.to_account_info(),
                system_program: a.system_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[config_seeds],
        ),
        config_parameters,
    )?;

    let mint_bump = [bumps.base_mint];
    let mint_seeds: &[&[u8]] = &[BASE_MINT_SEED, cross_key.as_ref(), &mint_bump];
    dynamic_bonding_curve::cpi::initialize_virtual_pool_with_token2022_transfer_hook(
        CpiContext::new_with_signer(
            a.dbc_program.key(),
            dynamic_bonding_curve::cpi::accounts::InitializeVirtualPoolWithToken2022TransferHook {
                config: a.dbc_config.to_account_info(),
                pool_authority: a.dbc_pool_authority.to_account_info(),
                creator: a.creator.to_account_info(),
                base_mint: a.base_mint.to_account_info(),
                quote_mint: a.quote_mint.to_account_info(),
                pool: a.pool.to_account_info(),
                base_vault: a.base_vault.to_account_info(),
                quote_vault: a.quote_vault.to_account_info(),
                transfer_hook_program: a.cross_gate_program.to_account_info(),
                payer: a.creator.to_account_info(),
                token_quote_program: a.quote_token_program.to_account_info(),
                token_program: a.token_2022_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
                event_authority: a.dbc_event_authority.to_account_info(),
                program: a.dbc_program.to_account_info(),
            },
            &[mint_seeds],
        ),
        pool,
    )?;

    emit!(DbcPoolOpened {
        cross: cross_key,
        config: a.dbc_config.key(),
        pool: a.pool.key(),
        base_mint: a.base_mint.key(),
        clearing_price: clearing.price,
        sqrt_start_price: expected,
    });
    Ok(())
}

/// The body shared by `seed_damm_v2` and `seed_damm_v2_batched`.
fn seed_damm(
    a: &SeedDammV2,
    bumps: &SeedDammV2Bumps,
    params: cp_amm::types::InitializeCustomizablePoolParameters,
) -> Result<()> {
    let cross = read_cross(&a.cross)?;
    require_keys_eq!(cross.creator, a.creator.key(), SettleError::NotCreator);
    require!(cross.base_bound, SettleError::PoolNotOpened);
    require_keys_eq!(cross.base_mint, a.base_mint.key(), SettleError::WrongMint);
    require_keys_eq!(cross.quote_mint, a.quote_mint.key(), SettleError::WrongMint);
    let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;
    let expected =
        sqrt_price_q64(clearing.price, cross.price_scale).ok_or(SettleError::Overflow)?;
    require!(
        params.sqrt_price.abs_diff(expected) <= 1,
        SettleError::StartPriceNotClearingPrice
    );

    let cross_key = a.cross.key();
    let nft_bump = [bumps.position_nft_mint];
    let nft_seeds: &[&[u8]] = &[DAMM_POSITION_SEED, cross_key.as_ref(), &nft_bump];
    let liquidity = params.liquidity;
    cp_amm::cpi::initialize_customizable_pool(
        CpiContext::new_with_signer(
            a.damm_program.key(),
            cp_amm::cpi::accounts::InitializeCustomizablePool {
                creator: a.creator.to_account_info(),
                position_nft_mint: a.position_nft_mint.to_account_info(),
                position_nft_account: a.position_nft_account.to_account_info(),
                payer: a.creator.to_account_info(),
                pool_authority: a.damm_pool_authority.to_account_info(),
                pool: a.pool.to_account_info(),
                position: a.position.to_account_info(),
                token_a_mint: a.base_mint.to_account_info(),
                token_b_mint: a.quote_mint.to_account_info(),
                token_a_vault: a.token_a_vault.to_account_info(),
                token_b_vault: a.token_b_vault.to_account_info(),
                payer_token_a: a.creator_base.to_account_info(),
                payer_token_b: a.creator_quote.to_account_info(),
                token_a_program: a.base_token_program.to_account_info(),
                token_b_program: a.quote_token_program.to_account_info(),
                token_2022_program: a.token_2022_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
                event_authority: a.damm_event_authority.to_account_info(),
                program: a.damm_program.to_account_info(),
            },
            &[nft_seeds],
        ),
        params,
    )?;
    emit!(DammV2Seeded {
        cross: cross_key,
        pool: a.pool.key(),
        clearing_price: clearing.price,
        sqrt_price: expected,
        liquidity
    });
    Ok(())
}

/// Decodes a Borsh argument carried as bytes and refuses trailing data.
fn decode_args<T: AnchorDeserialize>(bytes: &[u8]) -> Result<T> {
    let mut rest = bytes;
    let value = T::deserialize(&mut rest).map_err(|_| SettleError::BadArgs)?;
    require!(rest.is_empty(), SettleError::BadArgs);
    Ok(value)
}

/// The body shared by `open_dlmm_pair` and `open_dlmm_pair_batched`.
fn open_pair<'info>(
    a: &OpenDlmmPair<'info>,
    params: lb_clmm::types::CustomizableParams,
    badges: [Option<AccountInfo<'info>>; 2],
) -> Result<()> {
    let [badge_x, badge_y] = badges;
    let cross = read_cross(&a.cross)?;
    require_keys_eq!(cross.creator, a.creator.key(), SettleError::NotCreator);
    require!(cross.base_bound, SettleError::PoolNotOpened);
    require_keys_eq!(cross.base_mint, a.base_mint.key(), SettleError::WrongMint);
    require_keys_eq!(cross.quote_mint, a.quote_mint.key(), SettleError::WrongMint);
    let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;
    require!(
        bin_contains(
            params.active_id,
            params.bin_step,
            clearing.price,
            cross.price_scale
        )
        .ok_or(SettleError::Overflow)?,
        SettleError::StartPriceNotClearingPrice
    );
    let (active_id, bin_step) = (params.active_id, params.bin_step);
    lb_clmm::cpi::initialize_customizable_permissionless_lb_pair2(
        CpiContext::new(
            a.dlmm_program.key(),
            lb_clmm::cpi::accounts::InitializeCustomizablePermissionlessLbPair2 {
                lb_pair: a.lb_pair.to_account_info(),
                bin_array_bitmap_extension: None,
                token_mint_x: a.base_mint.to_account_info(),
                token_mint_y: a.quote_mint.to_account_info(),
                reserve_x: a.reserve_x.to_account_info(),
                reserve_y: a.reserve_y.to_account_info(),
                oracle: a.oracle.to_account_info(),
                user_token_x: a.creator_base.to_account_info(),
                funder: a.creator.to_account_info(),
                token_badge_x: badge_x,
                token_badge_y: badge_y,
                token_program_x: a.base_token_program.to_account_info(),
                token_program_y: a.quote_token_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
                user_token_y: a.creator_quote.to_account_info(),
                event_authority: a.dlmm_event_authority.to_account_info(),
                program: a.dlmm_program.to_account_info(),
            },
        ),
        params,
    )?;
    emit!(DlmmPairOpened {
        cross: a.cross.key(),
        lb_pair: a.lb_pair.key(),
        clearing_price: clearing.price,
        active_id,
        bin_step
    });
    Ok(())
}

/// `floor(sqrt(price / price_scale) · 2⁶⁴)` — DBC's Q64.64 square-root price for a price given
/// in quote atoms per `price_scale` base atoms.
pub fn sqrt_price_q64(price: u64, price_scale: u64) -> Option<u128> {
    use ruint::aliases::U256;
    if price_scale == 0 {
        return None;
    }
    let x: U256 = (U256::from(price) << 128usize) / U256::from(price_scale);
    u128::try_from(isqrt(x)).ok()
}

/// Integer square root (floor) by Newton's method, starting above the root.
fn isqrt(n: ruint::aliases::U256) -> ruint::aliases::U256 {
    use ruint::aliases::U256;
    if n < U256::from(2u8) {
        return n;
    }
    let mut x = U256::from(1u8) << n.bit_len().div_ceil(2);
    loop {
        let y = (x + n / x) >> 1usize;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// DLMM bin price `(1 + bin_step / 10⁴)^id` in Q64.64, by exact integer exponentiation.
pub fn bin_price_q64(id: i32, bin_step: u16) -> Option<ruint::aliases::U256> {
    use ruint::aliases::U256;
    let one = U256::from(1u8) << 64usize;
    let base = one + (U256::from(bin_step) << 64usize) / U256::from(10_000u32);
    let mut result = one;
    let mut b = base;
    let mut e = id.unsigned_abs();
    while e > 0 {
        if e & 1 == 1 {
            result = (result * b) >> 64usize;
        }
        e >>= 1;
        if e > 0 {
            b = (b * b) >> 64usize;
            if b.bit_len() > 192 {
                return None;
            }
        }
    }
    if id < 0 {
        result = (one << 64usize) / result;
    }
    Some(result)
}

/// `true` when P* lies within half a bin step of bin `id`'s price.
pub fn bin_contains(id: i32, bin_step: u16, price: u64, price_scale: u64) -> Option<bool> {
    use ruint::aliases::U256;
    if price_scale == 0 || bin_step == 0 {
        return None;
    }
    let bin = bin_price_q64(id, bin_step)?;
    let p = (U256::from(price) << 64usize) / U256::from(price_scale);
    let half = U256::from(20_000u32);
    let lower = bin * (half - U256::from(bin_step)) / half;
    let upper = bin * (half + U256::from(bin_step)) / half;
    Some(p >= lower && p <= upper)
}

/// `true` when `quote_amount` is `base_amount · P* / price_scale` rounded either way, i.e. the
/// deposit ratio prices the base at P* to within one quote atom.
pub fn deposit_matches_price(
    base_amount: u64,
    quote_amount: u64,
    price: u64,
    price_scale: u64,
) -> Option<bool> {
    if price_scale == 0 || base_amount == 0 {
        return None;
    }
    let exact = u128::from(base_amount).checked_mul(u128::from(price))?;
    let scale = u128::from(price_scale);
    let floor = exact / scale;
    let ceil = floor + u128::from(exact % scale != 0);
    let q = u128::from(quote_amount);
    Some(q >= floor && q <= ceil)
}

fn read_cross(info: &UncheckedAccount) -> Result<Cross> {
    require_keys_eq!(*info.owner, cross_core::ID, SettleError::WrongCross);
    let data = info.try_borrow_data()?;
    Cross::try_deserialize(&mut &data[..])
}

#[derive(Accounts)]
pub struct OpenDbcPool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: this adapter's settler PDA for the cross; becomes DBC's partner and mint authority.
    #[account(seeds = [SETTLER_SEED, cross.key().as_ref()], bump)]
    pub settler: UncheckedAccount<'info>,
    /// CHECK: created by DBC; this PDA signs as the config keypair.
    #[account(mut, seeds = [DBC_CONFIG_SEED, cross.key().as_ref()], bump)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: created by DBC; this PDA signs as the base-mint keypair.
    #[account(mut, seeds = [BASE_MINT_SEED, cross.key().as_ref()], bump)]
    pub base_mint: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: receives DBC's leftover base after migration; DBC records it.
    pub leftover_receiver: UncheckedAccount<'info>,
    /// CHECK: DBC pool PDA, validated by DBC.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DBC vault PDA, validated by DBC.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC vault PDA, validated by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: DBC's constant pool-authority PDA, validated by DBC.
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC's event-authority PDA, validated by DBC.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DBC program.
    #[account(address = dynamic_bonding_curve::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: the transfer-hook program DBC writes into the mint.
    #[account(address = cross_gate::ID)]
    pub cross_gate_program: UncheckedAccount<'info>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    /// CHECK: Token-2022 (base mint program).
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BindDbcMint<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`; written by `cross_core`.
    #[account(mut)]
    pub cross: UncheckedAccount<'info>,
    /// CHECK: this adapter's settler PDA for the cross.
    #[account(seeds = [SETTLER_SEED, cross.key().as_ref()], bump)]
    pub settler: UncheckedAccount<'info>,
    #[account(mut, seeds = [BASE_MINT_SEED, cross.key().as_ref()], bump, mint::token_program = token_2022_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: created by `cross_gate`.
    #[account(mut)]
    pub gate_config: UncheckedAccount<'info>,
    /// CHECK: created by `cross_gate`.
    #[account(mut)]
    pub gate_extra_metas: UncheckedAccount<'info>,
    /// CHECK: the gate program.
    #[account(address = cross_gate::ID)]
    pub cross_gate_program: UncheckedAccount<'info>,
    /// CHECK: the core program.
    #[account(address = cross_core::ID)]
    pub cross_core_program: UncheckedAccount<'info>,
    pub token_2022_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct DbcPoolOpened {
    pub cross: Pubkey,
    pub config: Pubkey,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub clearing_price: u64,
    pub sqrt_start_price: u128,
}
#[derive(Accounts)]
pub struct SeedDammV2<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: created by DAMM v2; this PDA signs as the position-NFT mint keypair.
    #[account(mut, seeds = [DAMM_POSITION_SEED, cross.key().as_ref()], bump)]
    pub position_nft_mint: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 PDA, validated by DAMM v2.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 PDA, validated by DAMM v2.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 PDA, validated by DAMM v2.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: DAMM v2 PDA, validated by DAMM v2.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 PDA, validated by DAMM v2.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: creator's base account; the token program enforces ownership on transfer.
    #[account(mut)]
    pub creator_base: UncheckedAccount<'info>,
    /// CHECK: creator's quote account; the token program enforces ownership on transfer.
    #[account(mut)]
    pub creator_quote: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's constant pool authority, validated by DAMM v2.
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority, validated by DAMM v2.
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DAMM v2 program.
    #[account(address = cp_amm::ID)]
    pub damm_program: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    /// CHECK: Token-2022 (position NFT program).
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SeedRaydiumCpmm<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: Raydium AMM config, validated by Raydium.
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: Raydium vault authority PDA, validated by Raydium.
    pub raydium_authority: UncheckedAccount<'info>,
    /// CHECK: Raydium pool PDA, validated by Raydium.
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,
    pub token_0_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_1_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: Raydium LP mint PDA, validated by Raydium.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: creator's token-0 account; the token program enforces ownership.
    #[account(mut)]
    pub creator_token_0: UncheckedAccount<'info>,
    /// CHECK: creator's token-1 account; the token program enforces ownership.
    #[account(mut)]
    pub creator_token_1: UncheckedAccount<'info>,
    /// CHECK: creator's LP associated token account, created by Raydium.
    #[account(mut)]
    pub creator_lp_token: UncheckedAccount<'info>,
    /// CHECK: Raydium vault PDA, validated by Raydium.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: Raydium vault PDA, validated by Raydium.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK: Raydium's pool-fee receiver, validated by Raydium.
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: Raydium observation PDA, validated by Raydium.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,
    /// CHECK: the Raydium CPMM program.
    #[account(address = RAYDIUM_CPMM_PROGRAM)]
    pub raydium_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token (LP mint program).
    #[account(address = anchor_spl::token::ID)]
    pub spl_token_program: UncheckedAccount<'info>,
    pub token_0_program: Interface<'info, TokenInterface>,
    pub token_1_program: Interface<'info, TokenInterface>,
    /// CHECK: associated token program.
    #[account(address = anchor_spl::associated_token::ID)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[event]
pub struct RaydiumCpmmSeeded {
    pub cross: Pubkey,
    pub pool: Pubkey,
    pub clearing_price: u64,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[derive(Accounts)]
pub struct OpenDlmmPair<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: DLMM PDA, validated by DLMM.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: DLMM PDA, validated by DLMM.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: DLMM PDA, validated by DLMM.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: DLMM PDA, validated by DLMM.
    #[account(mut)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: creator's base account, validated by DLMM.
    pub creator_base: UncheckedAccount<'info>,
    /// CHECK: creator's quote account, validated by DLMM.
    pub creator_quote: UncheckedAccount<'info>,
    /// CHECK: DLMM's event authority, validated by DLMM.
    pub dlmm_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DLMM program.
    #[account(address = lb_clmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct DlmmPairOpened {
    pub cross: Pubkey,
    pub lb_pair: Pubkey,
    pub clearing_price: u64,
    pub active_id: i32,
    pub bin_step: u16,
}

#[event]
pub struct DammV2Seeded {
    pub cross: Pubkey,
    pub pool: Pubkey,
    pub clearing_price: u64,
    pub sqrt_price: u128,
    pub liquidity: u128,
}

#[event]
pub struct DbcMintBound {
    pub cross: Pubkey,
    pub base_mint: Pubkey,
}

#[error_code]
pub enum SettleError {
    #[msg("Account is not a cross_core cross")]
    WrongCross,
    #[msg("Only the cross creator may open the DBC pool")]
    NotCreator,
    #[msg("Base mint already bound")]
    AlreadyBound,
    #[msg("Cross does not name this adapter's settler")]
    WrongSettler,
    #[msg("Quote mint does not match the cross")]
    WrongMint,
    #[msg("Cross has not cleared")]
    NotCleared,
    #[msg("DBC config must be Token-2022 with partner mint authority")]
    BadConfig,
    #[msg("DBC start price must equal the clearing price")]
    StartPriceNotClearingPrice,
    #[msg("DBC pool has not been opened for this cross")]
    PoolNotOpened,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The destination does not belong to the account the cross names for this payout")]
    WrongDestination,
    #[msg("The locked design requires migration into DAMM v2")]
    DesignMigration,
    #[msg("The locked design requires a compounding migrated pool with a compounding fee")]
    DesignNotCompounding,
    #[msg("The locked design leaves liquidity withdrawable at migration")]
    DesignUnlockedLiquidity,
    #[msg("The settler cannot vest liquidity: partner liquidity may only be locked permanently")]
    DesignPartnerVesting,
    #[msg("The locked design requires at least 20% of the liquidity locked permanently")]
    DesignLockTooLow,
    #[msg("Not a DLMM pair of this cross's mints that is open for trading")]
    WrongPair,
    #[msg("The greenshoe budget is below 10% of what the cross raised, above a level's share, or exceeds the budget")]
    GreenshoeBudget,
    #[msg("Bids are only accepted inside the greenshoe week, and the period and window parameters must be sane")]
    GreenshoeWindow,
    #[msg("That greenshoe level is invalid, already placed, not placed, or already settled")]
    GreenshoeLevel,
    #[msg("The bid must sit in the bin nearest its level, strictly below the active bin")]
    GreenshoeBin,
    #[msg("This period's greenshoe deployment cap is used up")]
    GreenshoeRateLimit,
    #[msg("The greenshoe week has not ended")]
    GreenshoeNotExpired,
    #[msg("The argument bytes are not the Borsh encoding of the expected parameters")]
    BadArgs,
    #[msg("Pass exactly two badge accounts: base then quote, or the DLMM program id for none")]
    BadgeAccounts,
    #[msg("A batch window must be between 30 seconds and 7 days")]
    BatchWindow,
    #[msg("A batch-opened pool needs a timestamp start at least the window away")]
    BatchActivation,
    #[msg("A batch-opened DAMM v2 pool must compound its fees")]
    BatchNotCompounding,
    #[msg("A batch-opened DAMM v2 pool must open with a fee that decays over time")]
    BatchFeeNotDecaying,
}

#[cfg(test)]
mod tests {
    use super::sqrt_price_q64;

    #[test]
    fn sqrt_price_matches_definition() {
        // price 1.0 (scale 1) → sqrt = 1 → 2^64
        assert_eq!(sqrt_price_q64(1, 1), Some(1u128 << 64));
        // price 4 / 1 → 2 · 2^64
        assert_eq!(sqrt_price_q64(4, 1), Some(2u128 << 64));
        // price 1_200_000 quote atoms per 1_000_000 base atoms = 1.2 → sqrt(1.2)·2^64
        let v = sqrt_price_q64(1_200_000, 1_000_000).unwrap();
        let f = (v as f64) / 2f64.powi(64);
        assert!((f - 1.2f64.sqrt()).abs() < 1e-12);
        assert_eq!(sqrt_price_q64(1, 0), None);
        use super::deposit_matches_price;
        assert_eq!(deposit_matches_price(3, 8, 10, 4), Some(true)); // 7.5 -> 7 or 8
        assert_eq!(deposit_matches_price(3, 7, 10, 4), Some(true));
        assert_eq!(deposit_matches_price(3, 9, 10, 4), Some(false));
        assert_eq!(
            deposit_matches_price(1_000_000, 1_200_000, 1_200_000, 1_000_000),
            Some(true)
        );
        assert_eq!(
            deposit_matches_price(1_000_000, 1_200_001, 1_200_000, 1_000_000),
            Some(false)
        );
        assert_eq!(deposit_matches_price(0, 1, 1, 1), None);
        // DLMM bins: id 0 = 1.0; bin step 25 bps -> id 1 = 1.0025.
        use super::{bin_contains, bin_price_q64};
        let one = ruint::aliases::U256::from(1u8) << 64usize;
        assert_eq!(bin_price_q64(0, 25), Some(one));
        assert_eq!(
            bin_price_q64(1, 25),
            Some(
                one + (ruint::aliases::U256::from(25u8) << 64usize)
                    / ruint::aliases::U256::from(10_000u32)
            )
        );
        assert_eq!(bin_contains(0, 25, 1_000_000, 1_000_000), Some(true));
        assert_eq!(bin_contains(0, 25, 1_001_000, 1_000_000), Some(true)); // +10 bps: inside half a bin
        assert_eq!(bin_contains(0, 25, 1_002_000, 1_000_000), Some(false)); // +20 bps: outside
                                                                            // 1.2 at bin step 10 bps: ln 1.2 / ln 1.001 = 182.4 -> bin 182
        assert_eq!(bin_contains(182, 10, 1_200_000, 1_000_000), Some(true));
        assert_eq!(bin_contains(183, 10, 1_200_000, 1_000_000), Some(false));
        assert_eq!(bin_contains(-182, 10, 833_333, 1_000_000), Some(true));
        // floor property on awkward values
        for (p, sc) in [
            (3u64, 7u64),
            (u64::MAX, 1),
            (1, u64::MAX),
            (999_999_937, 1_000_000),
        ] {
            let r = ruint::aliases::U256::from(sqrt_price_q64(p, sc).unwrap());
            let x = (ruint::aliases::U256::from(p) << 128usize) / ruint::aliases::U256::from(sc);
            assert!(
                r * r <= x
                    && (r + ruint::aliases::U256::from(1u8))
                        * (r + ruint::aliases::U256::from(1u8))
                        > x
            );
        }
    }
}
