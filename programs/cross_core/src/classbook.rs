//! The class book: per-tick tallies of buy orders by allocation class, and of declared insiders
//! (ADR-0453, ADR-0454). The main book records quantity per tick; this records how that quantity
//! splits by class, which is what the clear needs at the marginal tick and nowhere else.
use anchor_lang::prelude::*;

use crate::{state::MAX_TICKS, CrossError};

pub const CLASS_BOOK_SEED: &[u8] = b"classes";

#[account(zero_copy)]
#[repr(C)]
pub struct ClassBook {
    pub cross: Pubkey,
    /// Buy quantity per tick of classes 1, 2 and 3.
    pub qty: [[u64; MAX_TICKS]; 3],
    /// Class-1 orders per tick: the lottery tickets.
    pub tickets: [u32; MAX_TICKS],
    /// Buy quantity per tick of declared insiders.
    pub insider_qty: [u64; MAX_TICKS],
}

impl ClassBook {
    pub const SIZE: usize = 8 + core::mem::size_of::<ClassBook>();

    /// Tallies a revealed buy order. Returns its lottery ticket (class 1) or 0.
    pub fn add(&mut self, class: u8, insider: bool, tick: usize, quantity: u64) -> Result<u32> {
        let mut ticket = 0;
        if (1..=3).contains(&class) {
            let q = self
                .qty
                .get_mut(usize::from(class - 1))
                .and_then(|row| row.get_mut(tick))
                .ok_or(CrossError::OffGrid)?;
            *q = q.checked_add(quantity).ok_or(CrossError::Overflow)?;
            if class == 1 {
                let t = self.tickets.get_mut(tick).ok_or(CrossError::OffGrid)?;
                ticket = *t;
                *t = t.checked_add(1).ok_or(CrossError::Overflow)?;
            }
        }
        if insider {
            let q = self.insider_qty.get_mut(tick).ok_or(CrossError::OffGrid)?;
            *q = q.checked_add(quantity).ok_or(CrossError::Overflow)?;
        }
        Ok(ticket)
    }

    /// Removes an order that was cancelled while the call was open. A lottery ticket cannot be
    /// withdrawn (the lottery needs every number to be a live order), so `cancel_order` refuses
    /// class-1 orders when the cross runs a lottery, and this is never called for one.
    pub fn remove(&mut self, class: u8, insider: bool, tick: usize, quantity: u64) -> Result<()> {
        if (1..=3).contains(&class) {
            let q = self
                .qty
                .get_mut(usize::from(class - 1))
                .and_then(|row| row.get_mut(tick))
                .ok_or(CrossError::OffGrid)?;
            *q = q.checked_sub(quantity).ok_or(CrossError::Overflow)?;
        }
        if insider {
            let q = self.insider_qty.get_mut(tick).ok_or(CrossError::OffGrid)?;
            *q = q.checked_sub(quantity).ok_or(CrossError::Overflow)?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitClassBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub cross: Box<Account<'info, crate::state::Cross>>,
    #[account(init, payer = payer, space = ClassBook::SIZE, seeds = [CLASS_BOOK_SEED, cross.key().as_ref()], bump)]
    pub class_book: AccountLoader<'info, ClassBook>,
    pub system_program: Program<'info, System>,
}

pub fn init_class_book(ctx: Context<InitClassBook>) -> Result<()> {
    let x = crate::ext::read(&ctx.accounts.cross.to_account_info())?;
    require!(x.uses_class_book(), CrossError::InvalidParams);
    let mut b = ctx.accounts.class_book.load_init()?;
    b.cross = ctx.accounts.cross.key();
    Ok(())
}

/// Verifies that `account` is the class book of `cross` and returns the loader.
pub fn loader<'info>(
    account: &'info AccountInfo<'info>,
    cross: &Pubkey,
) -> Result<AccountLoader<'info, ClassBook>> {
    let (pda, _) = Pubkey::find_program_address(&[CLASS_BOOK_SEED, cross.as_ref()], &crate::ID);
    require_keys_eq!(account.key(), pda, CrossError::ClassBookMissing);
    AccountLoader::<ClassBook>::try_from(account)
}
