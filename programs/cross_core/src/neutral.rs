//! Issuer neutrality (ADR-0454): declared insiders, the bond behind the declaration, and the
//! challenge that slashes it.
//!
//! The issuer names its insiders when the cross is created. Their orders are tallied apart, their
//! allocation does not count toward the minimum raise or the float, and their fills unlock only
//! after a cliff. Behind the declaration the issuer posts a bond in the quote token. For a period
//! after the clear anyone may allege that another wallet was an undeclared insider (funded by the
//! issuer or a declared insider) and post a deposit; an arbiter named by the protocol decides.
//! If the allegation is upheld the arbiter slashes part of the bond, half to the challenger and
//! half to the protocol, and the deposit is returned; if it is rejected the deposit goes to the
//! protocol. The bond that survives returns to the issuer with the proceeds, after the window.
//!
//! What is on chain is the bond, the window and who may rule; the evidence is off chain and is
//! committed to by hash. The arbiter is a trusted role (docs/HUMAN_TASKS.md).
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    ext,
    state::{Cross, CrossState, Protocol, CROSS_SEED, PROTOCOL_SEED, QUOTE_VAULT_SEED},
    CrossError,
};

pub const ARBITER_SEED: &[u8] = b"arbiter";
pub const CHALLENGE_SEED: &[u8] = b"challenge";
/// Lamports a challenger puts behind an allegation (0.01 SOL), on top of the account's rent.
pub const CHALLENGE_DEPOSIT: u64 = 10_000_000;
/// An open challenge nobody rules on expires after this long, so an absent arbiter cannot hold a cross's
/// proceeds back for good: anyone may close it, the challenger's deposit returns and the bond is untouched.
pub const ARBITER_DEADLINE_SECS: i64 = 14 * 24 * 3_600;
pub const MIN_CHALLENGE_SECS: u32 = 3_600;
pub const MAX_CHALLENGE_SECS: u32 = 30 * 24 * 3_600;

#[account]
#[derive(InitSpace)]
pub struct ArbiterRegistry {
    pub arbiter: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ChallengeStatus {
    Open,
    Upheld,
    Rejected,
}

#[account]
#[derive(InitSpace)]
pub struct Challenge {
    pub cross: Pubkey,
    pub id: u32,
    pub challenger: Pubkey,
    /// The wallet alleged to be an undeclared insider.
    pub subject: Pubkey,
    /// Hash of the evidence kept off chain.
    pub evidence: [u8; 32],
    pub deposit: u64,
    pub filed_ts: i64,
    pub status: ChallengeStatus,
    pub slashed: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SetArbiter<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump, has_one = admin @ CrossError::Unauthorized)]
    pub protocol: Account<'info, Protocol>,
    #[account(init_if_needed, payer = admin, space = 8 + ArbiterRegistry::INIT_SPACE, seeds = [ARBITER_SEED], bump)]
    pub registry: Account<'info, ArbiterRegistry>,
    pub system_program: Program<'info, System>,
}

/// The protocol admin names the arbiter that rules on insider challenges.
pub fn set_arbiter(ctx: Context<SetArbiter>, arbiter: Pubkey) -> Result<()> {
    ctx.accounts.registry.arbiter = arbiter;
    ctx.accounts.registry.bump = ctx.bumps.registry;
    Ok(())
}

#[derive(Accounts)]
pub struct ChallengeInsider<'info> {
    #[account(mut)]
    pub challenger: Signer<'info>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    /// CHECK: created here at `[CHALLENGE_SEED, cross, id]`; the id is the cross's challenge count.
    #[account(mut)]
    pub challenge: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn challenge_insider(
    ctx: Context<ChallengeInsider>,
    subject: Pubkey,
    evidence: [u8; 32],
) -> Result<()> {
    let c = &ctx.accounts.cross;
    require!(c.state == CrossState::Cleared, CrossError::WrongState);
    let info = c.to_account_info();
    let mut x = ext::read(&info)?;
    require!(x.neutrality.bond_quote > 0, CrossError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let closes = x
        .clearing
        .cleared_ts
        .saturating_add(i64::from(x.neutrality.challenge_secs));
    require!(now < closes, CrossError::ChallengeWindowClosed);
    require!(!x.is_insider(&subject), CrossError::InvalidParams);
    let id = x.neutral_state.challenges;
    let id_bytes = id.to_le_bytes();
    let (pda, bump) =
        Pubkey::find_program_address(&[CHALLENGE_SEED, c.key().as_ref(), &id_bytes], &crate::ID);
    require_keys_eq!(
        ctx.accounts.challenge.key(),
        pda,
        CrossError::ChallengeMismatch
    );
    let space = 8 + Challenge::INIT_SPACE;
    let cross_key = c.key();
    let seeds: &[&[u8]] = &[CHALLENGE_SEED, cross_key.as_ref(), &id_bytes, &[bump]];
    let lamports = Rent::get()?
        .minimum_balance(space)
        .checked_add(CHALLENGE_DEPOSIT)
        .ok_or(CrossError::Overflow)?;
    anchor_lang::system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            anchor_lang::system_program::CreateAccount {
                from: ctx.accounts.challenger.to_account_info(),
                to: ctx.accounts.challenge.to_account_info(),
            },
            &[seeds],
        ),
        lamports,
        u64::try_from(space).map_err(|_| CrossError::Overflow)?,
        &crate::ID,
    )?;
    let record = Challenge {
        cross: c.key(),
        id,
        challenger: ctx.accounts.challenger.key(),
        subject,
        evidence,
        deposit: CHALLENGE_DEPOSIT,
        filed_ts: now,
        status: ChallengeStatus::Open,
        slashed: 0,
        bump,
    };
    {
        let acc = ctx.accounts.challenge.to_account_info();
        let mut data = acc.try_borrow_mut_data()?;
        let mut cursor: &mut [u8] = &mut data[..];
        record.try_serialize(&mut cursor)?;
    }
    x.neutral_state.challenges = id.checked_add(1).ok_or(CrossError::Overflow)?;
    x.neutral_state.open_challenges = x
        .neutral_state
        .open_challenges
        .checked_add(1)
        .ok_or(CrossError::Overflow)?;
    ext::write(&info, &x)?;
    emit!(InsiderChallenged {
        cross: c.key(),
        id,
        challenger: record.challenger,
        subject,
        evidence
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveChallenge<'info> {
    pub arbiter: Signer<'info>,
    #[account(seeds = [ARBITER_SEED], bump = registry.bump, constraint = registry.arbiter == arbiter.key() @ CrossError::Unauthorized)]
    pub registry: Account<'info, ArbiterRegistry>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(mut, has_one = cross @ CrossError::ChallengeMismatch)]
    pub challenge: Account<'info, Challenge>,
    /// CHECK: receives the deposit and rent when the challenge is upheld; bound to the record.
    #[account(mut, address = challenge.challenger)]
    pub challenger: UncheckedAccount<'info>,
    /// CHECK: receives the deposit and rent when the challenge is rejected; the cross's fee recipient.
    #[account(mut, address = cross.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    #[account(address = cross.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, cross.key().as_ref()], bump = cross.quote_vault_bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = challenger, token::token_program = quote_token_program)]
    pub challenger_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = fee_recipient, token::token_program = quote_token_program)]
    pub fee_recipient_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = cross.quote_token_program)]
    pub quote_token_program: Interface<'info, TokenInterface>,
}

pub fn resolve_challenge(ctx: Context<ResolveChallenge>, upheld: bool, slash: u64) -> Result<()> {
    let c = &ctx.accounts.cross;
    require!(
        ctx.accounts.challenge.status == ChallengeStatus::Open,
        CrossError::ChallengeMismatch
    );
    let info = c.to_account_info();
    let mut x = ext::read(&info)?;
    let challenger_share;
    let fee_share;
    if upheld {
        let room = x
            .neutral_state
            .bond_held
            .saturating_sub(x.neutral_state.slashed);
        require!(slash > 0 && slash <= room, CrossError::InvalidParams);
        challenger_share = slash / 2;
        fee_share = slash
            .checked_sub(challenger_share)
            .ok_or(CrossError::Overflow)?;
        let (creator, id, bump) = (c.creator, c.cross_id.to_le_bytes(), [c.bump]);
        let seeds: &[&[u8]] = &[CROSS_SEED, creator.as_ref(), &id, &bump];
        for (to, amount) in [
            (&ctx.accounts.challenger_quote, challenger_share),
            (&ctx.accounts.fee_recipient_quote, fee_share),
        ] {
            if amount > 0 {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.quote_token_program.key(),
                        TransferChecked {
                            from: ctx.accounts.quote_vault.to_account_info(),
                            mint: ctx.accounts.quote_mint.to_account_info(),
                            to: to.to_account_info(),
                            authority: c.to_account_info(),
                        },
                        &[seeds],
                    ),
                    amount,
                    ctx.accounts.quote_mint.decimals,
                )?;
            }
        }
        x.neutral_state.slashed = x
            .neutral_state
            .slashed
            .checked_add(slash)
            .ok_or(CrossError::Overflow)?;
    } else {
        require!(slash == 0, CrossError::InvalidParams);
    }
    x.neutral_state.open_challenges = x
        .neutral_state
        .open_challenges
        .checked_sub(1)
        .ok_or(CrossError::Overflow)?;
    ext::write(&info, &x)?;
    let ch = &mut ctx.accounts.challenge;
    ch.status = if upheld {
        ChallengeStatus::Upheld
    } else {
        ChallengeStatus::Rejected
    };
    ch.slashed = slash;
    emit!(ChallengeResolved {
        cross: c.key(),
        id: ch.id,
        upheld,
        slash
    });
    // The deposit and the account's rent go back to the challenger when they were right and to
    // the protocol when they were not.
    let dest = if upheld {
        ctx.accounts.challenger.to_account_info()
    } else {
        ctx.accounts.fee_recipient.to_account_info()
    };
    ctx.accounts.challenge.close(dest)?;
    Ok(())
}

#[event]
pub struct InsiderChallenged {
    pub cross: Pubkey,
    pub id: u32,
    pub challenger: Pubkey,
    pub subject: Pubkey,
    pub evidence: [u8; 32],
}

#[event]
pub struct ChallengeResolved {
    pub cross: Pubkey,
    pub id: u32,
    pub upheld: bool,
    pub slash: u64,
}

#[derive(Accounts)]
pub struct ExpireChallenge<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(mut, has_one = cross @ CrossError::ChallengeMismatch)]
    pub challenge: Account<'info, Challenge>,
    /// CHECK: receives the deposit and rent back; bound to the record.
    #[account(mut, address = challenge.challenger)]
    pub challenger: UncheckedAccount<'info>,
}

/// Anyone closes a challenge the arbiter has not ruled on within `ARBITER_DEADLINE_SECS`. The challenger gets the
/// deposit and rent back; the bond is not touched.
pub fn expire_challenge(ctx: Context<ExpireChallenge>) -> Result<()> {
    let ch = &ctx.accounts.challenge;
    require!(
        ch.status == ChallengeStatus::Open,
        CrossError::ChallengeMismatch
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ch.filed_ts.saturating_add(ARBITER_DEADLINE_SECS),
        CrossError::DeadlineNotReached
    );
    let c = &ctx.accounts.cross;
    let info = c.to_account_info();
    let mut x = ext::read(&info)?;
    x.neutral_state.open_challenges = x
        .neutral_state
        .open_challenges
        .checked_sub(1)
        .ok_or(CrossError::Overflow)?;
    ext::write(&info, &x)?;
    emit!(ChallengeExpired {
        cross: c.key(),
        id: ch.id
    });
    let dest = ctx.accounts.challenger.to_account_info();
    ctx.accounts.challenge.close(dest)?;
    Ok(())
}

#[event]
pub struct ChallengeExpired {
    pub cross: Pubkey,
    pub id: u32,
}
