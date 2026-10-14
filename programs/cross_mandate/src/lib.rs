//! Opening Cross auto-invest mandates (PRODUCT_FEATURES S4, J2; ADR-0650).
//!
//! A mandate lets an agent place buy orders in crosses for an owner without ever holding the owner's
//! key or being able to move the owner's funds anywhere but into a cross. The limits are enforced
//! here, on chain:
//!
//! - **The budget is the vault.** The owner funds a token account owned by a signer PDA of the
//!   mandate. The agent can only commit orders from it, so no order can exceed what the owner put in.
//! - **Orders belong to the signer PDA, not to the agent.** `cross_core` pays an order's refund and
//!   fill to the order's owner, which is that PDA. The quote side lands back in the vault. The base
//!   side is swept to the owner's own account by anyone, and the program has no instruction that sends
//!   it anywhere else.
//! - **Limits checked on every order:** not revoked, not expired, the cross is on the allow list (a
//!   base mint, a creator or one named cross), the escrow is at most `max_per_order`, the lifetime
//!   total committed stays at most `total_cap`, and the order cannot buy more than `max_share_bps`
//!   (at most 25%) of the cross's declared supply.
//! - **Kill switch.** `revoke` is the owner's, takes effect in the same slot and cannot be undone.
//!   `withdraw` and `withdraw_lamports` work at any time, also after expiry and revocation. The agent
//!   has no instruction that touches funds other than `place_order`.
//!
//! Buy orders only: a mandate never sells and never escrows a base asset.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("83EvNHUpKzguAUmyBHJgktVsVLzp3sCXYysgzmToLhs1");

// `cross_core`'s interface, from its IDL: typed CPI and the cross account, without linking its code.
declare_program!(cross_core);

pub const MANDATE_SEED: &[u8] = b"mandate";
pub const SIGNER_SEED: &[u8] = b"mandate_signer";
/// The most of one cross's declared supply a single order may buy: 25% (the specification's cap).
pub const MAX_SHARE_BPS: u16 = 2_500;
pub const MAX_ALLOW: usize = 8;
const BPS: u128 = 10_000;

// Where `cross_core` keeps the figures this program reads. A cross account is the 8-byte discriminator, the `Cross`
// struct, then the extension tail (ADR-0450): a version byte, `rules_set`, `created_slot` (8), `flags` (2), then the
// guard rules, which start with `min_raise_quote`, `max_matched` and `total_supply` (8 bytes each). The host tests pin
// these offsets against the real types, so a change to the tail breaks the build of this program's tests, not a mandate.
/// Size of a cross account's body: discriminator plus the `Cross` struct.
pub const CROSS_BODY: usize = 668;
const TAIL_VERSION: u8 = 1;
const TAIL_MAX_MATCHED: usize = 20;
const TAIL_TOTAL_SUPPLY: usize = 28;
/// The largest an order account can be (its body and its extension tail), for the rent check.
const ORDER_SPACE_MAX: usize = 8 + 135 + 40;

#[program]
pub mod cross_mandate {
    use super::*;

    /// Creates a mandate and its vault. The owner signs and pays; the agent is only named.
    pub fn create_mandate(ctx: Context<CreateMandate>, id: u64, limits: Limits) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        limits.validate(now)?;
        require_keys_neq!(
            ctx.accounts.agent.key(),
            ctx.accounts.owner.key(),
            MandateError::AgentIsOwner
        );
        require_keys_neq!(
            ctx.accounts.agent.key(),
            Pubkey::default(),
            MandateError::AgentIsOwner
        );
        let m = &mut ctx.accounts.mandate;
        m.owner = ctx.accounts.owner.key();
        m.agent = ctx.accounts.agent.key();
        m.id = id;
        m.quote_mint = ctx.accounts.quote_mint.key();
        m.quote_token_program = ctx.accounts.token_program.key();
        m.committed = 0;
        m.revoked = false;
        m.bump = ctx.bumps.mandate;
        m.signer_bump = ctx.bumps.signer;
        limits.apply(m);
        emit!(MandateCreated {
            mandate: m.key(),
            owner: m.owner,
            agent: m.agent,
            quote_mint: m.quote_mint,
            limits,
        });
        Ok(())
    }

    /// Moves quote tokens from the owner into the vault, and optionally SOL into the signer PDA
    /// (it pays the rent of each order it places and gets it back when the order is claimed).
    pub fn fund(ctx: Context<Fund>, amount: u64, lamports: u64) -> Result<()> {
        require!(amount > 0 || lamports > 0, MandateError::NothingToDo);
        if amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.owner_quote.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                amount,
                ctx.accounts.quote_mint.decimals,
            )?;
        }
        if lamports > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.owner.to_account_info(),
                        to: ctx.accounts.signer.to_account_info(),
                    },
                ),
                lamports,
            )?;
        }
        emit!(MandateFunded {
            mandate: ctx.accounts.mandate.key(),
            amount,
            lamports
        });
        Ok(())
    }

    /// Replaces the limits. The owner may raise or lower any of them; a revoked mandate stays revoked.
    pub fn set_limits(ctx: Context<OwnerOnly>, limits: Limits) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.mandate;
        require!(!m.revoked, MandateError::Revoked);
        limits.validate(now)?;
        limits.apply(m);
        emit!(LimitsChanged {
            mandate: m.key(),
            limits
        });
        Ok(())
    }

    /// The kill switch. Immediate and permanent: no new order can be placed. Orders already in a cross
    /// can still be cancelled while the call window is open, claimed after it, and withdrawn.
    pub fn revoke(ctx: Context<OwnerOnly>) -> Result<()> {
        let m = &mut ctx.accounts.mandate;
        require!(!m.revoked, MandateError::Revoked);
        m.revoked = true;
        emit!(MandateRevoked { mandate: m.key() });
        Ok(())
    }

    /// Takes quote tokens out of the vault to the owner's own account. Always allowed.
    pub fn withdraw<'info>(ctx: Context<'info, Withdraw<'info>>, amount: u64) -> Result<()> {
        require!(amount > 0, MandateError::NothingToDo);
        let mandate = ctx.accounts.mandate.key();
        let seeds: &[&[u8]] = &[
            SIGNER_SEED,
            mandate.as_ref(),
            &[ctx.accounts.mandate.signer_bump],
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.owner_quote.to_account_info(),
                    authority: ctx.accounts.signer.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;
        emit!(MandateWithdrawn { mandate, amount });
        Ok(())
    }

    /// Takes SOL out of the signer PDA to the owner. The signer must keep the rent-exempt minimum of an
    /// empty account or be emptied completely.
    pub fn withdraw_lamports(ctx: Context<WithdrawLamports>, lamports: u64) -> Result<()> {
        require!(lamports > 0, MandateError::NothingToDo);
        let mandate = ctx.accounts.mandate.key();
        let seeds: &[&[u8]] = &[
            SIGNER_SEED,
            mandate.as_ref(),
            &[ctx.accounts.mandate.signer_bump],
        ];
        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.signer.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
        )?;
        emit!(MandateLamportsWithdrawn { mandate, lamports });
        Ok(())
    }

    /// Moves everything the signer PDA holds of a base token to the owner's own account. Permissionless: the
    /// destination is fixed to the owner, so a caller can only help. The quote token never goes through
    /// here: it stays in the vault until the owner withdraws it.
    pub fn sweep<'info>(ctx: Context<'info, Sweep<'info>>) -> Result<()> {
        let amount = ctx.accounts.source.amount;
        require!(amount > 0, MandateError::NothingToDo);
        let mandate = ctx.accounts.mandate.key();
        let seeds: &[&[u8]] = &[
            SIGNER_SEED,
            mandate.as_ref(),
            &[ctx.accounts.mandate.signer_bump],
        ];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.source.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.signer.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(MandateSwept {
            mandate,
            mint: ctx.accounts.mint.key(),
            amount
        });
        Ok(())
    }

    /// The agent places a buy order in a cross, inside the limits. Remaining accounts are those the
    /// cross's rules ask `commit_order` for (applicant record, class book, priority pass).
    pub fn place_order<'info>(
        ctx: Context<'info, PlaceOrder<'info>>,
        nonce: u64,
        escrow: u64,
        commitment: [u8; 32],
        price: u64,
        quantity: u64,
        order_bump: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mandate_key = ctx.accounts.mandate.key();
        let m = &ctx.accounts.mandate;
        require!(!m.revoked, MandateError::Revoked);
        require!(now < m.expires_at, MandateError::Expired);
        require!(escrow > 0, MandateError::NothingToDo);
        require!(escrow <= m.max_per_order, MandateError::OverPerOrderLimit);
        let committed = m
            .committed
            .checked_add(escrow)
            .ok_or(MandateError::Overflow)?;
        require!(committed <= m.total_cap, MandateError::OverTotalCap);
        require!(
            ctx.accounts.vault.amount >= escrow,
            MandateError::VaultTooLow
        );

        // The cross: read with the program's own type so a lookalike account is refused.
        let cross_info = ctx.accounts.cross.to_account_info();
        require_keys_eq!(*cross_info.owner, cross_core::ID, MandateError::NotACross);
        let cross_data = cross_info.try_borrow_data()?;
        let cross = cross_core::accounts::Cross::try_deserialize(&mut &cross_data[..])
            .map_err(|_| error!(MandateError::NotACross))?;
        require_keys_eq!(cross.quote_mint, m.quote_mint, MandateError::WrongQuote);
        require_keys_eq!(
            cross.quote_token_program,
            m.quote_token_program,
            MandateError::WrongQuote
        );
        require!(
            allowed(&m.allow, &cross, &cross_info.key()),
            MandateError::NotAllowed
        );

        // At most `max_share_bps` of the declared supply, whatever the order turns out to buy.
        let reference = supply_reference(&cross_data);
        drop(cross_data);
        require!(reference > 0, MandateError::NoSupplyReference);
        let base_bound = if matches!(cross.disclosure, cross_core::types::Disclosure::Open) {
            u128::from(quantity)
        } else {
            max_base_for_escrow(escrow, cross.price_scale, cross.min_price)
                .ok_or(MandateError::Overflow)?
        };
        require!(
            share_ok(base_bound, u128::from(reference), m.max_share_bps),
            MandateError::OverShareLimit
        );

        // The signer PDA pays the order's rent and must stay rent-exempt as an empty account.
        let rent = Rent::get()?;
        let order_rent = rent.minimum_balance(ORDER_SPACE_MAX);
        require!(
            ctx.accounts.signer.lamports()
                >= order_rent
                    .checked_add(rent.minimum_balance(0))
                    .ok_or(MandateError::Overflow)?,
            MandateError::NeedRentFunding
        );

        let seeds: &[&[u8]] = &[SIGNER_SEED, mandate_key.as_ref(), &[m.signer_bump]];
        cross_core::cpi::commit_order(
            CpiContext::new_with_signer(
                ctx.accounts.cross_core_program.key(),
                cross_core::cpi::accounts::CommitOrder {
                    owner: ctx.accounts.signer.to_account_info(),
                    protocol: ctx.accounts.protocol.to_account_info(),
                    cross: cross_info.clone(),
                    order: ctx.accounts.order.to_account_info(),
                    shard: ctx.accounts.shard.as_ref().map(|s| s.to_account_info()),
                    pass: ctx.accounts.pass.as_ref().map(|s| s.to_account_info()),
                    escrow_mint: ctx.accounts.quote_mint.to_account_info(),
                    escrow_vault: ctx.accounts.escrow_vault.to_account_info(),
                    owner_escrow: ctx.accounts.vault.to_account_info(),
                    escrow_token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            cross_core::types::CommitOrderArgs {
                nonce,
                side: cross_core::types::OrderSide::Buy,
                escrow,
                commitment,
                price,
                quantity,
                order_bump,
            },
        )?;

        let m = &mut ctx.accounts.mandate;
        m.committed = committed;
        emit!(MandateOrderPlaced {
            mandate: mandate_key,
            cross: cross_info.key(),
            order: ctx.accounts.order.key(),
            escrow,
            committed,
        });
        Ok(())
    }

    /// Reveals a sealed order the mandate placed. The owner or the agent may call it, also after the
    /// mandate was revoked or expired: it only completes an order that was authorised when it was placed.
    pub fn reveal_order<'info>(
        ctx: Context<'info, RevealOrder<'info>>,
        price: u64,
        quantity: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        let mandate_key = ctx.accounts.mandate.key();
        let seeds: &[&[u8]] = &[
            SIGNER_SEED,
            mandate_key.as_ref(),
            &[ctx.accounts.mandate.signer_bump],
        ];
        cross_core::cpi::reveal_order(
            CpiContext::new_with_signer(
                ctx.accounts.cross_core_program.key(),
                cross_core::cpi::accounts::RevealOrder {
                    owner: ctx.accounts.signer.to_account_info(),
                    cross: ctx.accounts.cross.to_account_info(),
                    order: ctx.accounts.order.to_account_info(),
                    shard: ctx.accounts.shard.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            price,
            quantity,
            salt,
        )
    }

    /// Withdraws an order from a cross during its call window. The owner or the agent may call it,
    /// also after revocation. The refund lands in the vault and the order's rent in the signer PDA.
    pub fn cancel_order<'info>(ctx: Context<'info, CancelOrder<'info>>) -> Result<()> {
        let mandate_key = ctx.accounts.mandate.key();
        let seeds: &[&[u8]] = &[
            SIGNER_SEED,
            mandate_key.as_ref(),
            &[ctx.accounts.mandate.signer_bump],
        ];
        cross_core::cpi::cancel_order(
            CpiContext::new_with_signer(
                ctx.accounts.cross_core_program.key(),
                cross_core::cpi::accounts::CancelOrder {
                    owner: ctx.accounts.signer.to_account_info(),
                    cross: ctx.accounts.cross.to_account_info(),
                    order: ctx.accounts.order.to_account_info(),
                    shard: ctx.accounts.shard.as_ref().map(|s| s.to_account_info()),
                    base_mint: ctx.accounts.base_mint.to_account_info(),
                    quote_mint: ctx.accounts.quote_mint.to_account_info(),
                    quote_vault: ctx.accounts.quote_vault.to_account_info(),
                    base_vault: ctx.accounts.base_vault.to_account_info(),
                    owner_quote: Some(ctx.accounts.vault.to_account_info()),
                    owner_base: None,
                    base_token_program: ctx.accounts.base_token_program.to_account_info(),
                    quote_token_program: ctx.accounts.token_program.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        )
    }
}

/// The supply a mandate's share limit is measured against: the cross's hard cap on delivered base when it has one, else
/// its declared total supply; zero when the cross declares neither (or has no rules tail).
pub fn supply_reference(cross_data: &[u8]) -> u64 {
    let Some(tail) = cross_data.get(CROSS_BODY..) else {
        return 0;
    };
    if tail.first().copied() != Some(TAIL_VERSION) || tail.get(1).copied() != Some(1) {
        return 0;
    }
    let read = |at: usize| {
        tail.get(at..at + 8)
            .and_then(|b| <[u8; 8]>::try_from(b).ok())
            .map_or(0, u64::from_le_bytes)
    };
    match read(TAIL_MAX_MATCHED) {
        0 => read(TAIL_TOTAL_SUPPLY),
        cap => cap,
    }
}

/// `true` when the order's base quantity stays within `max_share_bps` of the reference supply.
pub fn share_ok(base_quantity: u128, reference: u128, max_share_bps: u16) -> bool {
    match (
        base_quantity.checked_mul(BPS),
        reference.checked_mul(u128::from(max_share_bps)),
    ) {
        (Some(lhs), Some(rhs)) => lhs <= rhs,
        _ => false,
    }
}

/// The most base atoms an escrow can pay for: `floor(escrow * price_scale / min_price)`. Every price on a
/// cross's grid is at least `min_price`, and `commit_order` refuses an order whose cost at its price
/// exceeds the escrow, so no order can buy more than this.
pub fn max_base_for_escrow(escrow: u64, price_scale: u64, min_price: u64) -> Option<u128> {
    if min_price == 0 {
        return None;
    }
    u128::from(escrow)
        .checked_mul(u128::from(price_scale))
        .map(|n| n / u128::from(min_price))
}

fn allowed(allow: &[AllowRule], cross: &cross_core::accounts::Cross, cross_key: &Pubkey) -> bool {
    allow.iter().any(|r| match r.kind {
        AllowKind::BaseMint => cross.base_bound && cross.base_mint == r.key,
        AllowKind::Creator => cross.creator == r.key,
        AllowKind::Cross => *cross_key == r.key,
    })
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum AllowKind {
    /// Crosses selling this base mint (the mint must already be bound to the cross).
    BaseMint,
    /// Every cross made by this creator, including launches whose mint does not exist yet.
    Creator,
    /// This one cross.
    Cross,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct AllowRule {
    pub kind: AllowKind,
    pub key: Pubkey,
}

/// What the owner decides. All of it can be changed by the owner, none of it by the agent.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    /// Most quote atoms one order may escrow.
    pub max_per_order: u64,
    /// Most quote atoms the mandate may commit over its life (refunded escrow still counts, so the
    /// figure is a ceiling on activity, not a balance).
    pub total_cap: u64,
    /// Most of a cross's declared supply one order may buy, in basis points, at most 2,500.
    pub max_share_bps: u16,
    pub expires_at: i64,
    pub allow: Vec<AllowRule>,
}

impl Limits {
    fn validate(&self, now: i64) -> Result<()> {
        require!(
            self.max_per_order > 0 && self.total_cap >= self.max_per_order,
            MandateError::BadLimits
        );
        require!(
            self.max_share_bps > 0 && self.max_share_bps <= MAX_SHARE_BPS,
            MandateError::BadLimits
        );
        require!(self.expires_at > now, MandateError::BadLimits);
        require!(
            !self.allow.is_empty() && self.allow.len() <= MAX_ALLOW,
            MandateError::BadLimits
        );
        Ok(())
    }

    fn apply(&self, m: &mut Mandate) {
        m.max_per_order = self.max_per_order;
        m.total_cap = self.total_cap;
        m.max_share_bps = self.max_share_bps;
        m.expires_at = self.expires_at;
        m.allow = self.allow.clone();
    }
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub id: u64,
    pub quote_mint: Pubkey,
    pub quote_token_program: Pubkey,
    pub max_per_order: u64,
    pub total_cap: u64,
    /// Quote atoms committed to orders so far.
    pub committed: u64,
    pub max_share_bps: u16,
    pub expires_at: i64,
    pub revoked: bool,
    #[max_len(MAX_ALLOW)]
    pub allow: Vec<AllowRule>,
    pub bump: u8,
    pub signer_bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: only named; the agent signs `place_order` later.
    pub agent: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = owner, space = 8 + Mandate::INIT_SPACE, seeds = [MANDATE_SEED, owner.key().as_ref(), &id.to_le_bytes()], bump)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(seeds = [SIGNER_SEED, mandate.key().as_ref()], bump)]
    pub signer: SystemAccount<'info>,
    #[account(init, payer = owner, associated_token::mint = quote_mint, associated_token::authority = signer, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ MandateError::Unauthorized)]
    pub mandate: Box<Account<'info, Mandate>>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner @ MandateError::Unauthorized, has_one = quote_mint @ MandateError::WrongQuote)]
    pub mandate: Box<Account<'info, Mandate>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = quote_mint, token::authority = owner, token::token_program = token_program)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = signer, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [SIGNER_SEED, mandate.key().as_ref()], bump = mandate.signer_bump)]
    pub signer: SystemAccount<'info>,
    #[account(address = mandate.quote_token_program @ MandateError::WrongQuote)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner @ MandateError::Unauthorized, has_one = quote_mint @ MandateError::WrongQuote)]
    pub mandate: Box<Account<'info, Mandate>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = signer, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = owner, token::token_program = token_program)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [SIGNER_SEED, mandate.key().as_ref()], bump = mandate.signer_bump)]
    pub signer: SystemAccount<'info>,
    #[account(address = mandate.quote_token_program @ MandateError::WrongQuote)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawLamports<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner @ MandateError::Unauthorized)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, seeds = [SIGNER_SEED, mandate.key().as_ref()], bump = mandate.signer_bump)]
    pub signer: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(seeds = [SIGNER_SEED, mandate.key().as_ref()], bump = mandate.signer_bump)]
    pub signer: SystemAccount<'info>,
    #[account(constraint = mint.key() != mandate.quote_mint @ MandateError::QuoteStaysInVault)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = signer, token::token_program = token_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = mandate.owner, token::token_program = token_program)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub agent: Signer<'info>,
    #[account(mut, has_one = agent @ MandateError::Unauthorized, has_one = quote_mint @ MandateError::WrongQuote)]
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, seeds = [SIGNER_SEED, mandate.key().as_ref()], bump = mandate.signer_bump)]
    pub signer: SystemAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = signer, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: `cross_core`'s protocol account; the callee derives and checks it.
    pub protocol: UncheckedAccount<'info>,
    /// CHECK: read and checked in the handler (owner, type); `cross_core` checks it again.
    #[account(mut)]
    pub cross: UncheckedAccount<'info>,
    /// CHECK: created by `cross_core` at the order PDA of the signer PDA.
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    /// CHECK: the order's book shard, for open crosses; checked by `cross_core`.
    #[account(mut)]
    pub shard: Option<UncheckedAccount<'info>>,
    /// CHECK: the signer PDA's gate pass, for gated crosses; checked by `cross_core`.
    pub pass: Option<UncheckedAccount<'info>>,
    /// CHECK: the cross's quote vault; checked by `cross_core`.
    #[account(mut)]
    pub escrow_vault: UncheckedAccount<'info>,
    #[account(address = mandate.quote_token_program @ MandateError::WrongQuote)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = cross_core::ID)]
    pub cross_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealOrder<'info> {
    #[account(constraint = caller.key() == mandate.owner || caller.key() == mandate.agent @ MandateError::Unauthorized)]
    pub caller: Signer<'info>,
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(seeds = [SIGNER_SEED, mandate.key().as_ref()], bump = mandate.signer_bump)]
    pub signer: SystemAccount<'info>,
    /// CHECK: checked by `cross_core`, which also binds the order to this cross and this owner.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: as above.
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    /// CHECK: as above.
    #[account(mut)]
    pub shard: UncheckedAccount<'info>,
    #[account(address = cross_core::ID)]
    pub cross_core_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(constraint = caller.key() == mandate.owner || caller.key() == mandate.agent @ MandateError::Unauthorized)]
    pub caller: Signer<'info>,
    pub mandate: Box<Account<'info, Mandate>>,
    #[account(mut, seeds = [SIGNER_SEED, mandate.key().as_ref()], bump = mandate.signer_bump)]
    pub signer: SystemAccount<'info>,
    /// CHECK: checked by `cross_core`.
    #[account(mut)]
    pub cross: UncheckedAccount<'info>,
    /// CHECK: checked by `cross_core` (owner is the signer PDA, cross matches).
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    /// CHECK: checked by `cross_core`.
    #[account(mut)]
    pub shard: Option<UncheckedAccount<'info>>,
    /// CHECK: checked by `cross_core` against the cross.
    pub base_mint: UncheckedAccount<'info>,
    #[account(address = mandate.quote_mint @ MandateError::WrongQuote)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the cross's quote vault; checked by `cross_core`.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the cross's base vault; checked by `cross_core`.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = quote_mint, associated_token::authority = signer, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: checked by `cross_core` against the cross.
    pub base_token_program: UncheckedAccount<'info>,
    #[account(address = mandate.quote_token_program @ MandateError::WrongQuote)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = cross_core::ID)]
    pub cross_core_program: UncheckedAccount<'info>,
}

#[event]
pub struct MandateCreated {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub quote_mint: Pubkey,
    pub limits: Limits,
}
#[event]
pub struct MandateFunded {
    pub mandate: Pubkey,
    pub amount: u64,
    pub lamports: u64,
}
#[event]
pub struct LimitsChanged {
    pub mandate: Pubkey,
    pub limits: Limits,
}
#[event]
pub struct MandateRevoked {
    pub mandate: Pubkey,
}
#[event]
pub struct MandateWithdrawn {
    pub mandate: Pubkey,
    pub amount: u64,
}
#[event]
pub struct MandateLamportsWithdrawn {
    pub mandate: Pubkey,
    pub lamports: u64,
}
#[event]
pub struct MandateSwept {
    pub mandate: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}
#[event]
pub struct MandateOrderPlaced {
    pub mandate: Pubkey,
    pub cross: Pubkey,
    pub order: Pubkey,
    pub escrow: u64,
    pub committed: u64,
}

#[error_code]
pub enum MandateError {
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("The agent must be a different key from the owner")]
    AgentIsOwner,
    #[msg("Limits are not valid")]
    BadLimits,
    #[msg("The mandate was revoked")]
    Revoked,
    #[msg("The mandate has expired")]
    Expired,
    #[msg("Order is larger than the per-order limit")]
    OverPerOrderLimit,
    #[msg("Order would take the mandate over its lifetime cap")]
    OverTotalCap,
    #[msg("The vault holds less than the order's escrow")]
    VaultTooLow,
    #[msg("The account is not a cross")]
    NotACross,
    #[msg("The cross is not quoted in the mandate's token")]
    WrongQuote,
    #[msg("The cross is not on the mandate's allow list")]
    NotAllowed,
    #[msg("The cross declares no supply to measure the share against")]
    NoSupplyReference,
    #[msg("Order could buy more than the share limit of the cross's supply")]
    OverShareLimit,
    #[msg("Fund the signer account with SOL for the order's rent")]
    NeedRentFunding,
    #[msg("Nothing to do")]
    NothingToDo,
    #[msg("The quote token stays in the vault; the owner withdraws it")]
    QuoteStaysInVault,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AnchorSerialize, Space};

    fn tail_bytes(ext: &::cross_core::ext::CrossExt) -> Vec<u8> {
        let mut out = Vec::new();
        ext.serialize(&mut out).unwrap();
        out
    }

    /// The offsets this program reads must be where the real `cross_core` puts them.
    #[test]
    fn tail_offsets_match_cross_core() {
        assert_eq!(CROSS_BODY, ::cross_core::ext::CROSS_BODY);
        assert!(
            std::hint::black_box(ORDER_SPACE_MAX)
                >= ::cross_core::ext::ORDER_BODY + ::cross_core::ext::ORDER_EXT_SPACE
        );
        assert_eq!(TAIL_VERSION, ::cross_core::ext::EXT_VERSION);

        let mut ext = ::cross_core::ext::CrossExt {
            version: ::cross_core::ext::EXT_VERSION,
            rules_set: true,
            ..Default::default()
        };
        ext.guards.max_matched = 0x1122_3344_5566_7788;
        ext.guards.total_supply = 0x0102_0304_0506_0708;
        let mut data = vec![0u8; CROSS_BODY];
        data.extend(tail_bytes(&ext));
        assert_eq!(supply_reference(&data), 0x1122_3344_5566_7788);
        ext.guards.max_matched = 0;
        let mut data = vec![0u8; CROSS_BODY];
        data.extend(tail_bytes(&ext));
        assert_eq!(supply_reference(&data), 0x0102_0304_0506_0708);
        // Rules never set, a different version, a legacy cross with no tail, and a truncated tail all read as none.
        ext.rules_set = false;
        let mut data = vec![0u8; CROSS_BODY];
        data.extend(tail_bytes(&ext));
        assert_eq!(supply_reference(&data), 0);
        ext.rules_set = true;
        ext.version = 2;
        let mut data = vec![0u8; CROSS_BODY];
        data.extend(tail_bytes(&ext));
        assert_eq!(supply_reference(&data), 0);
        assert_eq!(supply_reference(&vec![0u8; CROSS_BODY]), 0);
        assert_eq!(supply_reference(&vec![1u8; CROSS_BODY + 20]), 0);
        let _ = ::cross_core::state::Cross::INIT_SPACE;
    }

    #[test]
    fn share_is_exact_at_the_boundary() {
        // 25% of 1,000,000 is 250,000.
        assert!(share_ok(250_000, 1_000_000, 2_500));
        assert!(!share_ok(250_001, 1_000_000, 2_500));
        assert!(share_ok(0, 1, 1));
        assert!(!share_ok(1, 10_000, 0));
    }

    #[test]
    fn share_never_overflows_into_a_pass() {
        assert!(!share_ok(u128::MAX, 1, 2_500));
        // A reference near the top of the range cannot wrap the right-hand side into a small number.
        assert!(!share_ok(u128::MAX / 2, u128::MAX, 2_500));
    }

    #[test]
    fn escrow_bound_is_an_upper_bound_on_any_filled_order() {
        // price_scale 1e6, min price 500_000 quote per 1e6 base: 1,000 quote buys at most 2,000 base.
        assert_eq!(max_base_for_escrow(1_000, 1_000_000, 500_000), Some(2_000));
        // A higher price buys less: cost of 2,000 base at 600_000 is 1,200 > 1,000.
        assert_eq!(max_base_for_escrow(1_000, 1_000_000, 0), None);
        for p in [500_000u64, 510_000, 777_777, 2_000_000] {
            let bound = max_base_for_escrow(1_000, 1_000_000, 500_000).unwrap();
            // The most a buyer can take at price p is floor(escrow * scale / p), never above the bound.
            let at_p = u128::from(1_000u64) * 1_000_000 / u128::from(p);
            assert!(at_p <= bound);
        }
    }

    #[test]
    fn limits_reject_every_bad_shape() {
        let ok = Limits {
            max_per_order: 10,
            total_cap: 10,
            max_share_bps: 2_500,
            expires_at: 100,
            allow: vec![AllowRule {
                kind: AllowKind::Creator,
                key: Pubkey::new_unique(),
            }],
        };
        assert!(ok.validate(0).is_ok());
        let mut b = ok.clone();
        b.max_share_bps = 2_501;
        assert!(b.validate(0).is_err());
        let mut b = ok.clone();
        b.max_share_bps = 0;
        assert!(b.validate(0).is_err());
        let mut b = ok.clone();
        b.total_cap = 9;
        assert!(b.validate(0).is_err());
        let mut b = ok.clone();
        b.max_per_order = 0;
        assert!(b.validate(0).is_err());
        let mut b = ok.clone();
        b.allow.clear();
        assert!(b.validate(0).is_err());
        let mut b = ok.clone();
        b.allow = vec![b.allow[0]; MAX_ALLOW + 1];
        assert!(b.validate(0).is_err());
        assert!(ok.validate(100).is_err());
    }
}
