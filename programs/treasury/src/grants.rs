//! Milestone-unlocked team tokens with a minimum lockup, and the earn-out and carve-out terms built
//! from them (ADR-0473).
//!
//! The team escrows coins in the treasury's coin vault. Each milestone releases a share of the grant
//! once the lockup has ended: a carve-out milestone needs nothing else, an earn-out milestone needs
//! a live attestation that the milestone was reached. Whatever is not released by `expiry_ts`, or
//! at all once the treasury liquidates, is burned, which raises the value of every other coin.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::ext::{self, COINS_SEED};
use crate::math;
use crate::ops::{burn_from_treasury, pay_from_treasury, pay_into_treasury};
use crate::{Treasury, TreasuryError, TreasuryState, TREASURY_SEED};

pub const GRANT_SEED: &[u8] = b"grant";
pub const MAX_MILESTONES: usize = 4;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct Milestone {
    /// Share of the grant this milestone releases, in basis points.
    pub bps: u16,
    /// False: a carve-out, released when the lockup ends. True: an earn-out, released only against
    /// a live attestation at `milestone_nonce(grant, index)` under the grant's credential and schema.
    pub requires_attestation: bool,
    pub released: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct GrantParams {
    pub beneficiary: Pubkey,
    pub total: u64,
    pub lockup_end: i64,
    pub expiry_ts: i64,
    pub milestones: [Milestone; MAX_MILESTONES],
    pub milestone_count: u8,
    pub credential: Pubkey,
    pub schema: Pubkey,
}

#[account]
#[derive(InitSpace)]
pub struct Grant {
    pub treasury: Pubkey,
    pub id: u64,
    pub beneficiary: Pubkey,
    pub total: u64,
    pub released: u64,
    pub lockup_end: i64,
    pub expiry_ts: i64,
    pub milestones: [Milestone; MAX_MILESTONES],
    pub milestone_count: u8,
    pub credential: Pubkey,
    pub schema: Pubkey,
    pub burned: bool,
    pub bump: u8,
}

/// The attestation nonce of a milestone: `sha256("oc-milestone" ‖ grant ‖ index)`.
pub fn milestone_nonce(grant: &Pubkey, index: u8) -> Pubkey {
    Pubkey::new_from_array(
        solana_sha256_hasher::hashv(&[b"oc-milestone", grant.as_ref(), &[index]]).to_bytes(),
    )
}

pub fn create_grant_handler(ctx: Context<CreateGrant>, id: u64, p: GrantParams) -> Result<()> {
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    require!(id == e.grant_count, TreasuryError::WrongProposalId);
    let now = Clock::get()?.unix_timestamp;
    let count = usize::from(p.milestone_count);
    require!(
        p.total > 0 && (1..=MAX_MILESTONES).contains(&count),
        TreasuryError::GrantInvalid
    );
    let mut sum: u32 = 0;
    let mut attested = false;
    for (i, m) in p.milestones.iter().enumerate() {
        if i < count {
            require!(m.bps > 0 && !m.released, TreasuryError::GrantInvalid);
            sum = sum
                .checked_add(u32::from(m.bps))
                .ok_or(TreasuryError::Overflow)?;
            attested |= m.requires_attestation;
        } else {
            require!(
                m.bps == 0 && !m.requires_attestation && !m.released,
                TreasuryError::GrantInvalid
            );
        }
    }
    require!(sum <= 10_000, TreasuryError::GrantInvalid);
    require!(
        !attested || (p.credential != Pubkey::default() && p.schema != Pubkey::default()),
        TreasuryError::GrantInvalid
    );
    require!(
        p.beneficiary != Pubkey::default(),
        TreasuryError::GrantInvalid
    );
    let earliest = now
        .checked_add(e.min_lockup_secs)
        .ok_or(TreasuryError::Overflow)?;
    require!(p.lockup_end >= earliest, TreasuryError::LockupTooShort);
    require!(p.expiry_ts > p.lockup_end, TreasuryError::GrantInvalid);

    pay_into_treasury(
        &ctx.accounts.coin_token_program,
        &ctx.accounts.authority_coin,
        &ctx.accounts.coin_mint,
        &ctx.accounts.coin_vault,
        &ctx.accounts.authority,
        p.total,
    )?;
    let g = &mut ctx.accounts.grant;
    g.treasury = ctx.accounts.treasury.key();
    g.id = id;
    g.beneficiary = p.beneficiary;
    g.total = p.total;
    g.released = 0;
    g.lockup_end = p.lockup_end;
    g.expiry_ts = p.expiry_ts;
    g.milestones = p.milestones;
    g.milestone_count = p.milestone_count;
    g.credential = p.credential;
    g.schema = p.schema;
    g.burned = false;
    g.bump = ctx.bumps.grant;
    e.grant_count = e
        .grant_count
        .checked_add(1)
        .ok_or(TreasuryError::Overflow)?;
    e.grants_unreleased = e
        .grants_unreleased
        .checked_add(p.total)
        .ok_or(TreasuryError::Overflow)?;
    ext::store(&info, &e)?;
    emit!(GrantCreated {
        treasury: g.treasury,
        grant: g.key(),
        id,
        beneficiary: g.beneficiary,
        total: g.total,
        lockup_end: g.lockup_end,
        expiry_ts: g.expiry_ts
    });
    Ok(())
}

/// Anyone releases one milestone to the beneficiary once the lockup has ended and, for an earn-out,
/// the attestation is live. Each milestone releases once.
pub fn release_milestone_handler(ctx: Context<ReleaseMilestone>, index: u8) -> Result<()> {
    require!(
        ctx.accounts.treasury.state == TreasuryState::Active,
        TreasuryError::Liquidating
    );
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.grant;
    require!(!g.burned, TreasuryError::GrantExpired);
    require!(now >= g.lockup_end, TreasuryError::MilestoneNotReady);
    require!(now < g.expiry_ts, TreasuryError::GrantExpired);
    require!(index < g.milestone_count, TreasuryError::GrantInvalid);
    let i = usize::from(index);
    let m = *g.milestones.get(i).ok_or(TreasuryError::GrantInvalid)?;
    require!(!m.released, TreasuryError::AlreadyReleased);
    if m.requires_attestation {
        let nonce = milestone_nonce(&g.key(), index);
        let ok = sas_attestation::is_valid(
            &ctx.accounts.attestation,
            &g.credential,
            &g.schema,
            &nonce,
            now,
        )
        .ok_or_else(|| error!(TreasuryError::WrongAttestationAccount))?;
        require!(ok, TreasuryError::NotAttested);
    }
    require_keys_eq!(
        ctx.accounts.beneficiary_coin.owner,
        g.beneficiary,
        TreasuryError::WrongBeneficiary
    );
    let amount = math::bps_of(g.total, m.bps).ok_or(TreasuryError::Overflow)?;
    g.milestones
        .get_mut(i)
        .ok_or(TreasuryError::GrantInvalid)?
        .released = true;
    g.released = g
        .released
        .checked_add(amount)
        .ok_or(TreasuryError::Overflow)?;
    require!(g.released <= g.total, TreasuryError::GrantInvalid);
    e.grants_unreleased = e
        .grants_unreleased
        .checked_sub(amount)
        .ok_or(TreasuryError::Overflow)?;
    ext::store(&info, &e)?;
    if amount > 0 {
        pay_from_treasury(
            &ctx.accounts.coin_token_program,
            &ctx.accounts.coin_vault,
            &ctx.accounts.coin_mint,
            &ctx.accounts.beneficiary_coin,
            &ctx.accounts.treasury,
            amount,
        )?;
    }
    emit!(MilestoneReleased {
        grant: g.key(),
        index,
        amount
    });
    Ok(())
}

/// Burns what a grant never earned: after its expiry, or at any time once the treasury is
/// liquidating. Anyone may call it.
pub fn expire_grant_handler(ctx: Context<ExpireGrant>) -> Result<()> {
    let info = ctx.accounts.treasury.to_account_info();
    let mut e = ext::require(&info)?;
    let now = Clock::get()?.unix_timestamp;
    let g = &mut ctx.accounts.grant;
    require!(!g.burned, TreasuryError::GrantExpired);
    require!(
        now >= g.expiry_ts || ctx.accounts.treasury.state == TreasuryState::Liquidating,
        TreasuryError::GrantNotExpired
    );
    let left = g
        .total
        .checked_sub(g.released)
        .ok_or(TreasuryError::Overflow)?;
    g.burned = true;
    e.grants_unreleased = e
        .grants_unreleased
        .checked_sub(left)
        .ok_or(TreasuryError::Overflow)?;
    ext::store(&info, &e)?;
    if left > 0 {
        burn_from_treasury(
            &ctx.accounts.coin_token_program,
            &ctx.accounts.coin_vault,
            &ctx.accounts.coin_mint,
            &ctx.accounts.treasury,
            left,
        )?;
    }
    emit!(GrantExpired {
        grant: g.key(),
        burned: left
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateGrant<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump,
        has_one = authority @ TreasuryError::Unauthorized, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = coin_mint, token::authority = authority)]
    pub authority_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COINS_SEED, treasury.key().as_ref()], bump)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = authority, space = 8 + Grant::INIT_SPACE,
        seeds = [GRANT_SEED, treasury.key().as_ref(), &id.to_le_bytes()], bump)]
    pub grant: Box<Account<'info, Grant>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseMilestone<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, has_one = treasury @ TreasuryError::WrongProposal)]
    pub grant: Box<Account<'info, Grant>>,
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [COINS_SEED, treasury.key().as_ref()], bump)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = coin_mint)]
    pub beneficiary_coin: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the milestone's SAS attestation; read only for an earn-out milestone and then
    /// checked by `sas_attestation::is_valid`. Pass any account for a carve-out.
    pub attestation: UncheckedAccount<'info>,
    pub coin_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExpireGrant<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [TREASURY_SEED, treasury.coin_mint.as_ref()], bump = treasury.bump, has_one = coin_mint)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, has_one = treasury @ TreasuryError::WrongProposal)]
    pub grant: Box<Account<'info, Grant>>,
    #[account(mut)]
    pub coin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [COINS_SEED, treasury.key().as_ref()], bump)]
    pub coin_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub coin_token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct GrantCreated {
    pub treasury: Pubkey,
    pub grant: Pubkey,
    pub id: u64,
    pub beneficiary: Pubkey,
    pub total: u64,
    pub lockup_end: i64,
    pub expiry_ts: i64,
}

#[event]
pub struct MilestoneReleased {
    pub grant: Pubkey,
    pub index: u8,
    pub amount: u64,
}

#[event]
pub struct GrantExpired {
    pub grant: Pubkey,
    pub burned: u64,
}
