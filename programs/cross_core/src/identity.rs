//! Per-identity limits (ADR-0453): one application per identity and a cap on what an identity can
//! have escrowed. An identity is the wallet that holds the cross's gate pass, so the gate (SAS
//! credential or allowlist) is what makes "one person" mean one wallet; without it a cap is theatre
//! and `set_rules` refuses the rules.
use anchor_lang::prelude::*;

use crate::{
    ext::CrossExt,
    state::{Cross, OrderSide},
    CrossError,
};

pub const APPLICANT_SEED: &[u8] = b"applicant";

#[account]
#[derive(InitSpace)]
pub struct Applicant {
    pub cross: Pubkey,
    pub owner: Pubkey,
    /// Live orders.
    pub orders: u8,
    /// Quote escrowed in live buy orders.
    pub escrow: u64,
    pub bump: u8,
}

fn address(cross: &Pubkey, owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[APPLICANT_SEED, cross.as_ref(), owner.as_ref()],
        &crate::ID,
    )
}

/// Records a new order against its owner's limits, creating the applicant record on first use
/// (the owner pays its rent; `close_applicant` returns it once the cross is finalized).
pub fn on_commit<'info>(
    x: &CrossExt,
    cross_key: &Pubkey,
    owner: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    side: OrderSide,
    escrow: u64,
) -> Result<()> {
    let (pda, bump) = address(cross_key, owner.key);
    require_keys_eq!(account.key(), pda, CrossError::ApplicantMismatch);
    let mut a = if account.data_is_empty() {
        let space = 8 + Applicant::INIT_SPACE;
        let seeds: &[&[u8]] = &[
            APPLICANT_SEED,
            cross_key.as_ref(),
            owner.key.as_ref(),
            &[bump],
        ];
        require!(account.lamports() == 0, CrossError::ApplicantMismatch);
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                system_program.key(),
                anchor_lang::system_program::CreateAccount {
                    from: owner.clone(),
                    to: account.clone(),
                },
                &[seeds],
            ),
            Rent::get()?.minimum_balance(space),
            u64::try_from(space).map_err(|_| CrossError::Overflow)?,
            &crate::ID,
        )?;
        Applicant {
            cross: *cross_key,
            owner: *owner.key,
            orders: 0,
            escrow: 0,
            bump,
        }
    } else {
        require_keys_eq!(*account.owner, crate::ID, CrossError::ApplicantMismatch);
        let data = account.try_borrow_data()?;
        Applicant::try_deserialize(&mut &data[..])?
    };
    require!(
        x.identity.max_orders == 0 || a.orders < x.identity.max_orders,
        CrossError::IdentityLimit
    );
    a.orders = a.orders.checked_add(1).ok_or(CrossError::Overflow)?;
    if side == OrderSide::Buy {
        a.escrow = a.escrow.checked_add(escrow).ok_or(CrossError::Overflow)?;
        require!(
            x.identity.cap_quote == 0 || a.escrow <= x.identity.cap_quote,
            CrossError::IdentityLimit
        );
    }
    store(account, &a)
}

/// Releases a cancelled order's share of its owner's limits.
pub fn on_cancel(
    cross_key: &Pubkey,
    owner: &Pubkey,
    account: &AccountInfo,
    side: OrderSide,
    escrow: u64,
) -> Result<()> {
    let (pda, _) = address(cross_key, owner);
    require_keys_eq!(account.key(), pda, CrossError::ApplicantMismatch);
    require_keys_eq!(*account.owner, crate::ID, CrossError::ApplicantMismatch);
    let mut a = {
        let data = account.try_borrow_data()?;
        Applicant::try_deserialize(&mut &data[..])?
    };
    a.orders = a.orders.checked_sub(1).ok_or(CrossError::Overflow)?;
    if side == OrderSide::Buy {
        a.escrow = a.escrow.checked_sub(escrow).ok_or(CrossError::Overflow)?;
    }
    store(account, &a)
}

fn store(account: &AccountInfo, a: &Applicant) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data[..];
    a.try_serialize(&mut cursor)
}

#[derive(Accounts)]
pub struct CloseApplicant<'info> {
    pub cross: Box<Account<'info, Cross>>,
    /// CHECK: receives the rent; bound to the applicant record by `has_one`.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, close = owner, has_one = cross @ CrossError::ApplicantMismatch, has_one = owner @ CrossError::ApplicantMismatch)]
    pub applicant: Account<'info, Applicant>,
}

/// Anyone returns an applicant record's rent to its owner once the cross is over.
pub fn close_applicant(ctx: Context<CloseApplicant>) -> Result<()> {
    require!(
        ctx.accounts.cross.state == crate::state::CrossState::Finalized,
        CrossError::WrongState
    );
    Ok(())
}
