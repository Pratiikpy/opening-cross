//! Opening Cross treasury template (ROADMAP A5, ADR-0014).
//!
//! An ownership coin's treasury is held by this program, not by the team:
//! - the team spends at most `allowance` quote atoms per `period_secs`, and only while a Solana
//!   Attestation Service attestation for the treasury (e.g. an auditor's monthly report) is live;
//! - if the attestation lapses, anyone records the lapse; after `grace_secs` without a new one,
//!   anyone triggers liquidation, which freezes spending and snapshots the vault and the coin's
//!   supply;
//! - every holder may then burn coins for a pro-rata share of the snapshot.
//!
//! The coin's supply must be fixed (no mint authority), so the snapshot cannot be diluted.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd");

pub const TREASURY_SEED: &[u8] = b"treasury";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod treasury {
    use super::*;

    pub fn create_treasury(ctx: Context<CreateTreasury>, params: TreasuryParams) -> Result<()> {
        require!(
            params.allowance > 0 && params.period_secs > 0 && params.grace_secs >= 0,
            TreasuryError::InvalidParams
        );
        require!(
            ctx.accounts.coin_mint.mint_authority.is_none(),
            TreasuryError::SupplyNotFixed
        );
        let t = &mut ctx.accounts.treasury;
        t.authority = ctx.accounts.authority.key();
        t.coin_mint = ctx.accounts.coin_mint.key();
        t.quote_mint = ctx.accounts.quote_mint.key();
        t.quote_decimals = ctx.accounts.quote_mint.decimals;
        t.allowance = params.allowance;
        t.period_secs = params.period_secs;
        t.period_start = Clock::get()?.unix_timestamp;
        t.spent_in_period = 0;
        t.credential = params.credential;
        t.schema = params.schema;
        t.grace_secs = params.grace_secs;
        t.lapsed_since = None;
        t.state = TreasuryState::Active;
        t.snapshot_vault = 0;
        t.snapshot_supply = 0;
        t.bump = ctx.bumps.treasury;
        t.vault_bump = ctx.bumps.vault;
        emit!(TreasuryCreated {
            treasury: t.key(),
            coin_mint: t.coin_mint,
            authority: t.authority,
            allowance: t.allowance,
            period_secs: t.period_secs
        });
        Ok(())
    }

    /// The team spends within the period's allowance, only while the attestation is live.
    pub fn spend(ctx: Context<Spend>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.treasury.key();
        let t = &mut ctx.accounts.treasury;
        require!(t.state == TreasuryState::Active, TreasuryError::Liquidating);
        require!(
            attested(&ctx.accounts.attestation, t, &key, now)?,
            TreasuryError::NotAttested
        );
        t.lapsed_since = None;
        // Roll forward whole periods; unspent allowance does not carry over.
        let elapsed = now
            .checked_sub(t.period_start)
            .ok_or(TreasuryError::Overflow)?;
        if elapsed >= t.period_secs {
            let periods = elapsed
                .checked_div(t.period_secs)
                .ok_or(TreasuryError::Overflow)?;
            t.period_start = t
                .period_start
                .checked_add(
                    periods
                        .checked_mul(t.period_secs)
                        .ok_or(TreasuryError::Overflow)?,
                )
                .ok_or(TreasuryError::Overflow)?;
            t.spent_in_period = 0;
        }
        let spent = t
            .spent_in_period
            .checked_add(amount)
            .ok_or(TreasuryError::Overflow)?;
        require!(spent <= t.allowance, TreasuryError::OverAllowance);
        t.spent_in_period = spent;
        let coin = t.coin_mint;
        let seeds: &[&[u8]] = &[TREASURY_SEED, coin.as_ref(), &[t.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.quote_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.treasury.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;
        emit!(Spent {
            treasury: ctx.accounts.treasury.key(),
            amount,
            to: ctx.accounts.destination.key(),
            spent_in_period: spent
        });
        Ok(())
    }

    /// Anyone records that the attestation is missing or expired. Starts the grace clock once.
    pub fn record_lapse(ctx: Context<Observe>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.treasury.key();
        let t = &mut ctx.accounts.treasury;
        require!(t.state == TreasuryState::Active, TreasuryError::Liquidating);
        require!(
            !attested(&ctx.accounts.attestation, t, &key, now)?,
            TreasuryError::StillAttested
        );
        if t.lapsed_since.is_none() {
            t.lapsed_since = Some(now);
            emit!(AttestationLapsed {
                treasury: t.key(),
                at: now
            });
        }
        Ok(())
    }

    /// Anyone records that a live attestation is back, clearing a recorded lapse.
    pub fn record_attested(ctx: Context<Observe>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let key = ctx.accounts.treasury.key();
        let t = &mut ctx.accounts.treasury;
        require!(t.state == TreasuryState::Active, TreasuryError::Liquidating);
        require!(
            attested(&ctx.accounts.attestation, t, &key, now)?,
            TreasuryError::NotAttested
        );
        t.lapsed_since = None;
        Ok(())
    }

    /// After a lapse longer than the grace period, anyone moves the treasury into liquidation.
    pub fn trigger_liquidation(ctx: Context<Trigger>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let t = &mut ctx.accounts.treasury;
        require!(t.state == TreasuryState::Active, TreasuryError::Liquidating);
        let since = t.lapsed_since.ok_or(TreasuryError::NoLapse)?;
        require!(
            now >= since
                .checked_add(t.grace_secs)
                .ok_or(TreasuryError::Overflow)?,
            TreasuryError::GraceNotOver
        );
        t.state = TreasuryState::Liquidating;
        t.snapshot_vault = ctx.accounts.vault.amount;
        t.snapshot_supply = ctx.accounts.coin_mint.supply;
        emit!(LiquidationStarted {
            treasury: t.key(),
            vault: t.snapshot_vault,
            supply: t.snapshot_supply
        });
        Ok(())
    }

    /// A holder burns `amount` coins for `snapshot_vault · amount / snapshot_supply` quote atoms.
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        let t = &ctx.accounts.treasury;
        require!(
            t.state == TreasuryState::Liquidating,
            TreasuryError::NotLiquidating
        );
        require!(amount > 0, TreasuryError::InvalidParams);
        let payout = u64::try_from(
            u128::from(t.snapshot_vault)
                .checked_mul(u128::from(amount))
                .and_then(|x| x.checked_div(u128::from(t.snapshot_supply)))
                .ok_or(TreasuryError::Overflow)?,
        )
        .map_err(|_| TreasuryError::Overflow)?;
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.coin_token_program.key(),
                Burn {
                    mint: ctx.accounts.coin_mint.to_account_info(),
                    from: ctx.accounts.holder_coin.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            amount,
        )?;
        let coin = t.coin_mint;
        let seeds: &[&[u8]] = &[TREASURY_SEED, coin.as_ref(), &[t.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.quote_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.holder_quote.to_account_info(),
                    authority: ctx.accounts.treasury.to_account_info(),
                },
                &[seeds],
            ),
            payout,
            ctx.accounts.quote_mint.decimals,
        )?;
        emit!(Redeemed {
            treasury: ctx.accounts.treasury.key(),
            holder: ctx.accounts.holder.key(),
            burned: amount,
            paid: payout
        });
        Ok(())
    }
}

fn attested(info: &UncheckedAccount, t: &Treasury, treasury: &Pubkey, now: i64) -> Result<bool> {
    sas_attestation::is_valid(info, &t.credential, &t.schema, treasury, now)
        .ok_or_else(|| error!(TreasuryError::WrongAttestationAccount))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum TreasuryState {
    Active,
    Liquidating,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct TreasuryParams {
    /// Quote atoms the team may spend per period.
    pub allowance: u64,
    pub period_secs: i64,
    /// How long a recorded lapse must last before liquidation may be triggered.
    pub grace_secs: i64,
    /// SAS credential and schema whose attestation (nonce = this treasury) keeps it active.
    pub credential: Pubkey,
    pub schema: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub authority: Pubkey,
    pub coin_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub quote_decimals: u8,
    pub allowance: u64,
    pub period_secs: i64,
    pub period_start: i64,
    pub spent_in_period: u64,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub grace_secs: i64,
    pub lapsed_since: Option<i64>,
    pub state: TreasuryState,
    pub snapshot_vault: u64,
    pub snapshot_supply: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
pub struct CreateTreasury<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = authority, space = 8 + Treasury::INIT_SPACE, seeds = [TREASURY_SEED, coin_mint.key().as_ref()], bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(init, payer = authority, seeds = [VAULT_SEED, treasury.key().as_ref()], bump, token::mint = quote_mint, token::authority = treasury, token::token_program = quote_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = authority @ TreasuryError::Unauthorized, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    /// CHECK: the SAS attestation for this treasury; address, owner and contents checked in `attested`.
    pub attestation: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, treasury.key().as_ref()], bump = treasury.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Observe<'info> {
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    /// CHECK: the SAS attestation for this treasury; address, owner and contents checked in `attested`.
    pub attestation: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Trigger<'info> {
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [VAULT_SEED, treasury.key().as_ref()], bump = treasury.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub holder: Signer<'info>,
    #[account(seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut)]
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = coin_mint, token::authority = holder)]
    pub holder_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint)]
    pub holder_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [VAULT_SEED, treasury.key().as_ref()], bump = treasury.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct TreasuryCreated {
    pub treasury: Pubkey,
    pub coin_mint: Pubkey,
    pub authority: Pubkey,
    pub allowance: u64,
    pub period_secs: i64,
}

#[event]
pub struct Spent {
    pub treasury: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
    pub spent_in_period: u64,
}

#[event]
pub struct AttestationLapsed {
    pub treasury: Pubkey,
    pub at: i64,
}

#[event]
pub struct LiquidationStarted {
    pub treasury: Pubkey,
    pub vault: u64,
    pub supply: u64,
}

#[event]
pub struct Redeemed {
    pub treasury: Pubkey,
    pub holder: Pubkey,
    pub burned: u64,
    pub paid: u64,
}

#[error_code]
pub enum TreasuryError {
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("The coin's supply must be fixed: its mint authority must be revoked")]
    SupplyNotFixed,
    #[msg("Only the treasury authority may spend")]
    Unauthorized,
    #[msg("The treasury is in liquidation")]
    Liquidating,
    #[msg("The treasury is not in liquidation")]
    NotLiquidating,
    #[msg("No live attestation for this treasury")]
    NotAttested,
    #[msg("The attestation is still live")]
    StillAttested,
    #[msg("That is not this treasury's attestation account")]
    WrongAttestationAccount,
    #[msg("Spend exceeds this period's allowance")]
    OverAllowance,
    #[msg("No lapse has been recorded")]
    NoLapse,
    #[msg("The grace period after the lapse has not ended")]
    GraceNotOver,
    #[msg("Arithmetic overflow")]
    Overflow,
}
