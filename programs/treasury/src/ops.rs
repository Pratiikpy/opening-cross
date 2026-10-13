//! Extension set-up, the disclosure feed, the assignment gate, the wind-down sweep and shared
//! token helpers.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::ext::{self, Ext, ExtParams, COINS_SEED, DIST_SEED};
use crate::{Treasury, TreasuryError, TreasuryState, TREASURY_SEED};

/// Moves tokens out of a treasury-owned token account, signed by the treasury PDA.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn pay_from_treasury<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    treasury: &Account<'info, Treasury>,
    amount: u64,
) -> Result<()> {
    let coin = treasury.coin_mint;
    let seeds: &[&[u8]] = &[TREASURY_SEED, coin.as_ref(), &[treasury.bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: treasury.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Moves tokens from a user's account into a treasury-owned one, signed by the user.
#[inline(never)]
pub fn pay_into_treasury<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    authority: &Signer<'info>,
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

/// Burns coins held by a treasury-owned token account, signed by the treasury PDA.
#[inline(never)]
pub fn burn_from_treasury<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    treasury: &Account<'info, Treasury>,
    amount: u64,
) -> Result<()> {
    let coin = treasury.coin_mint;
    let seeds: &[&[u8]] = &[TREASURY_SEED, coin.as_ref(), &[treasury.bump]];
    token_interface::burn(
        CpiContext::new_with_signer(
            token_program.key(),
            Burn {
                mint: mint.to_account_info(),
                from: from.to_account_info(),
                authority: treasury.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

// ------------------------------------------------------------------ extend

pub fn init_ext_handler(ctx: Context<InitExt>, params: ExtParams) -> Result<()> {
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let info = ctx.accounts.treasury.to_account_info();
    require!(ext::load(&info)?.is_none(), TreasuryError::AlreadyExtended);
    params.validate()?;
    // Rounds are counted from `rev_start`; one in the past would let anyone mark round zero missed at once.
    require!(
        params.rev_share_bps == 0 || params.rev_start >= Clock::get()?.unix_timestamp,
        TreasuryError::InvalidParams
    );
    let e = Ext::new(&params, ctx.bumps.coin_vault, ctx.bumps.dist_vault);
    ext::store(&info, &e)?;
    emit!(TreasuryExtended {
        treasury: ctx.accounts.treasury.key(),
        governance: e.vote_period_secs != 0,
        nav: e.nav_period_secs != 0,
        revenue: e.rev_share_bps != 0,
        disclosure: e.disclosure_period_secs != 0,
        assignment_required: e.assign_required,
        wind_down: e.window_secs != 0,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitExt<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump,
        has_one = authority @ TreasuryError::Unauthorized,
        has_one = coin_mint, has_one = quote_mint,
        realloc = Ext::TOTAL, realloc::payer = authority, realloc::zero = true
    )]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = authority, seeds = [COINS_SEED, treasury.key().as_ref()], bump,
        token::mint = coin_mint, token::authority = treasury, token::token_program = coin_token_program)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = authority, seeds = [DIST_SEED, treasury.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = treasury, token::token_program = quote_token_program)]
    pub dist_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------ disclosure (E5)

/// The team posts a disclosure (the hash of the published report). Clears an open holder request.
pub fn post_disclosure_handler(ctx: Context<PostDisclosure>, hash: [u8; 32]) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(e.disclosure_period_secs != 0, TreasuryError::Disabled);
    let now = Clock::get()?.unix_timestamp;
    e.last_disclosure_ts = now;
    e.last_disclosure_hash = hash;
    e.disclosures = e
        .disclosures
        .checked_add(1)
        .ok_or(TreasuryError::Overflow)?;
    e.open_request_ts = 0;
    ext::store(&info, &e)?;
    emit!(DisclosurePosted {
        treasury: ctx.accounts.treasury.key(),
        hash,
        at: now,
        count: e.disclosures
    });
    Ok(())
}

/// A holder asks for a disclosure. Only one request is open at a time; the clock starts at the
/// first. While a request is overdue the team cannot spend.
pub fn request_disclosure_handler(ctx: Context<RequestDisclosure>) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(e.disclosure_period_secs != 0, TreasuryError::Disabled);
    let supply = u128::from(ctx.accounts.coin_mint.supply);
    let held = u128::from(ctx.accounts.holder_coin.amount);
    let min = supply
        .checked_mul(u128::from(e.request_min_bps))
        .and_then(|x| x.checked_div(crate::math::BPS))
        .ok_or(TreasuryError::Overflow)?;
    require!(held > 0 && held >= min, TreasuryError::NotHolder);
    let now = Clock::get()?.unix_timestamp;
    if e.open_request_ts == 0 {
        e.open_request_ts = now;
        ext::store(&info, &e)?;
    }
    emit!(DisclosureRequested {
        treasury: ctx.accounts.treasury.key(),
        holder: ctx.accounts.holder.key(),
        open_since: e.open_request_ts
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PostDisclosure<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump,
        has_one = authority @ TreasuryError::Unauthorized)]
    pub treasury: Box<Account<'info, Treasury>>,
}

#[derive(Accounts)]
pub struct RequestDisclosure<'info> {
    pub holder: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = coin_mint, token::authority = holder)]
    pub holder_coin: Box<InterfaceAccount<'info, TokenAccount>>,
}

// ------------------------------------------------------------------ assignment (E6)

/// Anyone records that counsel's attestation of the IP and asset assignment exists. It unlocks
/// team outflows for a treasury created with `assign_required`.
pub fn record_assignment_handler(ctx: Context<RecordAssignment>) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(e.assign_required, TreasuryError::Disabled);
    require!(!e.assigned, TreasuryError::AlreadyAssigned);
    let now = Clock::get()?.unix_timestamp;
    let ok = sas_attestation::is_valid(
        &ctx.accounts.attestation,
        &e.assign_credential,
        &e.assign_schema,
        &ctx.accounts.treasury.key(),
        now,
    )
    .ok_or_else(|| error!(TreasuryError::WrongAttestationAccount))?;
    require!(ok, TreasuryError::NotAttested);
    e.assigned = true;
    ext::store(&info, &e)?;
    emit!(AssignmentRecorded {
        treasury: ctx.accounts.treasury.key()
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RecordAssignment<'info> {
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    /// CHECK: the SAS attestation for this treasury; address, owner and contents checked by
    /// `sas_attestation::is_valid`.
    pub attestation: UncheckedAccount<'info>,
}

// ------------------------------------------------------------------ wind-down (E7)

/// After the withdraw-only window of a liquidation, anyone moves what holders never redeemed to
/// the recovery account named when the treasury was extended.
pub fn sweep_unclaimed_handler(ctx: Context<SweepUnclaimed>) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(e.window_secs != 0, TreasuryError::Disabled);
    require!(
        ctx.accounts.treasury.state == TreasuryState::Liquidating,
        TreasuryError::NotLiquidating
    );
    require!(!e.swept, TreasuryError::AlreadySwept);
    let now = Clock::get()?.unix_timestamp;
    let ends = e
        .wind_start
        .checked_add(e.window_secs)
        .ok_or(TreasuryError::Overflow)?;
    require!(now >= ends, TreasuryError::WindowOpen);
    require_keys_eq!(
        ctx.accounts.recovery_quote.owner,
        e.recovery,
        TreasuryError::WrongRecovery
    );
    let left = ctx.accounts.vault.amount;
    e.swept = true;
    ext::store(&info, &e)?;
    if left > 0 {
        pay_from_treasury(
            &ctx.accounts.quote_token_program,
            &ctx.accounts.vault,
            &ctx.accounts.quote_mint,
            &ctx.accounts.recovery_quote,
            &ctx.accounts.treasury,
            left,
        )?;
    }
    emit!(UnclaimedSwept {
        treasury: ctx.accounts.treasury.key(),
        amount: left,
        to: ctx.accounts.recovery_quote.key()
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SweepUnclaimed<'info> {
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [crate::VAULT_SEED, treasury.key().as_ref()], bump = treasury.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint)]
    pub recovery_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------ events

#[event]
pub struct TreasuryExtended {
    pub treasury: Pubkey,
    pub governance: bool,
    pub nav: bool,
    pub revenue: bool,
    pub disclosure: bool,
    pub assignment_required: bool,
    pub wind_down: bool,
}

#[event]
pub struct DisclosurePosted {
    pub treasury: Pubkey,
    pub hash: [u8; 32],
    pub at: i64,
    pub count: u32,
}

#[event]
pub struct DisclosureRequested {
    pub treasury: Pubkey,
    pub holder: Pubkey,
    pub open_since: i64,
}

#[event]
pub struct AssignmentRecorded {
    pub treasury: Pubkey,
}

#[event]
pub struct UnclaimedSwept {
    pub treasury: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
}
