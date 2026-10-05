//! Reference integration for Opening Cross (ROADMAP A4, `external_cpi`).
//!
//! A third-party venue that lets its users join a cross without leaving the venue: it records
//! the user's order in its own books and forwards it to `cross_core::commit_order` in one CPI.
//! The user signs the outer transaction and that signature flows through the CPI, so the venue
//! never takes custody: escrow goes straight from the user's account to the cross vault, and
//! claims pay the user directly.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use opening_cross_cpi::cross_core;

declare_id!("7Kb2feBGE34ck7F7dovaEgKVJRLJ2JeUFxCyo4bamZJD");

#[program]
pub mod example_venue {
    use super::*;

    /// Forwards one order to a cross and counts it on the venue's own stats account.
    pub fn route_order(
        ctx: Context<RouteOrder>,
        args: cross_core::types::CommitOrderArgs,
    ) -> Result<()> {
        let escrow = args.escrow;
        cross_core::cpi::commit_order(
            CpiContext::new(
                ctx.accounts.cross_core_program.key(),
                cross_core::cpi::accounts::CommitOrder {
                    owner: ctx.accounts.user.to_account_info(),
                    protocol: ctx.accounts.protocol.to_account_info(),
                    cross: ctx.accounts.cross.to_account_info(),
                    order: ctx.accounts.order.to_account_info(),
                    shard: ctx.accounts.shard.as_ref().map(|s| s.to_account_info()),
                    pass: None,
                    escrow_mint: ctx.accounts.escrow_mint.to_account_info(),
                    escrow_vault: ctx.accounts.escrow_vault.to_account_info(),
                    owner_escrow: ctx.accounts.user_escrow.to_account_info(),
                    escrow_token_program: ctx.accounts.escrow_token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
            ),
            args,
        )?;
        let stats = &mut ctx.accounts.stats;
        stats.orders_routed = stats.orders_routed.saturating_add(1);
        stats.escrow_routed = stats.escrow_routed.saturating_add(escrow);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct VenueStats {
    pub orders_routed: u64,
    pub escrow_routed: u64,
}

#[derive(Accounts)]
pub struct RouteOrder<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(init_if_needed, payer = user, space = 8 + VenueStats::INIT_SPACE, seeds = [b"stats"], bump)]
    pub stats: Account<'info, VenueStats>,
    /// CHECK: validated by cross_core.
    pub protocol: UncheckedAccount<'info>,
    /// CHECK: validated by cross_core.
    #[account(mut)]
    pub cross: UncheckedAccount<'info>,
    /// CHECK: created by cross_core.
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    /// CHECK: validated by cross_core (open crosses only).
    #[account(mut)]
    pub shard: Option<UncheckedAccount<'info>>,
    /// CHECK: validated by cross_core.
    pub escrow_mint: UncheckedAccount<'info>,
    /// CHECK: validated by cross_core.
    #[account(mut)]
    pub escrow_vault: UncheckedAccount<'info>,
    /// CHECK: validated by cross_core and the token program.
    #[account(mut)]
    pub user_escrow: UncheckedAccount<'info>,
    /// CHECK: validated by cross_core.
    pub escrow_token_program: UncheckedAccount<'info>,
    /// CHECK: the core program.
    #[account(address = cross_core::ID)]
    pub cross_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
