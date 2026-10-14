//! Opening Cross conviction (PRODUCT_FEATURES S7; ADR-0651).
//!
//! A holder locks tokens in a vault that only this program can move, until a date the holder chose. There is
//! no early exit: not for the holder, not for the program's authority through any instruction, not for anyone.
//! When the lock has run, the holder can mint a **soulbound badge** (a Token-2022 mint with the
//! `NonTransferable` extension, one per holder and token) in an amount equal to the token-days the lock held:
//! `floor(amount * seconds_locked / (86,400 * 10^decimals))`. The badge therefore measures commitment that
//! cost something, not a balance read at a moment (which timing can fake).
//!
//! Badges add up over locks, can be burned only by their holder, and can never be sent to another wallet
//! (the token program refuses). They are a credential, not a points scheme: nothing here pays out.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::{extension::ExtensionType, state::Mint as Mint2022};
use anchor_spl::token_2022::{self, MintTo, Token2022};
use anchor_spl::token_2022_extensions::{self, NonTransferableMintInitialize};
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("JAWUTTDhBQQ97w9YiPMv5sjsDxZab7AsSnc9L57zJjz6");

pub const LOCK_SEED: &[u8] = b"lock";
pub const BADGE_SEED: &[u8] = b"badge";
pub const BADGE_AUTHORITY_SEED: &[u8] = b"badge_authority";
pub const SECS_PER_DAY: u128 = 86_400;
/// The shortest lock: a day, so that the arithmetic can award at least one token-day for one whole token.
pub const MIN_LOCK_SECS: i64 = 86_400;
/// The longest lock: four years.
pub const MAX_LOCK_SECS: i64 = 4 * 365 * 86_400;

#[program]
pub mod cross_conviction {
    use super::*;

    /// Locks `amount` of a token until `unlock_ts`. The lock records what the vault actually received, so a
    /// token that takes a transfer fee cannot be credited for more than arrived.
    pub fn lock_tokens<'info>(
        ctx: Context<'info, LockTokens<'info>>,
        nonce: u64,
        amount: u64,
        unlock_ts: i64,
    ) -> Result<()> {
        require!(amount > 0, ConvictionError::NothingToLock);
        let now = Clock::get()?.unix_timestamp;
        let earliest = now
            .checked_add(MIN_LOCK_SECS)
            .ok_or(ConvictionError::Overflow)?;
        let latest = now
            .checked_add(MAX_LOCK_SECS)
            .ok_or(ConvictionError::Overflow)?;
        require!(
            unlock_ts >= earliest && unlock_ts <= latest,
            ConvictionError::BadUnlockTime
        );
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.holder_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount;
        require!(received > 0, ConvictionError::NothingToLock);
        let lock = &mut ctx.accounts.lock;
        lock.holder = ctx.accounts.holder.key();
        lock.mint = ctx.accounts.mint.key();
        lock.nonce = nonce;
        lock.amount = received;
        lock.decimals = ctx.accounts.mint.decimals;
        lock.locked_at = now;
        lock.unlock_ts = unlock_ts;
        lock.withdrawn = false;
        lock.badge_claimed = false;
        lock.bump = ctx.bumps.lock;
        emit!(Locked {
            lock: lock.key(),
            holder: lock.holder,
            mint: lock.mint,
            amount: received,
            locked_at: now,
            unlock_ts,
        });
        Ok(())
    }

    /// Returns the tokens to the holder once the lock has run. Nothing else can move them.
    pub fn unlock<'info>(ctx: Context<'info, Unlock<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let lock = &ctx.accounts.lock;
        require!(now >= lock.unlock_ts, ConvictionError::StillLocked);
        require!(!lock.withdrawn, ConvictionError::AlreadyWithdrawn);
        let amount = ctx.accounts.vault.amount;
        let nonce = lock.nonce.to_le_bytes();
        let holder = lock.holder;
        let mint = lock.mint;
        let bump = [lock.bump];
        let seeds: &[&[u8]] = &[LOCK_SEED, holder.as_ref(), mint.as_ref(), &nonce, &bump];
        if amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.holder_token.to_account_info(),
                        authority: ctx.accounts.lock.to_account_info(),
                    },
                    &[seeds],
                )
                .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.holder.to_account_info(),
                authority: ctx.accounts.lock.to_account_info(),
            },
            &[seeds],
        ))?;
        let lock = &mut ctx.accounts.lock;
        lock.withdrawn = true;
        emit!(Unlocked {
            lock: lock.key(),
            holder,
            amount
        });
        Ok(())
    }

    /// Creates the holder's badge mint for a token: Token-2022, zero decimals, `NonTransferable`, mint
    /// authority a program PDA. Idempotent, and anyone may pay for it.
    pub fn init_badge(ctx: Context<InitBadge>) -> Result<()> {
        let badge = &ctx.accounts.badge_mint;
        if !badge.data_is_empty() || badge.lamports() > 0 {
            require_keys_eq!(
                *badge.owner,
                token_2022::ID,
                ConvictionError::BadgeMintMismatch
            );
            return Ok(());
        }
        require!(
            *ctx.accounts.mint.owner == anchor_spl::token::ID
                || *ctx.accounts.mint.owner == token_2022::ID,
            ConvictionError::NotAMint
        );
        let holder = ctx.accounts.holder.key();
        let mint = ctx.accounts.mint.key();
        let bump = [ctx.bumps.badge_mint];
        let seeds: &[&[u8]] = &[BADGE_SEED, holder.as_ref(), mint.as_ref(), &bump];
        let space =
            ExtensionType::try_calculate_account_len::<Mint2022>(&[ExtensionType::NonTransferable])
                .map_err(|_| ConvictionError::Overflow)?;
        let lamports = Rent::get()?.minimum_balance(space);
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.badge_mint.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
            space as u64,
            &token_2022::ID,
        )?;
        token_2022_extensions::non_transferable_mint_initialize(CpiContext::new(
            ctx.accounts.token_program.key(),
            NonTransferableMintInitialize {
                token_program_id: ctx.accounts.token_program.to_account_info(),
                mint: ctx.accounts.badge_mint.to_account_info(),
            },
        ))?;
        token_2022::initialize_mint2(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token_2022::InitializeMint2 {
                    mint: ctx.accounts.badge_mint.to_account_info(),
                },
            ),
            0,
            &ctx.accounts.badge_authority.key(),
            None,
        )?;
        emit!(BadgeCreated {
            holder,
            mint,
            badge_mint: ctx.accounts.badge_mint.key()
        });
        Ok(())
    }

    /// After the lock has run, mints the badge for it, once per lock: the token-days the lock held.
    pub fn claim_badge(ctx: Context<ClaimBadge>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let lock = &mut ctx.accounts.lock;
        require!(now >= lock.unlock_ts, ConvictionError::StillLocked);
        require!(!lock.badge_claimed, ConvictionError::BadgeAlreadyClaimed);
        let secs = lock
            .unlock_ts
            .checked_sub(lock.locked_at)
            .ok_or(ConvictionError::Overflow)?;
        let days = token_days(lock.amount, secs, lock.decimals).ok_or(ConvictionError::Overflow)?;
        require!(days > 0, ConvictionError::TooSmallForABadge);
        lock.badge_claimed = true;
        let bump = [ctx.bumps.badge_authority];
        let seeds: &[&[u8]] = &[BADGE_AUTHORITY_SEED, &bump];
        token_2022::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.badge_mint.to_account_info(),
                    to: ctx.accounts.holder_badge.to_account_info(),
                    authority: ctx.accounts.badge_authority.to_account_info(),
                },
                &[seeds],
            ),
            days,
        )?;
        emit!(BadgeClaimed {
            lock: lock.key(),
            holder: lock.holder,
            token_days: days
        });
        Ok(())
    }

    /// Closes a lock whose tokens were returned and whose badge was minted, giving its rent back.
    pub fn close_lock(ctx: Context<CloseLock>) -> Result<()> {
        let lock = &ctx.accounts.lock;
        require!(
            lock.withdrawn && lock.badge_claimed,
            ConvictionError::LockStillNeeded
        );
        Ok(())
    }
}

/// Token-days a lock earns: `floor(amount * secs / (86,400 * 10^decimals))`, `None` on overflow of a `u64`.
pub fn token_days(amount: u64, secs: i64, decimals: u8) -> Option<u64> {
    let secs = u128::try_from(secs).ok()?;
    let scale = SECS_PER_DAY.checked_mul(10u128.checked_pow(u32::from(decimals))?)?;
    let days = u128::from(amount).checked_mul(secs)? / scale;
    u64::try_from(days).ok()
}

#[account]
#[derive(InitSpace)]
pub struct Lock {
    pub holder: Pubkey,
    pub mint: Pubkey,
    pub nonce: u64,
    /// Atoms the vault received.
    pub amount: u64,
    pub decimals: u8,
    pub locked_at: i64,
    pub unlock_ts: i64,
    pub withdrawn: bool,
    pub badge_claimed: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct LockTokens<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = holder, token::token_program = token_program)]
    pub holder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = holder, space = 8 + Lock::INIT_SPACE, seeds = [LOCK_SEED, holder.key().as_ref(), mint.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub lock: Box<Account<'info, Lock>>,
    #[account(init, payer = holder, associated_token::mint = mint, associated_token::authority = lock, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unlock<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, has_one = holder @ ConvictionError::Unauthorized, has_one = mint @ ConvictionError::WrongMint)]
    pub lock: Box<Account<'info, Lock>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = lock, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = holder, token::token_program = token_program)]
    pub holder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitBadge<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: only its address is used, as a seed.
    pub holder: UncheckedAccount<'info>,
    /// CHECK: the token being locked; only its address and owning program are used.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: created here at the PDA, or already a Token-2022 account.
    #[account(mut, seeds = [BADGE_SEED, holder.key().as_ref(), mint.key().as_ref()], bump)]
    pub badge_mint: UncheckedAccount<'info>,
    #[account(seeds = [BADGE_AUTHORITY_SEED], bump)]
    pub badge_authority: SystemAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimBadge<'info> {
    pub holder: Signer<'info>,
    #[account(mut, has_one = holder @ ConvictionError::Unauthorized, has_one = mint @ ConvictionError::WrongMint, seeds = [LOCK_SEED, holder.key().as_ref(), mint.key().as_ref(), &lock.nonce.to_le_bytes()], bump = lock.bump)]
    pub lock: Box<Account<'info, Lock>>,
    /// CHECK: the locked token; bound to the lock by `has_one`.
    pub mint: UncheckedAccount<'info>,
    #[account(mut, seeds = [BADGE_SEED, holder.key().as_ref(), mint.key().as_ref()], bump, owner = token_2022::ID)]
    pub badge_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [BADGE_AUTHORITY_SEED], bump)]
    pub badge_authority: SystemAccount<'info>,
    #[account(mut, token::mint = badge_mint, token::authority = holder, token::token_program = token_program)]
    pub holder_badge: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct CloseLock<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, close = holder, has_one = holder @ ConvictionError::Unauthorized)]
    pub lock: Box<Account<'info, Lock>>,
}

#[event]
pub struct Locked {
    pub lock: Pubkey,
    pub holder: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub locked_at: i64,
    pub unlock_ts: i64,
}
#[event]
pub struct Unlocked {
    pub lock: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
}
#[event]
pub struct BadgeCreated {
    pub holder: Pubkey,
    pub mint: Pubkey,
    pub badge_mint: Pubkey,
}
#[event]
pub struct BadgeClaimed {
    pub lock: Pubkey,
    pub holder: Pubkey,
    pub token_days: u64,
}

#[error_code]
pub enum ConvictionError {
    #[msg("Signer is not the holder of this lock")]
    Unauthorized,
    #[msg("Nothing to lock")]
    NothingToLock,
    #[msg("The unlock time must be between one day and four years from now")]
    BadUnlockTime,
    #[msg("The lock has not run yet")]
    StillLocked,
    #[msg("The tokens were already returned")]
    AlreadyWithdrawn,
    #[msg("The badge for this lock was already minted")]
    BadgeAlreadyClaimed,
    #[msg("This lock is too small to earn one token-day")]
    TooSmallForABadge,
    #[msg("Return the tokens and mint the badge before closing the lock")]
    LockStillNeeded,
    #[msg("The account is not the lock's token")]
    WrongMint,
    #[msg("The account is not a token mint")]
    NotAMint,
    #[msg("The badge mint account is not a Token-2022 mint")]
    BadgeMintMismatch,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_days_round_down_and_scale_with_decimals() {
        // One whole 6-decimal token for exactly one day is one token-day.
        assert_eq!(token_days(1_000_000, 86_400, 6), Some(1));
        // One atom short of a token-day is none.
        assert_eq!(token_days(999_999, 86_400, 6), Some(0));
        assert_eq!(token_days(1_000_000, 86_399, 6), Some(0));
        // A hundred tokens for thirty days is three thousand token-days.
        assert_eq!(token_days(100_000_000, 30 * 86_400, 6), Some(3_000));
        // Nine decimals.
        assert_eq!(token_days(2_000_000_000, 86_400 * 365, 9), Some(730));
        // Zero decimals.
        assert_eq!(token_days(5, 86_400 * 2, 0), Some(10));
    }

    #[test]
    fn token_days_never_overflow_into_a_wrong_answer() {
        assert_eq!(token_days(u64::MAX, i64::MAX, 0), None);
        assert_eq!(token_days(1, -1, 6), None);
        // The most a four-year lock of 2^40 atoms (zero decimals) can earn still fits; the same lock of u64::MAX does not.
        assert_eq!(
            token_days(1 << 40, MAX_LOCK_SECS, 0),
            Some((1u64 << 40) * 1_460)
        );
        assert_eq!(token_days(u64::MAX, MAX_LOCK_SECS, 0), None);
        // 10^decimals itself overflows for absurd decimals.
        assert_eq!(token_days(1, 86_400, 255), None);
    }

    #[test]
    fn matches_a_reference_over_a_grid() {
        for decimals in [0u8, 6, 9] {
            for amount in [1u64, 999, 1_000_000, 123_456_789_012, 10u64.pow(15)] {
                for secs in [86_400i64, 86_401, 172_799, 5 * 86_400, MAX_LOCK_SECS] {
                    let want = (u128::from(amount) * secs as u128)
                        / (86_400u128 * 10u128.pow(u32::from(decimals)));
                    assert_eq!(token_days(amount, secs, decimals), u64::try_from(want).ok());
                }
            }
        }
    }
}
