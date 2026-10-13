//! Pro-rata distributions to staked coins and the verified-revenue rounds that feed them
//! (ADR-0472).
//!
//! Coins are staked into the treasury's coin vault and can be taken out at any time, in any state.
//! Quote tokens deposited for distribution accrue to stakers through a per-coin accumulator, so a
//! deposit costs the same however many holders there are and nobody has to be paid one by one.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::ext::{self, Ext, COINS_SEED, DIST_SEED};
use crate::math;
use crate::ops::{pay_from_treasury, pay_into_treasury};
use crate::{Treasury, TreasuryError, TreasuryState, TREASURY_SEED, VAULT_SEED};

pub const STAKE_SEED: &[u8] = b"stake";
pub const ROUND_SEED: &[u8] = b"round";
/// Rounds are counted from zero; a bound keeps indices from being used as an overflow lever.
pub const MAX_ROUND: u64 = 1_000_000;

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub treasury: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// `floor(amount * acc / PREC)` as of the last change; pending reward is the growth since.
    pub debt: u128,
    /// Reward settled but not yet claimed.
    pub pending: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RoundRecord {
    pub treasury: Pubkey,
    pub round: u64,
    pub revenue: u64,
    pub due: u64,
    pub missed: bool,
    pub tranche_released: bool,
    pub bump: u8,
}

/// The attestation nonce for a round: `sha256("oc-round" ‖ treasury ‖ round)`. The revenue attester
/// signs one attestation per round at the SAS address derived from it.
pub fn round_nonce(treasury: &Pubkey, round: u64) -> Pubkey {
    Pubkey::new_from_array(
        solana_sha256_hasher::hashv(&[b"oc-round", treasury.as_ref(), &round.to_le_bytes()])
            .to_bytes(),
    )
}

/// Releases the part of the stream that has run since it last advanced into the accumulator. While nobody is staked
/// nothing is released: time passes, and whoever stakes next receives what is left.
fn update_stream(e: &mut Ext, now: i64) -> Result<()> {
    if e.stream_amount == 0 {
        return Ok(());
    }
    let upto = now.min(e.stream_end);
    if e.total_staked == 0 {
        e.stream_last = e.stream_last.max(upto);
        return Ok(());
    }
    let released = math::stream_release(e.stream_amount, e.stream_last, e.stream_end, now)
        .ok_or(TreasuryError::Overflow)?;
    if released > 0 {
        let d = math::acc_delta(released, e.total_staked).ok_or(TreasuryError::Overflow)?;
        e.acc_per_stake = e
            .acc_per_stake
            .checked_add(d)
            .ok_or(TreasuryError::Overflow)?;
        e.stream_amount = e
            .stream_amount
            .checked_sub(released)
            .ok_or(TreasuryError::Overflow)?;
    }
    e.stream_last = e.stream_last.max(upto);
    Ok(())
}

/// Adds a deposit to the stream. What was still streaming joins it and the whole runs for a fresh `stream_secs`.
fn add_stream(e: &mut Ext, amount: u64, now: i64) -> Result<()> {
    update_stream(e, now)?;
    e.stream_amount = e
        .stream_amount
        .checked_add(amount)
        .ok_or(TreasuryError::Overflow)?;
    e.stream_last = now;
    e.stream_end = now
        .checked_add(e.stream_secs)
        .ok_or(TreasuryError::Overflow)?;
    update_stream(e, now)
}

fn settle(p: &mut Position, acc: u128) -> Result<()> {
    let earned = math::pending_since(p.amount, acc, p.debt).ok_or(TreasuryError::Overflow)?;
    p.pending = p
        .pending
        .checked_add(earned)
        .ok_or(TreasuryError::Overflow)?;
    p.debt = math::scaled(p.amount, acc).ok_or(TreasuryError::Overflow)?;
    Ok(())
}

pub fn stake_handler(ctx: Context<Stake>, amount: u64) -> Result<()> {
    require!(amount > 0, TreasuryError::InvalidParams);
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    let now = Clock::get()?.unix_timestamp;
    update_stream(&mut e, now)?;
    let was_empty = e.total_staked == 0;
    pay_into_treasury(
        &ctx.accounts.coin_token_program,
        &ctx.accounts.owner_coin,
        &ctx.accounts.coin_mint,
        &ctx.accounts.coin_vault,
        &ctx.accounts.owner,
        amount,
    )?;
    let p = &mut ctx.accounts.position;
    if p.owner == Pubkey::default() {
        p.treasury = ctx.accounts.treasury.key();
        p.owner = ctx.accounts.owner.key();
        p.bump = ctx.bumps.position;
    }
    settle(p, e.acc_per_stake)?;
    p.amount = p
        .amount
        .checked_add(amount)
        .ok_or(TreasuryError::Overflow)?;
    p.debt = math::scaled(p.amount, e.acc_per_stake).ok_or(TreasuryError::Overflow)?;
    e.total_staked = e
        .total_staked
        .checked_add(amount)
        .ok_or(TreasuryError::Overflow)?;
    if was_empty {
        // A stream that waited for a first staker (its window already over) is released to them now.
        update_stream(&mut e, now)?;
    }
    ext::store(&info, &e)?;
    emit!(Staked {
        treasury: ctx.accounts.treasury.key(),
        owner: p.owner,
        amount,
        total_staked: e.total_staked
    });
    Ok(())
}

/// Takes staked coins back. Settles the reward first, so nothing earned is lost. Works in every
/// treasury state: an exit is never blocked.
pub fn unstake_handler(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    require!(amount > 0, TreasuryError::InvalidParams);
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    update_stream(&mut e, Clock::get()?.unix_timestamp)?;
    let p = &mut ctx.accounts.position;
    settle(p, e.acc_per_stake)?;
    p.amount = p
        .amount
        .checked_sub(amount)
        .ok_or(TreasuryError::Overflow)?;
    p.debt = math::scaled(p.amount, e.acc_per_stake).ok_or(TreasuryError::Overflow)?;
    e.total_staked = e
        .total_staked
        .checked_sub(amount)
        .ok_or(TreasuryError::Overflow)?;
    ext::store(&info, &e)?;
    pay_from_treasury(
        &ctx.accounts.coin_token_program,
        &ctx.accounts.coin_vault,
        &ctx.accounts.coin_mint,
        &ctx.accounts.owner_coin,
        &ctx.accounts.treasury,
        amount,
    )?;
    emit!(Unstaked {
        treasury: ctx.accounts.treasury.key(),
        owner: p.owner,
        amount,
        total_staked: e.total_staked
    });
    Ok(())
}

/// Anyone adds quote tokens to the pot stakers share (a dividend, a buyback return, a revenue
/// share paid by hand).
pub fn deposit_distribution_handler(ctx: Context<DepositDistribution>, amount: u64) -> Result<()> {
    require!(amount > 0, TreasuryError::InvalidParams);
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    pay_into_treasury(
        &ctx.accounts.quote_token_program,
        &ctx.accounts.depositor_quote,
        &ctx.accounts.quote_mint,
        &ctx.accounts.dist_vault,
        &ctx.accounts.depositor,
        amount,
    )?;
    add_stream(&mut e, amount, Clock::get()?.unix_timestamp)?;
    ext::store(&info, &e)?;
    emit!(DistributionDeposited {
        treasury: ctx.accounts.treasury.key(),
        from: ctx.accounts.depositor.key(),
        amount,
        total_staked: e.total_staked
    });
    Ok(())
}

pub fn claim_distribution_handler(ctx: Context<ClaimDistribution>) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    update_stream(&mut e, Clock::get()?.unix_timestamp)?;
    ext::store(&info, &e)?;
    let p = &mut ctx.accounts.position;
    settle(p, e.acc_per_stake)?;
    let amount = p.pending;
    require!(amount > 0, TreasuryError::NothingToClaim);
    p.pending = 0;
    pay_from_treasury(
        &ctx.accounts.quote_token_program,
        &ctx.accounts.dist_vault,
        &ctx.accounts.quote_mint,
        &ctx.accounts.owner_quote,
        &ctx.accounts.treasury,
        amount,
    )?;
    emit!(DistributionClaimed {
        treasury: ctx.accounts.treasury.key(),
        owner: p.owner,
        amount
    });
    Ok(())
}

// ------------------------------------------------------------------ verified-revenue rounds (V3 / Y6)

/// The attested revenue of a round: the first eight bytes of the attestation's data, little endian,
/// in quote atoms. `None` when the attestation is not valid for this round.
fn attested_revenue(
    e: &Ext,
    attestation: &AccountInfo,
    treasury: &Pubkey,
    round: u64,
    now: i64,
) -> Result<Option<u64>> {
    let nonce = round_nonce(treasury, round);
    let valid =
        sas_attestation::is_valid(attestation, &e.rev_credential, &e.rev_schema, &nonce, now)
            .ok_or_else(|| error!(TreasuryError::WrongAttestationAccount))?;
    if !valid {
        return Ok(None);
    }
    let data = attestation.try_borrow_data()?;
    let len = data
        .get(97..101)
        .and_then(|b| <[u8; 4]>::try_from(b).ok())
        .map(u32::from_le_bytes)
        .and_then(|l| usize::try_from(l).ok())
        .ok_or(TreasuryError::BadRevenueData)?;
    require!(len >= 8, TreasuryError::BadRevenueData);
    let revenue = data
        .get(101..109)
        .and_then(|b| <[u8; 8]>::try_from(b).ok())
        .map(u64::from_le_bytes)
        .ok_or(TreasuryError::BadRevenueData)?;
    Ok(Some(revenue))
}

fn round_window(e: &Ext, round: u64) -> Result<(i64, i64)> {
    require!(round < MAX_ROUND, TreasuryError::InvalidParams);
    let end = math::round_start(
        e.rev_start,
        e.round_secs,
        round.checked_add(1).ok_or(TreasuryError::Overflow)?,
    )
    .ok_or(TreasuryError::Overflow)?;
    let deadline = end
        .checked_add(e.pay_grace_secs)
        .ok_or(TreasuryError::Overflow)?;
    Ok((end, deadline))
}

/// Pays holders their share of a round's attested revenue. Anyone may pay (the company, a
/// sponsor); the amount is fixed by the attestation: `ceil(revenue * share_bps / 10000)`. The
/// round must be over and the payment window open.
pub fn pay_round_handler(ctx: Context<PayRound>, round: u64) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(e.rev_share_bps != 0, TreasuryError::Disabled);
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let now = Clock::get()?.unix_timestamp;
    let (end, deadline) = round_window(&e, round)?;
    require!(now >= end, TreasuryError::RoundOpen);
    require!(now <= deadline, TreasuryError::RoundClosed);
    let revenue = attested_revenue(
        &e,
        &ctx.accounts.attestation,
        &ctx.accounts.treasury.key(),
        round,
        now,
    )?
    .ok_or(TreasuryError::NotAttested)?;
    let due = math::round_due(revenue, e.rev_share_bps).ok_or(TreasuryError::Overflow)?;
    let r = &mut ctx.accounts.round_record;
    r.treasury = ctx.accounts.treasury.key();
    r.round = round;
    r.revenue = revenue;
    r.due = due;
    r.missed = false;
    r.tranche_released = false;
    r.bump = ctx.bumps.round_record;
    if due > 0 {
        pay_into_treasury(
            &ctx.accounts.quote_token_program,
            &ctx.accounts.payer_quote,
            &ctx.accounts.quote_mint,
            &ctx.accounts.dist_vault,
            &ctx.accounts.payer,
            due,
        )?;
        add_stream(&mut e, due, now)?;
        ext::store(&info, &e)?;
    }
    emit!(RoundPaid {
        treasury: r.treasury,
        round,
        revenue,
        due,
        payer: ctx.accounts.payer.key()
    });
    Ok(())
}

/// Anyone records that a round was not paid in time. It opens the NAV window: a company that
/// stops reporting or paying hands holders the exit (ADR-0472).
pub fn mark_missed_handler(ctx: Context<MarkMissed>, round: u64) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(e.rev_share_bps != 0, TreasuryError::Disabled);
    let now = Clock::get()?.unix_timestamp;
    let (_, deadline) = round_window(&e, round)?;
    require!(now > deadline, TreasuryError::RoundNotLate);
    let r = &mut ctx.accounts.round_record;
    r.treasury = ctx.accounts.treasury.key();
    r.round = round;
    r.revenue = 0;
    r.due = 0;
    r.missed = true;
    r.tranche_released = false;
    r.bump = ctx.bumps.round_record;
    e.missed_rounds = e
        .missed_rounds
        .checked_add(1)
        .ok_or(TreasuryError::Overflow)?;
    if e.nav_period_secs != 0 && !e.nav_open {
        e.nav_open = true;
        e.nav_period_start = now;
        e.nav_period_supply = ctx.accounts.coin_mint.supply;
        e.nav_burned = 0;
    }
    ext::store(&info, &e)?;
    emit!(RoundMissed {
        treasury: r.treasury,
        round,
        nav_open: e.nav_open
    });
    Ok(())
}

/// After a paid round whose attested revenue met the bar, the team may release one tranche from
/// the vault, once per round.
pub fn release_tranche_handler(ctx: Context<ReleaseTranche>, round: u64) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let e = ext::require(&info)?;
    require!(e.tranche_amount != 0, TreasuryError::Disabled);
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let now = Clock::get()?.unix_timestamp;
    e.guard_team_outflow(now)?;
    let r = &mut ctx.accounts.round_record;
    require!(r.round == round, TreasuryError::WrongProposal);
    require!(
        !r.missed && !r.tranche_released && r.revenue >= e.tranche_min_revenue,
        TreasuryError::TrancheNotEligible
    );
    require!(
        ctx.accounts.vault.amount >= e.tranche_amount,
        TreasuryError::TrancheNotEligible
    );
    r.tranche_released = true;
    pay_from_treasury(
        &ctx.accounts.quote_token_program,
        &ctx.accounts.vault,
        &ctx.accounts.quote_mint,
        &ctx.accounts.destination,
        &ctx.accounts.treasury,
        e.tranche_amount,
    )?;
    emit!(TrancheReleased {
        treasury: ctx.accounts.treasury.key(),
        round,
        amount: e.tranche_amount
    });
    Ok(())
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init_if_needed, payer = owner, space = 8 + Position::INIT_SPACE,
        seeds = [STAKE_SEED, treasury.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = coin_mint, token::authority = owner)]
    pub owner_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COINS_SEED, treasury.key().as_ref()], bump)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = owner @ TreasuryError::Unauthorized, has_one = treasury @ TreasuryError::WrongProposal,
        seeds = [STAKE_SEED, treasury.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = coin_mint, token::authority = owner)]
    pub owner_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COINS_SEED, treasury.key().as_ref()], bump)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct DepositDistribution<'info> {
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = quote_mint, token::authority = depositor)]
    pub depositor_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [DIST_SEED, treasury.key().as_ref()], bump)]
    pub dist_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimDistribution<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = owner @ TreasuryError::Unauthorized, has_one = treasury @ TreasuryError::WrongProposal,
        seeds = [STAKE_SEED, treasury.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, token::mint = quote_mint)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [DIST_SEED, treasury.key().as_ref()], bump)]
    pub dist_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(round: u64)]
pub struct PayRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = quote_mint, token::authority = payer)]
    pub payer_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [DIST_SEED, treasury.key().as_ref()], bump)]
    pub dist_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the revenue attestation for this round; address, owner and contents are checked by
    /// `sas_attestation::is_valid` against the nonce derived from the treasury and the round.
    pub attestation: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + RoundRecord::INIT_SPACE,
        seeds = [ROUND_SEED, treasury.key().as_ref(), &round.to_le_bytes()], bump)]
    pub round_record: Box<Account<'info, RoundRecord>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round: u64)]
pub struct MarkMissed<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = caller, space = 8 + RoundRecord::INIT_SPACE,
        seeds = [ROUND_SEED, treasury.key().as_ref(), &round.to_le_bytes()], bump)]
    pub round_record: Box<Account<'info, RoundRecord>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round: u64)]
pub struct ReleaseTranche<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump,
        has_one = authority @ TreasuryError::Unauthorized, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, has_one = treasury @ TreasuryError::WrongProposal,
        seeds = [ROUND_SEED, treasury.key().as_ref(), &round.to_le_bytes()], bump = round_record.bump)]
    pub round_record: Box<Account<'info, RoundRecord>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, treasury.key().as_ref()], bump = treasury.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

// ------------------------------------------------------------------ events

#[event]
pub struct Staked {
    pub treasury: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct Unstaked {
    pub treasury: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct DistributionDeposited {
    pub treasury: Pubkey,
    pub from: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct DistributionClaimed {
    pub treasury: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RoundPaid {
    pub treasury: Pubkey,
    pub round: u64,
    pub revenue: u64,
    pub due: u64,
    pub payer: Pubkey,
}

#[event]
pub struct RoundMissed {
    pub treasury: Pubkey,
    pub round: u64,
    pub nav_open: bool,
}

#[event]
pub struct TrancheReleased {
    pub treasury: Pubkey,
    pub round: u64,
    pub amount: u64,
}
