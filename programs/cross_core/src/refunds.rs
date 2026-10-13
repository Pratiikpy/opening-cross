//! Pushed refunds (PRODUCT_FEATURES B5, ADR-0457): "refunds need no claim".
//!
//! `claim` already lets anyone settle an order for its owner, one transaction per order. After a cross that did not
//! print, or for the orders of a printed cross that were not filled (never revealed, left out by the draw, priced
//! out), `push_refunds` returns many of them in one transaction: it pays each order's escrow back to its owner's own
//! token account and closes the order. It settles refunds only. An order that has a fill is refused, because a fill
//! needs the mint, the lock vault or the fee accounts that `claim` handles, and a refund must never be able to
//! settle part of a fill by accident.
//!
//! Funds can only go to the order owner's own token account for the escrowed mint: the program checks the account's
//! owner and mint, so the caller (a keeper) chooses nothing but which orders to push.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    ext::{self, OrderExt},
    orders::outcome,
    state::*,
    CrossError, OrderClaimed,
};

/// Orders one call can refund. Each takes three accounts and a token transfer.
pub const MAX_PUSH: usize = 12;

#[derive(Accounts)]
pub struct PushRefunds<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(address = cross.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, cross.key().as_ref()], bump = cross.quote_vault_bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Omitted only for a deferred-mint cross whose mint was never bound (no sells exist then).
    #[account(address = cross.base_mint)]
    pub base_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut, seeds = [BASE_VAULT_SEED, cross.key().as_ref()], bump = cross.base_vault_bump)]
    pub base_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(address = cross.quote_token_program)]
    pub quote_token_program: Interface<'info, TokenInterface>,
    #[account(address = cross.base_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
}

/// Refunds the orders given as remaining accounts, in groups of three: the order, its owner (which receives the
/// order's rent) and the owner's token account for the escrowed mint.
pub fn push_refunds<'info>(ctx: Context<'info, PushRefunds<'info>>) -> Result<()> {
    let accounts = ctx.remaining_accounts;
    // `is_multiple_of` is not in the SBF toolchain's Rust yet.
    #[allow(clippy::manual_is_multiple_of)]
    let grouped = accounts.len() % 3 == 0;
    require!(
        !accounts.is_empty() && grouped && accounts.len() / 3 <= MAX_PUSH,
        CrossError::InvalidParams
    );
    let c = &mut ctx.accounts.cross;
    require!(
        c.state == CrossState::Cleared || c.state == CrossState::NoPrint,
        CrossError::WrongState
    );
    require!(
        c.state != CrossState::Cleared || c.base_bound,
        CrossError::SettlementPending
    );
    let cross_info = c.to_account_info();
    let cross_key = c.key();
    let (creator, id, bump) = (c.creator, c.cross_id.to_le_bytes(), [c.bump]);
    let seeds: &[&[u8]] = &[CROSS_SEED, creator.as_ref(), &id, &bump];
    let x = ext::read(&cross_info)?;

    for group in accounts.chunks_exact(3) {
        let (order_info, owner_info, dest_info) = (&group[0], &group[1], &group[2]);
        let order = Account::<Order>::try_from(order_info)?;
        require_keys_eq!(order.cross, cross_key, CrossError::WrongCross);
        require_keys_eq!(order.owner, owner_info.key(), CrossError::Unauthorized);
        let ox = if x.order_tail() {
            ext::read_order(order_info)?
        } else {
            OrderExt::default()
        };
        let out = outcome(c, &x, &order, &ox)?;
        require!(out.fill == 0, CrossError::NotRefundOnly);
        let dest = InterfaceAccount::<TokenAccount>::try_from(dest_info)?;
        require_keys_eq!(dest.owner, order.owner, CrossError::Unauthorized);
        match order.side {
            OrderSide::Buy => {
                require_keys_eq!(dest.mint, c.quote_mint, CrossError::WrongMint);
                crate::transfer_signed(
                    &ctx.accounts.quote_vault,
                    &dest,
                    &ctx.accounts.quote_mint,
                    &ctx.accounts.quote_token_program,
                    &cross_info,
                    seeds,
                    out.quote_out,
                )?;
            }
            OrderSide::Sell => {
                require_keys_eq!(dest.mint, c.base_mint, CrossError::WrongMint);
                let vault = ctx
                    .accounts
                    .base_vault
                    .as_ref()
                    .ok_or(CrossError::TokenAccountMissing)?;
                let mint = ctx
                    .accounts
                    .base_mint
                    .as_ref()
                    .ok_or(CrossError::TokenAccountMissing)?;
                crate::transfer_signed(
                    vault,
                    &dest,
                    mint,
                    &ctx.accounts.base_token_program,
                    &cross_info,
                    seeds,
                    out.base_out,
                )?;
            }
        }
        c.orders_open = c.orders_open.checked_sub(1).ok_or(CrossError::Overflow)?;
        emit!(OrderClaimed {
            cross: cross_key,
            order: order.key(),
            owner: order.owner,
            side: order.side,
            fill: 0,
            quote_out: out.quote_out,
            base_out: out.base_out,
            fee: 0
        });
        order.close(owner_info.clone())?;
    }
    Ok(())
}
