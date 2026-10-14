//! Opening Cross listing bonds (PRODUCT_FEATURES L1; ADR-0653).
//!
//! A venue (an integrator running Opening Cross under its own name) lets anyone list crosses on it, and asks for a
//! bond in return. The bond is real: it sits in a vault only this program can move, and the terms are fixed when
//! the venue is created, so a lister reads them once and they cannot change under it.
//!
//! - A lister deposits a bond and lists a cross it created. Each listing sets aside `min_bond` of the deposit.
//! - When the cross ends well (finalized, or did not print for a market reason) anyone can release the listing and
//!   the bond is free again, after the venue's delay.
//! - When the cross ends because the **settlement never happened** (a deferred-mint cross whose adapter did not
//!   bind a mint by its deadline: `NoPrintReason::SettlementExpired`) anyone can slash the listing, and the
//!   set-aside bond goes to the venue's slash account. That is the one fault the chain can prove without a judge:
//!   the cross account itself says it happened, and nobody but `cross_core` can write that.
//!
//! A bond is not insurance for buyers (they are refunded in full by the cross itself) and not a verdict on the
//! lister; it is a price on failing to deliver what a listing promised, paid by the one who promised it.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("6VsT7X4G7qjRaredx4Y9q6asGkySiXGVpNr4RrdbxSSi");

// `cross_core`'s interface, from its IDL: the cross account and its state, without linking its code.
declare_program!(cross_core);

pub const VENUE_SEED: &[u8] = b"venue";
pub const BOND_SEED: &[u8] = b"bond";
pub const LISTING_SEED: &[u8] = b"listing";
/// The shortest delay a venue may set between a cross's close and the release of its bond: a day.
pub const MIN_RELEASE_DELAY_SECS: i64 = 86_400;

#[program]
pub mod cross_listing {
    use super::*;

    /// Creates a venue with terms that never change. `slash_to` owns the account that receives slashed bonds.
    pub fn create_venue(
        ctx: Context<CreateVenue>,
        id: u64,
        min_bond: u64,
        release_delay_secs: i64,
        slash_to: Pubkey,
    ) -> Result<()> {
        require!(min_bond > 0, ListingError::BadTerms);
        require!(
            release_delay_secs >= MIN_RELEASE_DELAY_SECS,
            ListingError::BadTerms
        );
        let v = &mut ctx.accounts.venue;
        v.creator = ctx.accounts.creator.key();
        v.id = id;
        v.bond_mint = ctx.accounts.bond_mint.key();
        v.bond_token_program = ctx.accounts.token_program.key();
        v.min_bond = min_bond;
        v.release_delay_secs = release_delay_secs;
        v.slash_to = slash_to;
        v.bump = ctx.bumps.venue;
        emit!(VenueCreated {
            venue: v.key(),
            creator: v.creator,
            bond_mint: v.bond_mint,
            min_bond,
            release_delay_secs,
            slash_to
        });
        Ok(())
    }

    /// Opens a lister's bond account and vault on a venue, empty.
    pub fn open_bond(ctx: Context<OpenBond>) -> Result<()> {
        let b = &mut ctx.accounts.bond;
        b.venue = ctx.accounts.venue.key();
        b.lister = ctx.accounts.lister.key();
        b.amount = 0;
        b.encumbered = 0;
        b.bump = ctx.bumps.bond;
        Ok(())
    }

    /// Adds to a lister's bond on a venue.
    pub fn deposit_bond<'info>(ctx: Context<'info, DepositBond<'info>>, amount: u64) -> Result<()> {
        require!(amount > 0, ListingError::NothingToDo);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.lister_token.to_account_info(),
                    mint: ctx.accounts.bond_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.lister.to_account_info(),
                },
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.bond_mint.decimals,
        )?;
        let b = &mut ctx.accounts.bond;
        b.amount = b.amount.checked_add(amount).ok_or(ListingError::Overflow)?;
        emit!(BondDeposited {
            bond: b.key(),
            lister: b.lister,
            amount,
            total: b.amount
        });
        Ok(())
    }

    /// Takes back bond that no listing has set aside.
    pub fn withdraw_bond<'info>(
        ctx: Context<'info, WithdrawBond<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ListingError::NothingToDo);
        let b = &ctx.accounts.bond;
        let free = b
            .amount
            .checked_sub(b.encumbered)
            .ok_or(ListingError::Overflow)?;
        require!(amount <= free, ListingError::BondEncumbered);
        let venue = b.venue;
        let lister = b.lister;
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[BOND_SEED, venue.as_ref(), lister.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.bond_mint.to_account_info(),
                    to: ctx.accounts.lister_token.to_account_info(),
                    authority: ctx.accounts.bond.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.bond_mint.decimals,
        )?;
        let b = &mut ctx.accounts.bond;
        b.amount -= amount;
        emit!(BondWithdrawn {
            bond: b.key(),
            lister,
            amount,
            total: b.amount
        });
        Ok(())
    }

    /// Lists a cross the lister created, setting aside `min_bond`. Only a cross still taking orders can be listed,
    /// so a lister cannot list a cross it already knows has gone wrong.
    pub fn list_cross(ctx: Context<ListCross>) -> Result<()> {
        let cross = read_cross(&ctx.accounts.cross)?;
        require_keys_eq!(
            cross.creator,
            ctx.accounts.lister.key(),
            ListingError::NotTheCreator
        );
        require!(
            matches!(cross.state, cross_core::types::CrossState::Live),
            ListingError::CrossNotLive
        );
        let v = &ctx.accounts.venue;
        let b = &mut ctx.accounts.bond;
        let free = b
            .amount
            .checked_sub(b.encumbered)
            .ok_or(ListingError::Overflow)?;
        require!(free >= v.min_bond, ListingError::BondTooSmall);
        b.encumbered = b
            .encumbered
            .checked_add(v.min_bond)
            .ok_or(ListingError::Overflow)?;
        let l = &mut ctx.accounts.listing;
        l.venue = v.key();
        l.lister = ctx.accounts.lister.key();
        l.cross = ctx.accounts.cross.key();
        l.amount = v.min_bond;
        l.release_after = cross
            .close_ts
            .checked_add(v.release_delay_secs)
            .ok_or(ListingError::Overflow)?;
        l.settled = false;
        l.bump = ctx.bumps.listing;
        emit!(Listed {
            listing: l.key(),
            venue: l.venue,
            lister: l.lister,
            cross: l.cross,
            amount: l.amount
        });
        Ok(())
    }

    /// Frees a listing's set-aside bond once its cross has ended without the fault and the delay has passed.
    /// Permissionless.
    pub fn release_listing(ctx: Context<Settle>) -> Result<()> {
        let cross = read_cross(&ctx.accounts.cross)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.listing.release_after,
            ListingError::TooEarly
        );
        let ended_well = match cross.state {
            cross_core::types::CrossState::Finalized => true,
            cross_core::types::CrossState::NoPrint => !is_settlement_fault(&cross),
            _ => false,
        };
        require!(ended_well, ListingError::NotEnded);
        let l = &mut ctx.accounts.listing;
        let b = &mut ctx.accounts.bond;
        require!(!l.settled, ListingError::AlreadySettled);
        l.settled = true;
        b.encumbered = b
            .encumbered
            .checked_sub(l.amount)
            .ok_or(ListingError::Overflow)?;
        emit!(ListingReleased {
            listing: l.key(),
            amount: l.amount
        });
        Ok(())
    }

    /// Sends a listing's set-aside bond to the venue's slash account when its cross ended because the settlement
    /// never happened. Permissionless; the fault is read from the cross account.
    pub fn slash_listing<'info>(ctx: Context<'info, SlashListing<'info>>) -> Result<()> {
        let cross = read_cross(&ctx.accounts.cross)?;
        require!(
            matches!(cross.state, cross_core::types::CrossState::NoPrint)
                && is_settlement_fault(&cross),
            ListingError::NoFault
        );
        let l = &mut ctx.accounts.listing;
        require!(!l.settled, ListingError::AlreadySettled);
        l.settled = true;
        let amount = l.amount;
        let b = &mut ctx.accounts.bond;
        b.encumbered = b
            .encumbered
            .checked_sub(amount)
            .ok_or(ListingError::Overflow)?;
        b.amount = b.amount.checked_sub(amount).ok_or(ListingError::Overflow)?;
        let venue = b.venue;
        let lister = b.lister;
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[BOND_SEED, venue.as_ref(), lister.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.bond_mint.to_account_info(),
                    to: ctx.accounts.slash_account.to_account_info(),
                    authority: ctx.accounts.bond.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.bond_mint.decimals,
        )?;
        emit!(ListingSlashed {
            listing: ctx.accounts.listing.key(),
            amount,
            to: ctx.accounts.slash_account.key()
        });
        Ok(())
    }
}

fn read_cross(info: &UncheckedAccount) -> Result<cross_core::accounts::Cross> {
    require_keys_eq!(*info.owner, cross_core::ID, ListingError::NotACross);
    let data = info.try_borrow_data()?;
    cross_core::accounts::Cross::try_deserialize(&mut &data[..])
        .map_err(|_| error!(ListingError::NotACross))
}

/// The one fault the cross account proves: it did not print because its settlement adapter never bound a mint.
fn is_settlement_fault(cross: &cross_core::accounts::Cross) -> bool {
    matches!(
        cross.no_print_reason,
        Some(cross_core::types::NoPrintReason::SettlementExpired)
    )
}

#[account]
#[derive(InitSpace)]
pub struct Venue {
    pub creator: Pubkey,
    pub id: u64,
    pub bond_mint: Pubkey,
    pub bond_token_program: Pubkey,
    pub min_bond: u64,
    pub release_delay_secs: i64,
    /// Owner of the token account that receives slashed bonds.
    pub slash_to: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Bond {
    pub venue: Pubkey,
    pub lister: Pubkey,
    /// Deposited and still in the vault.
    pub amount: u64,
    /// Part of `amount` that open listings have set aside.
    pub encumbered: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub venue: Pubkey,
    pub lister: Pubkey,
    pub cross: Pubkey,
    pub amount: u64,
    pub release_after: i64,
    /// Released or slashed.
    pub settled: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateVenue<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub bond_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + Venue::INIT_SPACE, seeds = [VENUE_SEED, creator.key().as_ref(), &id.to_le_bytes()], bump)]
    pub venue: Box<Account<'info, Venue>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenBond<'info> {
    #[account(mut)]
    pub lister: Signer<'info>,
    #[account(has_one = bond_mint @ ListingError::WrongMint)]
    pub venue: Box<Account<'info, Venue>>,
    pub bond_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = lister, space = 8 + Bond::INIT_SPACE, seeds = [BOND_SEED, venue.key().as_ref(), lister.key().as_ref()], bump)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(init, payer = lister, associated_token::mint = bond_mint, associated_token::authority = bond, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = venue.bond_token_program @ ListingError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositBond<'info> {
    pub lister: Signer<'info>,
    #[account(has_one = bond_mint @ ListingError::WrongMint)]
    pub venue: Box<Account<'info, Venue>>,
    pub bond_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = bond_mint, token::authority = lister, token::token_program = token_program)]
    pub lister_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, has_one = lister @ ListingError::Unauthorized, has_one = venue @ ListingError::Unauthorized, seeds = [BOND_SEED, venue.key().as_ref(), lister.key().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(mut, associated_token::mint = bond_mint, associated_token::authority = bond, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = venue.bond_token_program @ ListingError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawBond<'info> {
    pub lister: Signer<'info>,
    #[account(has_one = bond_mint @ ListingError::WrongMint)]
    pub venue: Box<Account<'info, Venue>>,
    pub bond_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, has_one = lister @ ListingError::Unauthorized, has_one = venue @ ListingError::Unauthorized, seeds = [BOND_SEED, venue.key().as_ref(), lister.key().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    #[account(mut, associated_token::mint = bond_mint, associated_token::authority = bond, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = bond_mint, token::authority = lister, token::token_program = token_program)]
    pub lister_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = venue.bond_token_program @ ListingError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ListCross<'info> {
    #[account(mut)]
    pub lister: Signer<'info>,
    pub venue: Box<Account<'info, Venue>>,
    #[account(mut, has_one = lister @ ListingError::Unauthorized, has_one = venue @ ListingError::Unauthorized, seeds = [BOND_SEED, venue.key().as_ref(), lister.key().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    #[account(init, payer = lister, space = 8 + Listing::INIT_SPACE, seeds = [LISTING_SEED, venue.key().as_ref(), cross.key().as_ref()], bump)]
    pub listing: Box<Account<'info, Listing>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, has_one = cross @ ListingError::WrongCross, has_one = venue @ ListingError::Unauthorized, has_one = lister @ ListingError::Unauthorized)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: the listing's lister, bound by `has_one`.
    pub lister: UncheckedAccount<'info>,
    pub venue: Box<Account<'info, Venue>>,
    #[account(mut, has_one = lister @ ListingError::Unauthorized, has_one = venue @ ListingError::Unauthorized, seeds = [BOND_SEED, venue.key().as_ref(), lister.key().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    /// CHECK: owner and contents checked in `read_cross`; bound to the listing by `has_one`.
    pub cross: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SlashListing<'info> {
    #[account(mut, has_one = cross @ ListingError::WrongCross, has_one = venue @ ListingError::Unauthorized, has_one = lister @ ListingError::Unauthorized)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: the listing's lister, bound by `has_one`.
    pub lister: UncheckedAccount<'info>,
    #[account(has_one = bond_mint @ ListingError::WrongMint)]
    pub venue: Box<Account<'info, Venue>>,
    #[account(mut, has_one = lister @ ListingError::Unauthorized, has_one = venue @ ListingError::Unauthorized, seeds = [BOND_SEED, venue.key().as_ref(), lister.key().as_ref()], bump = bond.bump)]
    pub bond: Box<Account<'info, Bond>>,
    /// CHECK: owner and contents checked in `read_cross`; bound to the listing by `has_one`.
    pub cross: UncheckedAccount<'info>,
    pub bond_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = bond_mint, associated_token::authority = bond, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = bond_mint, token::authority = venue.slash_to, token::token_program = token_program)]
    pub slash_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = venue.bond_token_program @ ListingError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct VenueCreated {
    pub venue: Pubkey,
    pub creator: Pubkey,
    pub bond_mint: Pubkey,
    pub min_bond: u64,
    pub release_delay_secs: i64,
    pub slash_to: Pubkey,
}
#[event]
pub struct BondDeposited {
    pub bond: Pubkey,
    pub lister: Pubkey,
    pub amount: u64,
    pub total: u64,
}
#[event]
pub struct BondWithdrawn {
    pub bond: Pubkey,
    pub lister: Pubkey,
    pub amount: u64,
    pub total: u64,
}
#[event]
pub struct Listed {
    pub listing: Pubkey,
    pub venue: Pubkey,
    pub lister: Pubkey,
    pub cross: Pubkey,
    pub amount: u64,
}
#[event]
pub struct ListingReleased {
    pub listing: Pubkey,
    pub amount: u64,
}
#[event]
pub struct ListingSlashed {
    pub listing: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
}

#[error_code]
pub enum ListingError {
    #[msg("A venue needs a positive bond and a release delay of at least a day")]
    BadTerms,
    #[msg("Nothing to do")]
    NothingToDo,
    #[msg("That part of the bond is set aside by an open listing")]
    BondEncumbered,
    #[msg("Only the creator of a cross can list it")]
    NotTheCreator,
    #[msg("Only a cross still taking orders can be listed")]
    CrossNotLive,
    #[msg("The free bond is smaller than the venue's minimum")]
    BondTooSmall,
    #[msg("The cross has not ended in a way that releases the bond, or the delay has not passed")]
    NotEnded,
    #[msg("The release delay has not passed")]
    TooEarly,
    #[msg("The cross did not fail by an unbound settlement")]
    NoFault,
    #[msg("This listing was already released or slashed")]
    AlreadySettled,
    #[msg("The account is not a cross")]
    NotACross,
    #[msg("The cross is not the one listed")]
    WrongCross,
    #[msg("The token is not the venue's bond token")]
    WrongMint,
    #[msg("Signer or account does not match")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
}
