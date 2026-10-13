//! Holder governance: proposals for spends above the allowance and for opening or closing the NAV
//! window, and the NAV redemption itself (ADR-0471).
//!
//! Votes are weighted by coins locked in the treasury's coin vault until the vote ends, so one coin
//! cannot vote twice and a borrowed coin cannot be returned before the tally.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::ext::{self, COINS_SEED, EXEC_WINDOW_SECS};
use crate::math;
use crate::ops::{pay_from_treasury, pay_into_treasury};
use crate::{Treasury, TreasuryError, TreasuryState, TREASURY_SEED, VAULT_SEED};

pub const PROPOSAL_SEED: &[u8] = b"proposal";
pub const VOTE_SEED: &[u8] = b"vote";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ProposalKind {
    /// Pay `amount` quote atoms to `destination`, above or below the allowance.
    Spend,
    /// Let holders redeem coins at NAV, rate limited, and freeze team spending.
    OpenNav,
    /// End the NAV window.
    CloseNav,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub treasury: Pubkey,
    pub id: u64,
    pub proposer: Pubkey,
    pub kind: ProposalKind,
    pub amount: u64,
    pub destination: Pubkey,
    pub desc_hash: [u8; 32],
    pub created_ts: i64,
    pub vote_end_ts: i64,
    pub executable_ts: i64,
    pub expires_ts: i64,
    pub yes: u64,
    pub no: u64,
    pub executed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub yes: u64,
    pub no: u64,
    pub bump: u8,
}

/// Coins that count towards quorum: everything except unvested grants.
fn circulating(supply: u64, grants_unreleased: u64) -> Result<u64> {
    Ok(supply
        .checked_sub(grants_unreleased)
        .ok_or(TreasuryError::Overflow)?)
}

pub fn propose_handler(
    ctx: Context<Propose>,
    id: u64,
    kind: ProposalKind,
    amount: u64,
    destination: Pubkey,
    desc_hash: [u8; 32],
) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(e.vote_period_secs != 0, TreasuryError::Disabled);
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    require!(id == e.proposal_count, TreasuryError::WrongProposalId);
    let proposer = ctx.accounts.proposer.key();
    if proposer != ctx.accounts.treasury.authority {
        let min = math::mul_div(
            u128::from(ctx.accounts.coin_mint.supply),
            u128::from(e.proposer_min_bps),
            math::BPS,
        )
        .ok_or(TreasuryError::Overflow)?;
        let held = u128::from(ctx.accounts.proposer_coin.amount);
        require!(held > 0 && held >= min, TreasuryError::NotHolder);
    }
    match kind {
        ProposalKind::Spend => require!(amount > 0, TreasuryError::InvalidParams),
        ProposalKind::OpenNav | ProposalKind::CloseNav => {
            require!(e.nav_period_secs != 0, TreasuryError::Disabled);
            require!(
                amount == 0 && destination == Pubkey::default(),
                TreasuryError::InvalidParams
            );
        }
    }
    let now = Clock::get()?.unix_timestamp;
    let vote_end = now
        .checked_add(e.vote_period_secs)
        .ok_or(TreasuryError::Overflow)?;
    let executable = vote_end
        .checked_add(e.timelock_secs)
        .ok_or(TreasuryError::Overflow)?;
    let p = &mut ctx.accounts.proposal;
    p.treasury = ctx.accounts.treasury.key();
    p.id = id;
    p.proposer = proposer;
    p.kind = kind;
    p.amount = amount;
    p.destination = destination;
    p.desc_hash = desc_hash;
    p.created_ts = now;
    p.vote_end_ts = vote_end;
    p.executable_ts = executable;
    p.expires_ts = executable
        .checked_add(EXEC_WINDOW_SECS)
        .ok_or(TreasuryError::Overflow)?;
    p.yes = 0;
    p.no = 0;
    p.executed = false;
    p.bump = ctx.bumps.proposal;
    e.proposal_count = e
        .proposal_count
        .checked_add(1)
        .ok_or(TreasuryError::Overflow)?;
    ext::store(&info, &e)?;
    emit!(ProposalCreated {
        treasury: p.treasury,
        proposal: p.key(),
        id,
        proposer,
        kind,
        amount,
        destination,
        vote_end_ts: vote_end
    });
    Ok(())
}

pub fn vote_handler(ctx: Context<Vote>, support: bool, amount: u64) -> Result<()> {
    require!(amount > 0, TreasuryError::InvalidParams);
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.proposal;
    require!(
        now < p.vote_end_ts && !p.executed,
        TreasuryError::VotingClosed
    );
    pay_into_treasury(
        &ctx.accounts.coin_token_program,
        &ctx.accounts.voter_coin,
        &ctx.accounts.coin_mint,
        &ctx.accounts.coin_vault,
        &ctx.accounts.voter,
        amount,
    )?;
    let r = &mut ctx.accounts.vote_record;
    if r.proposal == Pubkey::default() {
        r.proposal = p.key();
        r.voter = ctx.accounts.voter.key();
        r.bump = ctx.bumps.vote_record;
    }
    if support {
        r.yes = r.yes.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        p.yes = p.yes.checked_add(amount).ok_or(TreasuryError::Overflow)?;
    } else {
        r.no = r.no.checked_add(amount).ok_or(TreasuryError::Overflow)?;
        p.no = p.no.checked_add(amount).ok_or(TreasuryError::Overflow)?;
    }
    e.votes_locked = e
        .votes_locked
        .checked_add(amount)
        .ok_or(TreasuryError::Overflow)?;
    ext::store(&info, &e)?;
    emit!(Voted {
        proposal: p.key(),
        voter: r.voter,
        support,
        amount,
        yes: p.yes,
        no: p.no
    });
    Ok(())
}

/// After the vote ends the voter takes the locked coins back. Works in every treasury state.
pub fn reclaim_vote_handler(ctx: Context<ReclaimVote>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.proposal.vote_end_ts,
        TreasuryError::VotingOpen
    );
    let r = &ctx.accounts.vote_record;
    let back = r.yes.checked_add(r.no).ok_or(TreasuryError::Overflow)?;
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    e.votes_locked = e
        .votes_locked
        .checked_sub(back)
        .ok_or(TreasuryError::Overflow)?;
    ext::store(&info, &e)?;
    if back > 0 {
        pay_from_treasury(
            &ctx.accounts.coin_token_program,
            &ctx.accounts.coin_vault,
            &ctx.accounts.coin_mint,
            &ctx.accounts.voter_coin,
            &ctx.accounts.treasury,
            back,
        )?;
    }
    emit!(VoteReclaimed {
        proposal: ctx.accounts.proposal.key(),
        voter: ctx.accounts.voter.key(),
        amount: back
    });
    Ok(())
}

/// Anyone executes a passed proposal after its timelock and before it expires.
pub fn execute_proposal_handler(ctx: Context<ExecuteProposal>) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.proposal;
    require!(!p.executed, TreasuryError::AlreadyExecuted);
    require!(now >= p.executable_ts, TreasuryError::TimelockPending);
    require!(now <= p.expires_ts, TreasuryError::ProposalExpired);
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let supply = circulating(ctx.accounts.coin_mint.supply, e.grants_unreleased)?;
    require!(
        math::proposal_passes(p.yes, p.no, supply, e.quorum_bps, e.threshold_bps),
        TreasuryError::ProposalFailed
    );
    p.executed = true;
    match p.kind {
        ProposalKind::Spend => {
            e.guard_team_outflow(now)?;
            let cap = math::proposal_cap(ctx.accounts.vault.amount, e.max_proposal_bps)
                .ok_or(TreasuryError::Overflow)?;
            require!(p.amount <= cap, TreasuryError::OverProposalCap);
            require_keys_eq!(
                ctx.accounts.destination.key(),
                p.destination,
                TreasuryError::WrongDestination
            );
            pay_from_treasury(
                &ctx.accounts.quote_token_program,
                &ctx.accounts.vault,
                &ctx.accounts.quote_mint,
                &ctx.accounts.destination,
                &ctx.accounts.treasury,
                p.amount,
            )?;
        }
        ProposalKind::OpenNav => {
            e.nav_open = true;
            e.nav_period_start = now;
            e.nav_period_supply = ctx.accounts.coin_mint.supply;
            e.nav_burned = 0;
        }
        ProposalKind::CloseNav => e.nav_open = false,
    }
    ext::store(&info, &e)?;
    emit!(ProposalExecuted {
        proposal: p.key(),
        kind: p.kind,
        amount: p.amount
    });
    Ok(())
}

// ------------------------------------------------------------------ NAV (E3 / VM8)

/// A holder burns `amount` coins for their share of the vault at the current NAV, while the NAV
/// window is open. Rate limited per period; insiders are excluded.
pub fn nav_redeem_handler(ctx: Context<NavRedeem>, amount: u64) -> Result<()> {
    require!(amount > 0, TreasuryError::InvalidParams);
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    require!(e.nav_open, TreasuryError::NavClosed);
    let holder = ctx.accounts.holder.key();
    require!(
        !e.is_insider(&holder, &ctx.accounts.treasury.authority),
        TreasuryError::InsiderExcluded
    );
    let now = Clock::get()?.unix_timestamp;
    let supply = ctx.accounts.coin_mint.supply;
    let start = math::roll_window(e.nav_period_start, e.nav_period_secs, now)
        .ok_or(TreasuryError::Overflow)?;
    if start != e.nav_period_start {
        e.nav_period_start = start;
        e.nav_period_supply = supply;
        e.nav_burned = 0;
    }
    let cap = math::mul_div(
        u128::from(e.nav_period_supply),
        u128::from(e.nav_cap_bps),
        math::BPS,
    )
    .and_then(|c| u64::try_from(c).ok())
    .ok_or(TreasuryError::Overflow)?;
    let burned = e
        .nav_burned
        .checked_add(amount)
        .ok_or(TreasuryError::Overflow)?;
    require!(burned <= cap, TreasuryError::NavLimit);
    let payout = math::nav_payout(ctx.accounts.vault.amount, amount, supply)
        .ok_or(TreasuryError::Overflow)?;
    require!(payout > 0, TreasuryError::ZeroPayout);
    e.nav_burned = burned;
    ext::store(&info, &e)?;
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
    pay_from_treasury(
        &ctx.accounts.quote_token_program,
        &ctx.accounts.vault,
        &ctx.accounts.quote_mint,
        &ctx.accounts.holder_quote,
        &ctx.accounts.treasury,
        payout,
    )?;
    emit!(NavRedeemed {
        treasury: ctx.accounts.treasury.key(),
        holder,
        burned: amount,
        paid: payout,
        period_burned: e.nav_burned
    });
    Ok(())
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Propose<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = coin_mint, token::authority = proposer)]
    pub proposer_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = proposer, space = 8 + Proposal::INIT_SPACE,
        seeds = [PROPOSAL_SEED, treasury.key().as_ref(), &id.to_le_bytes()], bump)]
    pub proposal: Box<Account<'info, Proposal>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Vote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, has_one = treasury @ TreasuryError::WrongProposal)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(init_if_needed, payer = voter, space = 8 + VoteRecord::INIT_SPACE,
        seeds = [VOTE_SEED, proposal.key().as_ref(), voter.key().as_ref()], bump)]
    pub vote_record: Box<Account<'info, VoteRecord>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = coin_mint, token::authority = voter)]
    pub voter_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COINS_SEED, treasury.key().as_ref()], bump)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReclaimVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(has_one = treasury @ TreasuryError::WrongProposal)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(mut, close = voter, has_one = voter @ TreasuryError::Unauthorized, has_one = proposal @ TreasuryError::WrongProposal,
        seeds = [VOTE_SEED, proposal.key().as_ref(), voter.key().as_ref()], bump = vote_record.bump)]
    pub vote_record: Box<Account<'info, VoteRecord>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = coin_mint, token::authority = voter)]
    pub voter_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COINS_SEED, treasury.key().as_ref()], bump)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExecuteProposal<'info> {
    pub executor: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint, has_one = quote_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, has_one = treasury @ TreasuryError::WrongProposal)]
    pub proposal: Box<Account<'info, Proposal>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [VAULT_SEED, treasury.key().as_ref()], bump = treasury.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Receives a spend; ignored by the NAV kinds (pass any quote account).
    #[account(mut, token::mint = quote_mint)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct NavRedeem<'info> {
    pub holder: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint, has_one = quote_mint)]
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

// ------------------------------------------------------------------ events

#[event]
pub struct ProposalCreated {
    pub treasury: Pubkey,
    pub proposal: Pubkey,
    pub id: u64,
    pub proposer: Pubkey,
    pub kind: ProposalKind,
    pub amount: u64,
    pub destination: Pubkey,
    pub vote_end_ts: i64,
}

#[event]
pub struct Voted {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub support: bool,
    pub amount: u64,
    pub yes: u64,
    pub no: u64,
}

#[event]
pub struct VoteReclaimed {
    pub proposal: Pubkey,
    pub voter: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ProposalExecuted {
    pub proposal: Pubkey,
    pub kind: ProposalKind,
    pub amount: u64,
}

#[event]
pub struct NavRedeemed {
    pub treasury: Pubkey,
    pub holder: Pubkey,
    pub burned: u64,
    pub paid: u64,
    pub period_burned: u64,
}
