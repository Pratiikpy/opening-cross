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
use anchor_spl::token_interface::{self, Mint, SetAuthority, TokenInterface};

declare_program!(dynamic_bonding_curve);
declare_program!(cross_core);
declare_program!(cross_gate);
declare_program!(cp_amm);

use cross_core::accounts::Cross;

declare_id!("2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ");

pub const SETTLER_SEED: &[u8] = b"settler";
pub const DBC_CONFIG_SEED: &[u8] = b"dbc_config";
pub const BASE_MINT_SEED: &[u8] = b"base_mint";
pub const DAMM_POSITION_SEED: &[u8] = b"damm_position";

/// DBC's `PartnerUpdateAndMintAuthority`: the partner (`fee_claimer`) receives the mint authority.
const PARTNER_UPDATE_AND_MINT_AUTHORITY: u8 = 4;
/// DBC token type for Token-2022 base mints.
const TOKEN_TYPE_TOKEN_2022: u8 = 1;

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
        let cross = read_cross(&ctx.accounts.cross)?;
        require_keys_eq!(
            cross.creator,
            ctx.accounts.creator.key(),
            SettleError::NotCreator
        );
        require!(!cross.base_bound, SettleError::AlreadyBound);
        require!(
            cross.settler == Some(ctx.accounts.settler.key()),
            SettleError::WrongSettler
        );
        require_keys_eq!(
            cross.quote_mint,
            ctx.accounts.quote_mint.key(),
            SettleError::WrongMint
        );
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

        let cross_key = ctx.accounts.cross.key();
        let config_bump = [ctx.bumps.dbc_config];
        let config_seeds: &[&[u8]] = &[DBC_CONFIG_SEED, cross_key.as_ref(), &config_bump];
        dynamic_bonding_curve::cpi::create_config_with_transfer_hook(
            CpiContext::new_with_signer(
                ctx.accounts.dbc_program.key(),
                dynamic_bonding_curve::cpi::accounts::CreateConfigWithTransferHook {
                    config: ctx.accounts.dbc_config.to_account_info(),
                    fee_claimer: ctx.accounts.settler.to_account_info(),
                    leftover_receiver: ctx.accounts.leftover_receiver.to_account_info(),
                    quote_mint: ctx.accounts.quote_mint.to_account_info(),
                    transfer_hook_program: ctx.accounts.cross_gate_program.to_account_info(),
                    payer: ctx.accounts.creator.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    event_authority: ctx.accounts.dbc_event_authority.to_account_info(),
                    program: ctx.accounts.dbc_program.to_account_info(),
                },
                &[config_seeds],
            ),
            config_parameters,
        )?;

        let mint_bump = [ctx.bumps.base_mint];
        let mint_seeds: &[&[u8]] = &[BASE_MINT_SEED, cross_key.as_ref(), &mint_bump];
        dynamic_bonding_curve::cpi::initialize_virtual_pool_with_token2022_transfer_hook(
            CpiContext::new_with_signer(
                ctx.accounts.dbc_program.key(),
                dynamic_bonding_curve::cpi::accounts::InitializeVirtualPoolWithToken2022TransferHook {
                    config: ctx.accounts.dbc_config.to_account_info(),
                    pool_authority: ctx.accounts.dbc_pool_authority.to_account_info(),
                    creator: ctx.accounts.creator.to_account_info(),
                    base_mint: ctx.accounts.base_mint.to_account_info(),
                    quote_mint: ctx.accounts.quote_mint.to_account_info(),
                    pool: ctx.accounts.pool.to_account_info(),
                    base_vault: ctx.accounts.base_vault.to_account_info(),
                    quote_vault: ctx.accounts.quote_vault.to_account_info(),
                    transfer_hook_program: ctx.accounts.cross_gate_program.to_account_info(),
                    payer: ctx.accounts.creator.to_account_info(),
                    token_quote_program: ctx.accounts.quote_token_program.to_account_info(),
                    token_program: ctx.accounts.token_2022_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    event_authority: ctx.accounts.dbc_event_authority.to_account_info(),
                    program: ctx.accounts.dbc_program.to_account_info(),
                },
                &[mint_seeds],
            ),
            pool,
        )?;

        emit!(DbcPoolOpened {
            cross: cross_key,
            config: ctx.accounts.dbc_config.key(),
            pool: ctx.accounts.pool.key(),
            base_mint: ctx.accounts.base_mint.key(),
            clearing_price: clearing.price,
            sqrt_start_price: expected,
        });
        Ok(())
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
        let cross = read_cross(&ctx.accounts.cross)?;
        require_keys_eq!(
            cross.creator,
            ctx.accounts.creator.key(),
            SettleError::NotCreator
        );
        require!(cross.base_bound, SettleError::PoolNotOpened);
        require_keys_eq!(
            cross.base_mint,
            ctx.accounts.base_mint.key(),
            SettleError::WrongMint
        );
        require_keys_eq!(
            cross.quote_mint,
            ctx.accounts.quote_mint.key(),
            SettleError::WrongMint
        );
        let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;
        let expected =
            sqrt_price_q64(clearing.price, cross.price_scale).ok_or(SettleError::Overflow)?;
        require!(
            params.sqrt_price.abs_diff(expected) <= 1,
            SettleError::StartPriceNotClearingPrice
        );

        let cross_key = ctx.accounts.cross.key();
        let nft_bump = [ctx.bumps.position_nft_mint];
        let nft_seeds: &[&[u8]] = &[DAMM_POSITION_SEED, cross_key.as_ref(), &nft_bump];
        let liquidity = params.liquidity;
        cp_amm::cpi::initialize_customizable_pool(
            CpiContext::new_with_signer(
                ctx.accounts.damm_program.key(),
                cp_amm::cpi::accounts::InitializeCustomizablePool {
                    creator: ctx.accounts.creator.to_account_info(),
                    position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
                    position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
                    payer: ctx.accounts.creator.to_account_info(),
                    pool_authority: ctx.accounts.damm_pool_authority.to_account_info(),
                    pool: ctx.accounts.pool.to_account_info(),
                    position: ctx.accounts.position.to_account_info(),
                    token_a_mint: ctx.accounts.base_mint.to_account_info(),
                    token_b_mint: ctx.accounts.quote_mint.to_account_info(),
                    token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
                    token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
                    payer_token_a: ctx.accounts.creator_base.to_account_info(),
                    payer_token_b: ctx.accounts.creator_quote.to_account_info(),
                    token_a_program: ctx.accounts.base_token_program.to_account_info(),
                    token_b_program: ctx.accounts.quote_token_program.to_account_info(),
                    token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    event_authority: ctx.accounts.damm_event_authority.to_account_info(),
                    program: ctx.accounts.damm_program.to_account_info(),
                },
                &[nft_seeds],
            ),
            params,
        )?;
        emit!(DammV2Seeded {
            cross: cross_key,
            pool: ctx.accounts.pool.key(),
            clearing_price: clearing.price,
            sqrt_price: expected,
            liquidity
        });
        Ok(())
    }
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
