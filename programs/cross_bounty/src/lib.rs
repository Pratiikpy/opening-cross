//! Opening Cross bounty (PRODUCT_FEATURES X10; ADR-0654).
//!
//! "We pay attackers to break live crosses", made enforceable. A bounty is a pool the sponsor commits until a date it
//! chose; it can only leave the vault in two ways before then:
//!
//! - **Automatically**, to whoever shows a cross account that breaks one of the program's invariants. A cross account
//!   is written only by `cross_core`, so an account in a state `cross_core` promises never to produce is proof of a
//!   bug, not of a claim. Each invariant pays once (the first proof), so a bug seen on fifty crosses costs one reward.
//! - **By the arbiter**, for what the chain cannot check (a theft path, a griefing vector, a rounding exploit with real
//!   funds). The arbiter is named when the bounty is created, cannot change, and every award is an event with the hash
//!   of the report it paid for.
//!
//! After the expiry the sponsor takes back whatever is left. Before it, nobody can: that commitment is the point.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("BSXaBkmhyypBNp5nfwb4GHAL7uDDLVR8Tr3UyHJKsWMz");

// `cross_core`'s interface, from its IDL: the cross account and its state, without linking its code.
declare_program!(cross_core);

pub const BOUNTY_SEED: &[u8] = b"bounty";
/// Invariants this version checks; ids are positions in `Bounty::rewards`.
pub const INVARIANTS: usize = 11;
/// The shortest commitment a bounty may make: thirty days.
pub const MIN_COMMITMENT_SECS: i64 = 30 * 86_400;
const MAX_FEE_BPS_PROTOCOL: u16 = 100;
const MAX_FEE_BPS_INTEGRATOR: u16 = 300;

#[program]
pub mod cross_bounty {
    use super::*;

    /// Creates a bounty. `rewards[i]` is paid for invariant `i` (zero leaves it out); the terms never change.
    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        id: u64,
        arbiter: Pubkey,
        expires_at: i64,
        rewards: [u64; INVARIANTS],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            expires_at
                >= now
                    .checked_add(MIN_COMMITMENT_SECS)
                    .ok_or(BountyError::Overflow)?,
            BountyError::CommitmentTooShort
        );
        let b = &mut ctx.accounts.bounty;
        b.sponsor = ctx.accounts.sponsor.key();
        b.id = id;
        b.arbiter = arbiter;
        b.reward_mint = ctx.accounts.reward_mint.key();
        b.token_program = ctx.accounts.token_program.key();
        b.expires_at = expires_at;
        b.rewards = rewards;
        b.paid_mask = 0;
        b.awarded = 0;
        b.bump = ctx.bumps.bounty;
        emit!(BountyCreated {
            bounty: b.key(),
            sponsor: b.sponsor,
            arbiter,
            reward_mint: b.reward_mint,
            expires_at,
            rewards
        });
        Ok(())
    }

    /// Adds to the pool. Anyone may; it can never be taken back before the expiry.
    pub fn fund<'info>(ctx: Context<'info, Fund<'info>>, amount: u64) -> Result<()> {
        require!(amount > 0, BountyError::NothingToDo);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.funder_token.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;
        emit!(BountyFunded {
            bounty: ctx.accounts.bounty.key(),
            funder: ctx.accounts.funder.key(),
            amount
        });
        Ok(())
    }

    /// Pays the reward for invariant `invariant` to the claimant if `cross` breaks it. Each invariant pays once.
    pub fn claim_invariant<'info>(
        ctx: Context<'info, ClaimInvariant<'info>>,
        invariant: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &ctx.accounts.bounty;
        require!(now < b.expires_at, BountyError::Expired);
        let i = usize::from(invariant);
        require!(i < INVARIANTS, BountyError::UnknownInvariant);
        let reward = b.rewards[i];
        require!(reward > 0, BountyError::NotCovered);
        require!(b.paid_mask & (1 << i) == 0, BountyError::AlreadyPaid);
        let cross = read_cross(&ctx.accounts.cross)?;
        require!(violates(invariant, &cross), BountyError::NoViolation);
        let pay = reward.min(ctx.accounts.vault.amount);
        require!(pay > 0, BountyError::PoolEmpty);
        let sponsor = b.sponsor;
        let id = b.id.to_le_bytes();
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[BOUNTY_SEED, sponsor.as_ref(), &id, &bump];
        let b = &mut ctx.accounts.bounty;
        b.paid_mask |= 1 << i;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.claimant_token.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            pay,
            ctx.accounts.reward_mint.decimals,
        )?;
        emit!(InvariantPaid {
            bounty: ctx.accounts.bounty.key(),
            invariant,
            cross: ctx.accounts.cross.key(),
            claimant: ctx.accounts.claimant.key(),
            amount: pay
        });
        Ok(())
    }

    /// The arbiter pays `amount` for a report the chain cannot check. `evidence` is the hash of the report.
    pub fn award<'info>(
        ctx: Context<'info, Award<'info>>,
        amount: u64,
        evidence: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &ctx.accounts.bounty;
        require!(now < b.expires_at, BountyError::Expired);
        require!(amount > 0, BountyError::NothingToDo);
        let sponsor = b.sponsor;
        let id = b.id.to_le_bytes();
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[BOUNTY_SEED, sponsor.as_ref(), &id, &bump];
        let b = &mut ctx.accounts.bounty;
        b.awarded = b.awarded.checked_add(amount).ok_or(BountyError::Overflow)?;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.hunter_token.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;
        emit!(Awarded {
            bounty: ctx.accounts.bounty.key(),
            to: ctx.accounts.hunter_token.key(),
            amount,
            evidence
        });
        Ok(())
    }

    /// The sponsor takes back what is left, once the commitment has run.
    pub fn withdraw<'info>(ctx: Context<'info, Withdraw<'info>>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let b = &ctx.accounts.bounty;
        require!(now >= b.expires_at, BountyError::StillCommitted);
        require!(amount > 0, BountyError::NothingToDo);
        let sponsor = b.sponsor;
        let id = b.id.to_le_bytes();
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[BOUNTY_SEED, sponsor.as_ref(), &id, &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.sponsor_token.to_account_info(),
                    authority: ctx.accounts.bounty.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;
        emit!(BountyWithdrawn {
            bounty: ctx.accounts.bounty.key(),
            amount
        });
        Ok(())
    }
}

fn read_cross(info: &UncheckedAccount) -> Result<cross_core::accounts::Cross> {
    require_keys_eq!(*info.owner, cross_core::ID, BountyError::NotACross);
    let data = info.try_borrow_data()?;
    cross_core::accounts::Cross::try_deserialize(&mut &data[..])
        .map_err(|_| error!(BountyError::NotACross))
}

/// Whether `cross` is in a state `cross_core` promises never to produce. The ids are fixed:
///
/// 0. more orders open than were ever placed;
/// 1. cleared with no clearing summary;
/// 2. did not print with no reason;
/// 3. finalized with an order still open;
/// 4. a clearing price off the cross's own grid;
/// 5. a fee above the protocol caps (100 bps protocol, 300 bps integrator);
/// 6. matched volume above the demand or the supply the clear itself recorded;
/// 7. every order claimed, in escrow mode, and sellers were paid more than buyers paid plus the quote value of the
///    base that sellers delivered and buyers did not take (`seller_paid <= buyer_paid + (sold - bought) * P / scale`
///    is a theorem of the rounding: buyers round up, sellers round down);
/// 8. a clearing summary or a no-print reason on a cross that is still taking orders;
/// 9. every order claimed, in escrow mode, and buyers took more base than sellers delivered;
/// 10. every order claimed and buyers took more base than the clear matched.
pub fn violates(invariant: u8, c: &cross_core::accounts::Cross) -> bool {
    use cross_core::types::{CrossState, SupplyMode};
    let live = matches!(c.state, CrossState::Live);
    let cleared = matches!(c.state, CrossState::Cleared);
    let done = matches!(c.state, CrossState::Cleared | CrossState::Finalized);
    match invariant {
        0 => c.orders_open > c.orders_total,
        1 => cleared && c.clearing.is_none(),
        2 => matches!(c.state, CrossState::NoPrint) && c.no_print_reason.is_none(),
        3 => matches!(c.state, CrossState::Finalized) && c.orders_open != 0,
        4 => {
            cleared
                && c.clearing
                    .as_ref()
                    .is_some_and(|s| !on_grid(s.price, c.min_price, c.tick, c.ticks))
        }
        5 => {
            c.protocol_fee_bps > MAX_FEE_BPS_PROTOCOL
                || c.integrator_fee_bps > MAX_FEE_BPS_INTEGRATOR
        }
        6 => {
            done && c
                .clearing
                .as_ref()
                .is_some_and(|s| s.matched > s.demand.min(s.supply))
        }
        7 => {
            done && c.orders_open == 0
                && matches!(c.supply_mode, SupplyMode::Escrow)
                && c.clearing.as_ref().is_some_and(|s| {
                    let undelivered = u128::from(c.base_sold.saturating_sub(c.base_bought));
                    let dust_value =
                        undelivered * u128::from(s.price) / u128::from(c.price_scale.max(1));
                    u128::from(c.seller_paid) > u128::from(c.buyer_paid) + dust_value
                })
        }
        8 => live && (c.clearing.is_some() || c.no_print_reason.is_some()),
        9 => {
            done && c.orders_open == 0
                && matches!(c.supply_mode, SupplyMode::Escrow)
                && c.base_bought > c.base_sold
        }
        10 => {
            done && c.orders_open == 0
                && c.clearing
                    .as_ref()
                    .is_some_and(|s| u128::from(c.base_bought) > s.matched)
        }
        _ => false,
    }
}

/// Whether `price` is `min + i * tick` for some `i < ticks`.
pub fn on_grid(price: u64, min: u64, tick: u64, ticks: u16) -> bool {
    let Some(offset) = price.checked_sub(min) else {
        return false;
    };
    if tick == 0 {
        return false;
    }
    offset % tick == 0 && offset / tick < u64::from(ticks)
}

#[account]
#[derive(InitSpace)]
pub struct Bounty {
    pub sponsor: Pubkey,
    pub id: u64,
    pub arbiter: Pubkey,
    pub reward_mint: Pubkey,
    pub token_program: Pubkey,
    pub expires_at: i64,
    pub rewards: [u64; INVARIANTS],
    /// Bit `i` is set once invariant `i` has paid.
    pub paid_mask: u16,
    /// Total paid by the arbiter.
    pub awarded: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateBounty<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = sponsor, space = 8 + Bounty::INIT_SPACE, seeds = [BOUNTY_SEED, sponsor.key().as_ref(), &id.to_le_bytes()], bump)]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(init, payer = sponsor, associated_token::mint = reward_mint, associated_token::authority = bounty, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    pub funder: Signer<'info>,
    #[account(has_one = reward_mint @ BountyError::WrongMint)]
    pub bounty: Box<Account<'info, Bounty>>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = reward_mint, token::authority = funder, token::token_program = token_program)]
    pub funder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = reward_mint, associated_token::authority = bounty, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = bounty.token_program @ BountyError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimInvariant<'info> {
    pub claimant: Signer<'info>,
    #[account(mut, has_one = reward_mint @ BountyError::WrongMint)]
    pub bounty: Box<Account<'info, Bounty>>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = reward_mint, associated_token::authority = bounty, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = reward_mint, token::authority = claimant, token::token_program = token_program)]
    pub claimant_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = bounty.token_program @ BountyError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Award<'info> {
    pub arbiter: Signer<'info>,
    #[account(mut, has_one = arbiter @ BountyError::Unauthorized, has_one = reward_mint @ BountyError::WrongMint)]
    pub bounty: Box<Account<'info, Bounty>>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = reward_mint, associated_token::authority = bounty, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = reward_mint, token::token_program = token_program)]
    pub hunter_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = bounty.token_program @ BountyError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub sponsor: Signer<'info>,
    #[account(has_one = sponsor @ BountyError::Unauthorized, has_one = reward_mint @ BountyError::WrongMint)]
    pub bounty: Box<Account<'info, Bounty>>,
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = reward_mint, associated_token::authority = bounty, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = reward_mint, token::authority = sponsor, token::token_program = token_program)]
    pub sponsor_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = bounty.token_program @ BountyError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct BountyCreated {
    pub bounty: Pubkey,
    pub sponsor: Pubkey,
    pub arbiter: Pubkey,
    pub reward_mint: Pubkey,
    pub expires_at: i64,
    pub rewards: [u64; INVARIANTS],
}
#[event]
pub struct BountyFunded {
    pub bounty: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
}
#[event]
pub struct InvariantPaid {
    pub bounty: Pubkey,
    pub invariant: u8,
    pub cross: Pubkey,
    pub claimant: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Awarded {
    pub bounty: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub evidence: [u8; 32],
}
#[event]
pub struct BountyWithdrawn {
    pub bounty: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum BountyError {
    #[msg("A bounty must commit its pool for at least thirty days")]
    CommitmentTooShort,
    #[msg("Nothing to do")]
    NothingToDo,
    #[msg("The bounty has expired")]
    Expired,
    #[msg("The pool is committed until the expiry")]
    StillCommitted,
    #[msg("There is no such invariant")]
    UnknownInvariant,
    #[msg("This bounty pays nothing for that invariant")]
    NotCovered,
    #[msg("That invariant has already been paid")]
    AlreadyPaid,
    #[msg("The cross does not break that invariant")]
    NoViolation,
    #[msg("The pool is empty")]
    PoolEmpty,
    #[msg("The account is not a cross")]
    NotACross,
    #[msg("The token is not the bounty's reward token")]
    WrongMint,
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cross account as `cross_core` writes it, all zero: live, no orders, no summary.
    fn blank() -> cross_core::accounts::Cross {
        let mut data = cross_core::accounts::Cross::DISCRIMINATOR.to_vec();
        data.extend(vec![0u8; 660]);
        cross_core::accounts::Cross::try_deserialize(&mut &data[..]).expect("blank cross")
    }

    #[test]
    fn a_blank_cross_breaks_nothing() {
        let c = blank();
        for i in 0..INVARIANTS as u8 {
            assert!(!violates(i, &c), "invariant {i}");
        }
        assert!(!violates(200, &c));
    }

    #[test]
    fn each_invariant_fires_on_exactly_its_shape() {
        use cross_core::types::{CrossState, NoPrintReason};
        let mut c = blank();
        c.orders_total = 3;
        c.orders_open = 4;
        assert!(violates(0, &c));
        c.orders_open = 3;
        assert!(!violates(0, &c));

        let mut c = blank();
        c.state = CrossState::Cleared;
        assert!(violates(1, &c));
        c.state = CrossState::NoPrint;
        assert!(violates(2, &c));
        c.no_print_reason = Some(NoPrintReason::NoCross);
        assert!(!violates(2, &c));

        let mut c = blank();
        c.state = CrossState::Finalized;
        c.orders_open = 1;
        c.orders_total = 1;
        assert!(violates(3, &c));
        c.orders_open = 0;
        assert!(!violates(3, &c));

        let mut c = blank();
        c.protocol_fee_bps = 101;
        assert!(violates(5, &c));
        c.protocol_fee_bps = 100;
        c.integrator_fee_bps = 301;
        assert!(violates(5, &c));
        c.integrator_fee_bps = 300;
        assert!(!violates(5, &c));

        // Sellers paid 10 against buyers' 9 and no undelivered base: fires. One more quote from buyers: does not.
        let mut c = blank();
        c.state = CrossState::Cleared;
        c.price_scale = 1_000_000;
        c.clearing = Some(cross_core::types::ClearingSummary {
            price: 2_000_000,
            ..Default::default()
        });
        c.buyer_paid = 9;
        c.seller_paid = 10;
        assert!(violates(7, &c));
        c.buyer_paid = 10;
        assert!(!violates(7, &c));
        // Three base atoms delivered and not taken are worth 6 at price 2: sellers may have been paid 6 more.
        c.buyer_paid = 4;
        c.base_sold = 5;
        c.base_bought = 2;
        c.seller_paid = 10;
        assert!(!violates(7, &c));
        c.seller_paid = 11;
        assert!(violates(7, &c));
        c.orders_open = 1;
        assert!(!violates(7, &c));

        let mut c = blank();
        c.state = CrossState::Finalized;
        c.base_bought = 5;
        c.base_sold = 4;
        assert!(violates(9, &c));
        c.base_sold = 5;
        assert!(!violates(9, &c));
        c.clearing = Some(cross_core::types::ClearingSummary {
            matched: 4,
            ..Default::default()
        });
        assert!(violates(10, &c));
        c.clearing = Some(cross_core::types::ClearingSummary {
            matched: 5,
            ..Default::default()
        });
        assert!(!violates(10, &c));

        let mut c = blank();
        c.no_print_reason = Some(NoPrintReason::NoCross);
        assert!(violates(8, &c));
    }

    #[test]
    fn the_grid_check_is_exact() {
        assert!(on_grid(1_000_000, 1_000_000, 100_000, 20));
        assert!(on_grid(2_900_000, 1_000_000, 100_000, 20));
        assert!(!on_grid(3_000_000, 1_000_000, 100_000, 20));
        assert!(!on_grid(1_050_000, 1_000_000, 100_000, 20));
        assert!(!on_grid(999_999, 1_000_000, 100_000, 20));
        assert!(!on_grid(5, 0, 0, 20));
    }
}
