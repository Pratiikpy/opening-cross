//! Lockups and vesting of allocated tokens (ADR-0454).
//!
//! A buyer who chooses a lock (allocation class 2), an identity-verified buyer when the issuer
//! requires vesting, and a declared insider all receive their fill into the cross's lock vault
//! instead of their wallet. A `Lockup` record per order says how much, from when, with which
//! cliff and which linear vesting; `release_locked` pays the vested part to the owner, by anyone's
//! call. The lock changes when a holder can sell and never what they paid or how much they got.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    state::{Cross, CROSS_SEED},
    CrossError,
};

pub const LOCKUP_SEED: &[u8] = b"lock";
pub const LOCK_VAULT_SEED: &[u8] = b"lock_vault";
/// Longest cliff or vesting a cross can impose: four years.
pub const MAX_LOCK_SECS: u32 = 4 * 365 * 24 * 60 * 60;

#[account]
#[derive(InitSpace)]
pub struct Lockup {
    pub cross: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub released: u64,
    pub start_ts: i64,
    pub cliff_secs: u32,
    pub vest_secs: u32,
    pub bump: u8,
}

impl Lockup {
    /// Tokens vested by `now`: nothing before the cliff, everything at the cliff when there is
    /// no vesting period, and a straight line over the vesting period after it.
    pub fn vested(&self, now: i64) -> u64 {
        let unlock = self.start_ts.saturating_add(i64::from(self.cliff_secs));
        if now < unlock {
            return 0;
        }
        if self.vest_secs == 0 {
            return self.amount;
        }
        let elapsed = u128::try_from(now.saturating_sub(unlock)).unwrap_or(0);
        let part = u128::from(self.amount)
            .saturating_mul(elapsed)
            .checked_div(u128::from(self.vest_secs))
            .unwrap_or(u128::from(self.amount));
        u64::try_from(part.min(u128::from(self.amount))).unwrap_or(self.amount)
    }

    pub fn releasable(&self, now: i64) -> u64 {
        self.vested(now).saturating_sub(self.released)
    }
}

pub fn lockup_address(cross: &Pubkey, owner: &Pubkey, nonce: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            LOCKUP_SEED,
            cross.as_ref(),
            owner.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &crate::ID,
    )
}

pub fn lock_vault_address(cross: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[LOCK_VAULT_SEED, cross.as_ref()], &crate::ID).0
}

#[derive(Accounts)]
pub struct InitLockVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub cross: Box<Account<'info, Cross>>,
    #[account(address = cross.base_mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, seeds = [LOCK_VAULT_SEED, cross.key().as_ref()], bump, token::mint = base_mint, token::authority = cross, token::token_program = base_token_program)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = cross.base_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Creates the vault that holds locked tokens. Anyone may pay for it once the base mint is bound.
pub fn init_lock_vault(ctx: Context<InitLockVault>) -> Result<()> {
    require!(ctx.accounts.cross.base_bound, CrossError::SettlementPending);
    Ok(())
}

#[derive(Accounts)]
pub struct ReleaseLocked<'info> {
    pub cross: Box<Account<'info, Cross>>,
    /// CHECK: receives the lockup's rent when the last tokens are released; bound by `has_one`.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, has_one = cross @ CrossError::WrongCross, has_one = owner @ CrossError::Unauthorized)]
    pub lockup: Account<'info, Lockup>,
    #[account(mut, seeds = [LOCK_VAULT_SEED, cross.key().as_ref()], bump)]
    pub lock_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = cross.base_mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = base_mint, token::authority = owner, token::token_program = base_token_program)]
    pub owner_base: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = cross.base_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
}

/// Pays the vested, unreleased part of a lockup to its owner; anyone may call it.
pub fn release_locked(ctx: Context<ReleaseLocked>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let l = &mut ctx.accounts.lockup;
    let amount = l.releasable(now);
    require!(amount > 0, CrossError::NothingToRelease);
    l.released = l.released.checked_add(amount).ok_or(CrossError::Overflow)?;
    let c = &ctx.accounts.cross;
    let (creator, id, bump) = (c.creator, c.cross_id.to_le_bytes(), [c.bump]);
    let seeds: &[&[u8]] = &[CROSS_SEED, creator.as_ref(), &id, &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.base_token_program.key(),
            TransferChecked {
                from: ctx.accounts.lock_vault.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.owner_base.to_account_info(),
                authority: ctx.accounts.cross.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.base_mint.decimals,
    )?;
    emit!(LockReleased {
        cross: l.cross,
        owner: l.owner,
        amount,
        remaining: l.amount.saturating_sub(l.released)
    });
    if l.released == l.amount {
        let owner = ctx.accounts.owner.to_account_info();
        ctx.accounts.lockup.close(owner)?;
    }
    Ok(())
}

/// Moves the rent a lockup needs out of the order being claimed, creates the lockup record at its
/// derived address and fills it in. The order's own rent funds it, so locking costs the cranker
/// nothing; whatever the order holds beyond that still returns to its owner when it closes.
#[allow(clippy::too_many_arguments)]
pub fn open_lockup<'info>(
    lockup: &AccountInfo<'info>,
    order: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    cross_key: &Pubkey,
    owner: &Pubkey,
    nonce: u64,
    amount: u64,
    start_ts: i64,
    cliff_secs: u32,
    vest_secs: u32,
) -> Result<()> {
    let (pda, bump) = lockup_address(cross_key, owner, nonce);
    require_keys_eq!(lockup.key(), pda, CrossError::LockupMismatch);
    require!(
        lockup.data_is_empty() && *lockup.owner == anchor_lang::system_program::ID,
        CrossError::LockupMismatch
    );
    let space = 8 + Lockup::INIT_SPACE;
    let rent = Rent::get()?.minimum_balance(space);
    let nonce_bytes = nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        LOCKUP_SEED,
        cross_key.as_ref(),
        owner.as_ref(),
        &nonce_bytes,
        &[bump],
    ];
    let space_u64 = u64::try_from(space).map_err(|_| CrossError::Overflow)?;
    // Allocate and assign first, then move the rent in. Crediting lamports to an account before a CPI
    // that does not carry the debited account unbalances the callee's view of the instruction.
    anchor_lang::system_program::allocate(
        CpiContext::new_with_signer(
            system_program.key(),
            anchor_lang::system_program::Allocate {
                account_to_allocate: lockup.clone(),
            },
            &[seeds],
        ),
        space_u64,
    )?;
    anchor_lang::system_program::assign(
        CpiContext::new_with_signer(
            system_program.key(),
            anchor_lang::system_program::Assign {
                account_to_assign: lockup.clone(),
            },
            &[seeds],
        ),
        &crate::ID,
    )?;
    let need = rent.saturating_sub(lockup.lamports());
    if need > 0 {
        let rest = order
            .lamports()
            .checked_sub(need)
            .ok_or(CrossError::Overflow)?;
        **order.try_borrow_mut_lamports()? = rest;
        **lockup.try_borrow_mut_lamports()? = lockup
            .lamports()
            .checked_add(need)
            .ok_or(CrossError::Overflow)?;
    }
    let record = Lockup {
        cross: *cross_key,
        owner: *owner,
        nonce,
        amount,
        released: 0,
        start_ts,
        cliff_secs,
        vest_secs,
        bump,
    };
    let mut data = lockup.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data[..];
    record.try_serialize(&mut cursor)
}

#[event]
pub struct LockReleased {
    pub cross: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct LockCreated {
    pub cross: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub start_ts: i64,
    pub cliff_secs: u32,
    pub vest_secs: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn lockup(amount: u64, cliff: u32, vest: u32) -> Lockup {
        Lockup {
            cross: Pubkey::default(),
            owner: Pubkey::default(),
            nonce: 0,
            amount,
            released: 0,
            start_ts: 1_000,
            cliff_secs: cliff,
            vest_secs: vest,
            bump: 0,
        }
    }

    #[test]
    fn nothing_before_the_cliff_everything_after_it_without_vesting() {
        let l = lockup(1_000, 100, 0);
        assert_eq!(l.vested(1_099), 0);
        assert_eq!(l.vested(1_100), 1_000);
    }

    #[test]
    fn vesting_is_a_straight_line_after_the_cliff() {
        let l = lockup(1_000, 100, 200);
        assert_eq!(l.vested(1_100), 0);
        assert_eq!(l.vested(1_200), 500);
        assert_eq!(l.vested(1_300), 1_000);
        assert_eq!(l.vested(9_999_999), 1_000);
    }

    proptest! {
        #[test]
        fn vested_never_exceeds_the_amount_and_never_decreases(
            amount in 0u64..=u64::MAX,
            cliff in 0u32..=lock_max(),
            vest in 0u32..=lock_max(),
            t1 in 0i64..(8 * 365 * 24 * 3600),
            dt in 0i64..(8 * 365 * 24 * 3600),
        ) {
            let l = lockup(amount, cliff, vest);
            let a = l.vested(1_000 + t1);
            let b = l.vested(1_000 + t1 + dt);
            prop_assert!(a <= amount && b <= amount);
            prop_assert!(a <= b);
        }

        #[test]
        fn what_is_released_never_exceeds_what_has_vested(
            amount in 1u64..=u64::MAX,
            vest in 1u32..=lock_max(),
            released_frac in 0u64..=100,
            t in 0i64..(8 * 365 * 24 * 3600),
        ) {
            let mut l = lockup(amount, 0, vest);
            l.released = l.vested(1_000 + t) / 100 * released_frac.min(100);
            prop_assert!(l.released + l.releasable(1_000 + t) <= l.vested(1_000 + t));
        }
    }

    const fn lock_max() -> u32 {
        MAX_LOCK_SECS
    }
}
