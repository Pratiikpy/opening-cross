//! Opening Cross baskets (PRODUCT_FEATURES S5, K3; ADR-0652).
//!
//! A basket is a share token backed by fixed amounts of up to eight tokens. One whole share (10^6 share atoms) is
//! always `units_per_share[i]` atoms of component `i`. Anyone can mint shares by depositing that backing and
//! redeem shares for it; there is no manager, no fee, no rebalancing and no way to change a basket after it is
//! created, so the share is exactly the sum of its parts.
//!
//! Rounding always favours the basket: a deposit rounds up, a redemption rounds down. After every mint and every
//! redemption the program checks that each vault holds at least what the outstanding shares are owed
//! (`Insolvent` otherwise), so the invariant is enforced, not just argued.
//!
//! Components are limited to mints that behave like plain tokens: legacy SPL tokens and Token-2022 mints whose
//! only extensions are display ones (metadata, groups, scaled or interest-bearing UI amounts). A mint that can
//! take a fee, move a balance without its owner (permanent delegate), pause, hook or restrict a transfer would
//! make the backing unprovable, so it is refused at creation.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::{self, Burn, MintTo, Token};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as Mint2022,
};
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TransferChecked};

declare_id!("4uNyZ4fSihcnrqASfYHCC35edh3EdndP37jSWqWQZxCp");

pub const BASKET_SEED: &[u8] = b"basket";
pub const SHARE_SEED: &[u8] = b"share";
/// Share atoms in one whole share (the share mint has six decimals).
pub const SHARE_UNIT: u128 = 1_000_000;
pub const SHARE_DECIMALS: u8 = 6;
/// Most components a basket can have. A transaction that touches more than about five needs an address lookup table.
pub const MAX_COMPONENTS: usize = 8;
pub const MAX_LABEL: usize = 32;

#[program]
pub mod cross_basket {
    use super::*;

    /// Creates a basket and its share mint. Remaining accounts: for each component, in order, its mint and the
    /// basket's vault for it (the associated token account of the basket PDA, created beforehand).
    pub fn create_basket<'info>(
        ctx: Context<'info, CreateBasket<'info>>,
        id: u64,
        label: String,
        units_per_share: Vec<u64>,
    ) -> Result<()> {
        let n = units_per_share.len();
        require!(
            (1..=MAX_COMPONENTS).contains(&n) && label.len() <= MAX_LABEL,
            BasketError::BadBasket
        );
        require!(
            ctx.remaining_accounts.len() == 2 * n,
            BasketError::BadBasket
        );
        let basket_key = ctx.accounts.basket.key();
        let mut components = Vec::with_capacity(n);
        for (i, units) in units_per_share.iter().enumerate() {
            require!(*units > 0, BasketError::BadBasket);
            let mint_info = &ctx.remaining_accounts[2 * i];
            let vault_info = &ctx.remaining_accounts[2 * i + 1];
            let program = *mint_info.owner;
            require!(
                program == anchor_spl::token::ID || program == anchor_spl::token_2022::ID,
                BasketError::BadComponent
            );
            require!(
                !components
                    .iter()
                    .any(|c: &Component| c.mint == mint_info.key()),
                BasketError::DuplicateComponent
            );
            if program == anchor_spl::token_2022::ID {
                check_extensions(&mint_info.try_borrow_data()?)?;
            }
            let vault = InterfaceAccount::<TokenAccount>::try_from(vault_info)?;
            require_keys_eq!(vault.mint, mint_info.key(), BasketError::BadVault);
            require_keys_eq!(vault.owner, basket_key, BasketError::BadVault);
            require_keys_eq!(
                vault_info.key(),
                get_associated_token_address_with_program_id(
                    &basket_key,
                    &mint_info.key(),
                    &program
                ),
                BasketError::BadVault
            );
            components.push(Component {
                mint: mint_info.key(),
                token_program: program,
                units_per_share: *units,
            });
        }
        let b = &mut ctx.accounts.basket;
        b.creator = ctx.accounts.creator.key();
        b.id = id;
        b.share_mint = ctx.accounts.share_mint.key();
        b.label = label;
        b.components = components;
        b.bump = ctx.bumps.basket;
        emit!(BasketCreated {
            basket: b.key(),
            creator: b.creator,
            share_mint: b.share_mint,
            components: b.components.clone()
        });
        Ok(())
    }

    /// Deposits the backing for `shares` share atoms and mints them. Remaining accounts: for each component, its
    /// mint, the basket's vault and the depositor's token account.
    pub fn mint_shares<'info>(ctx: Context<'info, MintShares<'info>>, shares: u64) -> Result<()> {
        require!(shares > 0, BasketError::NothingToDo);
        let mut legs = legs(
            ctx.accounts.basket.key(),
            &ctx.accounts.basket,
            ctx.remaining_accounts,
            &ctx.accounts.user.key(),
        )?;
        for leg in legs.iter_mut() {
            let owed = required(leg.units, shares, Rounding::Up)?;
            let before = leg.vault.amount;
            token_interface::transfer_checked(
                CpiContext::new(
                    leg.program,
                    TransferChecked {
                        from: leg.user_token.to_account_info(),
                        mint: leg.mint.to_account_info(),
                        to: leg.vault.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                owed,
                leg.mint.decimals,
            )?;
            leg.vault.reload()?;
            require!(
                leg.vault
                    .amount
                    .checked_sub(before)
                    .ok_or(BasketError::Overflow)?
                    >= owed,
                BasketError::Insolvent
            );
        }
        let b = &ctx.accounts.basket;
        let id = b.id.to_le_bytes();
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[BASKET_SEED, b.creator.as_ref(), &id, &bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.basket.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;
        ctx.accounts.share_mint.reload()?;
        check_solvent(&legs, ctx.accounts.share_mint.supply)?;
        emit!(SharesMinted {
            basket: ctx.accounts.basket.key(),
            user: ctx.accounts.user.key(),
            shares
        });
        Ok(())
    }

    /// Burns `shares` share atoms and pays out their backing, rounded down. Same remaining accounts as `mint_shares`.
    pub fn redeem_shares<'info>(
        ctx: Context<'info, RedeemShares<'info>>,
        shares: u64,
    ) -> Result<()> {
        require!(shares > 0, BasketError::NothingToDo);
        let mut legs = legs(
            ctx.accounts.basket.key(),
            &ctx.accounts.basket,
            ctx.remaining_accounts,
            &ctx.accounts.user.key(),
        )?;
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.user_shares.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;
        let b = &ctx.accounts.basket;
        let id = b.id.to_le_bytes();
        let bump = [b.bump];
        let seeds: &[&[u8]] = &[BASKET_SEED, b.creator.as_ref(), &id, &bump];
        for leg in &legs {
            let out = required(leg.units, shares, Rounding::Down)?;
            if out == 0 {
                continue;
            }
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    leg.program,
                    TransferChecked {
                        from: leg.vault.to_account_info(),
                        mint: leg.mint.to_account_info(),
                        to: leg.user_token.to_account_info(),
                        authority: ctx.accounts.basket.to_account_info(),
                    },
                    &[seeds],
                ),
                out,
                leg.mint.decimals,
            )?;
        }
        ctx.accounts.share_mint.reload()?;
        let supply = ctx.accounts.share_mint.supply;
        for leg in legs.iter_mut() {
            leg.vault.reload()?;
        }
        check_solvent(&legs, supply)?;
        emit!(SharesRedeemed {
            basket: ctx.accounts.basket.key(),
            user: ctx.accounts.user.key(),
            shares
        });
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Rounding {
    Up,
    Down,
}

/// `units * shares / 10^6` in atoms of one component, rounded as asked.
pub fn owed(units: u64, shares: u64, up: bool) -> Option<u64> {
    let n = u128::from(units).checked_mul(u128::from(shares))?;
    let q = n / SHARE_UNIT;
    let q = if up && n % SHARE_UNIT != 0 { q + 1 } else { q };
    u64::try_from(q).ok()
}

fn required(units: u64, shares: u64, r: Rounding) -> Result<u64> {
    owed(units, shares, matches!(r, Rounding::Up)).ok_or_else(|| error!(BasketError::Overflow))
}

/// Whether a vault of `balance` atoms covers `supply` share atoms at `units` per whole share.
pub fn covers(balance: u64, units: u64, supply: u64) -> bool {
    u128::from(balance) * SHARE_UNIT >= u128::from(units) * u128::from(supply)
}

fn check_solvent(legs: &[Leg], supply: u64) -> Result<()> {
    for leg in legs {
        require!(
            covers(leg.vault.amount, leg.units, supply),
            BasketError::Insolvent
        );
    }
    Ok(())
}

/// Extensions a component may carry: display only. Anything that can charge, move, freeze, hook or pause a
/// balance is refused (ADR-0652).
fn check_extensions(mint_data: &[u8]) -> Result<()> {
    let state = StateWithExtensions::<Mint2022>::unpack(mint_data)
        .map_err(|_| error!(BasketError::BadComponent))?;
    let kinds = state
        .get_extension_types()
        .map_err(|_| error!(BasketError::BadComponent))?;
    for k in kinds {
        require!(
            matches!(
                k,
                ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
                    | ExtensionType::GroupPointer
                    | ExtensionType::GroupMemberPointer
                    | ExtensionType::TokenGroup
                    | ExtensionType::TokenGroupMember
                    | ExtensionType::ScaledUiAmount
                    | ExtensionType::InterestBearingConfig
            ),
            BasketError::UnsafeExtension
        );
    }
    Ok(())
}

struct Leg<'info> {
    mint: InterfaceAccount<'info, Mint>,
    vault: InterfaceAccount<'info, TokenAccount>,
    user_token: InterfaceAccount<'info, TokenAccount>,
    units: u64,
    program: Pubkey,
}

/// The component accounts of a mint or a redemption, checked against the basket: three per component.
fn legs<'info>(
    basket_key: Pubkey,
    basket: &Basket,
    remaining: &'info [AccountInfo<'info>],
    user: &Pubkey,
) -> Result<Vec<Leg<'info>>> {
    require!(
        remaining.len() == 3 * basket.components.len(),
        BasketError::BadAccounts
    );
    let mut out = Vec::with_capacity(basket.components.len());
    for (i, c) in basket.components.iter().enumerate() {
        let mint_info = &remaining[3 * i];
        let vault_info = &remaining[3 * i + 1];
        let user_info = &remaining[3 * i + 2];
        require_keys_eq!(mint_info.key(), c.mint, BasketError::BadAccounts);
        require_keys_eq!(*mint_info.owner, c.token_program, BasketError::BadAccounts);
        require_keys_eq!(
            vault_info.key(),
            get_associated_token_address_with_program_id(&basket_key, &c.mint, &c.token_program),
            BasketError::BadVault
        );
        let mint = InterfaceAccount::<Mint>::try_from(mint_info)?;
        let vault = InterfaceAccount::<TokenAccount>::try_from(vault_info)?;
        let user_token = InterfaceAccount::<TokenAccount>::try_from(user_info)?;
        require_keys_eq!(user_token.mint, c.mint, BasketError::BadAccounts);
        require_keys_eq!(user_token.owner, *user, BasketError::BadAccounts);
        out.push(Leg {
            mint,
            vault,
            user_token,
            units: c.units_per_share,
            program: c.token_program,
        });
    }
    Ok(out)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Component {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// Atoms of this component in one whole share.
    pub units_per_share: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Basket {
    pub creator: Pubkey,
    pub id: u64,
    pub share_mint: Pubkey,
    #[max_len(MAX_LABEL)]
    pub label: String,
    #[max_len(MAX_COMPONENTS)]
    pub components: Vec<Component>,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateBasket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + Basket::INIT_SPACE, seeds = [BASKET_SEED, creator.key().as_ref(), &id.to_le_bytes()], bump)]
    pub basket: Box<Account<'info, Basket>>,
    #[account(init, payer = creator, mint::decimals = SHARE_DECIMALS, mint::authority = basket, mint::token_program = token_program, seeds = [SHARE_SEED, basket.key().as_ref()], bump)]
    pub share_mint: Box<Account<'info, token::Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintShares<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(has_one = share_mint @ BasketError::BadAccounts)]
    pub basket: Box<Account<'info, Basket>>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, token::Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = user)]
    pub user_shares: Box<Account<'info, token::TokenAccount>>,
    /// The share token's program (legacy SPL Token).
    pub token_program: Program<'info, Token>,
    /// Passed so that a Token-2022 component can be transferred; the transfers name it explicitly.
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct RedeemShares<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(has_one = share_mint @ BasketError::BadAccounts)]
    pub basket: Box<Account<'info, Basket>>,
    #[account(mut)]
    pub share_mint: Box<Account<'info, token::Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = user)]
    pub user_shares: Box<Account<'info, token::TokenAccount>>,
    /// The share token's program (legacy SPL Token).
    pub token_program: Program<'info, Token>,
    /// Passed so that a Token-2022 component can be transferred; the transfers name it explicitly.
    pub token_2022_program: Program<'info, Token2022>,
}

#[event]
pub struct BasketCreated {
    pub basket: Pubkey,
    pub creator: Pubkey,
    pub share_mint: Pubkey,
    pub components: Vec<Component>,
}
#[event]
pub struct SharesMinted {
    pub basket: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
}
#[event]
pub struct SharesRedeemed {
    pub basket: Pubkey,
    pub user: Pubkey,
    pub shares: u64,
}

#[error_code]
pub enum BasketError {
    #[msg("A basket has one to eight components, a label of at most 32 bytes and a positive amount of each")]
    BadBasket,
    #[msg("A component must be a token mint")]
    BadComponent,
    #[msg("A component is listed twice")]
    DuplicateComponent,
    #[msg("This token has an extension that could break the backing")]
    UnsafeExtension,
    #[msg("The vault is not the basket's account for that token")]
    BadVault,
    #[msg("The accounts do not match the basket's components")]
    BadAccounts,
    #[msg("Nothing to do")]
    NothingToDo,
    #[msg("A vault would hold less than the outstanding shares are owed")]
    Insolvent,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deposits_round_up_and_redemptions_round_down() {
        // 3 atoms per whole share; 1 share atom is 3e-6 of an atom.
        assert_eq!(owed(3, 1, true), Some(1));
        assert_eq!(owed(3, 1, false), Some(0));
        assert_eq!(owed(3, 1_000_000, true), Some(3));
        assert_eq!(owed(3, 1_000_000, false), Some(3));
        assert_eq!(owed(10, 333_333, true), Some(4));
        assert_eq!(owed(10, 333_333, false), Some(3));
        assert_eq!(owed(u64::MAX, u64::MAX, true), None);
    }

    #[test]
    fn a_round_trip_never_returns_more_than_was_paid() {
        for units in [1u64, 3, 7, 999_999, 1_000_000, 123_456_789] {
            for shares in [1u64, 2, 999_999, 1_000_001, 77_777_777] {
                let paid = owed(units, shares, true).unwrap();
                let back = owed(units, shares, false).unwrap();
                assert!(back <= paid);
                assert!(paid - back <= 1);
            }
        }
    }

    #[test]
    fn coverage_is_exact_at_the_boundary() {
        // 5 atoms per share, 2 shares outstanding: 10 atoms owed.
        assert!(covers(10, 5, 2_000_000));
        assert!(!covers(9, 5, 2_000_000));
        assert!(covers(0, 5, 0));
        assert!(covers(u64::MAX, u64::MAX, 1_000_000));
    }
}
