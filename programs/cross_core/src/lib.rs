//! Opening Cross core program. Design: `docs/adr/0005-cross-core.md`; clearing rule:
//! `docs/adr/0003-clearing-rule.md`.
//!
//! A cross collects limit orders during a call window, optionally sealed by commit-reveal,
//! aggregates them per price tick across write shards, clears at one uniform price with
//! `clearing-core`, and lets anyone crank per-order claims that pay fills and refund the rest.
//! Every order can always be refunded: pauses, no-print outcomes and unrevealed orders all end
//! in a full refund.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        self, Mint, MintTo, SetAuthority, TokenAccount, TokenInterface, TransferChecked,
    },
};

pub mod oracle;
pub mod state;
use state::*;

declare_id!("F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateCrossParams {
    pub cross_id: u64,
    pub kind: CrossKind,
    pub supply_mode: SupplyMode,
    pub disclosure: Disclosure,
    pub min_price: u64,
    pub tick: u64,
    pub ticks: u16,
    pub price_scale: u64,
    pub open_ts: i64,
    pub close_ts: i64,
    /// Ignored (set to `close_ts`) for open disclosure.
    pub reveal_end_ts: i64,
    pub reference_price: Option<u64>,
    pub min_matched: u64,
    pub max_imbalance_bps: Option<u32>,
    pub integrator_fee_bps: u16,
    pub integrator: Pubkey,
    pub gate_mint: Option<Pubkey>,
    pub oracle: Option<OracleGuard>,
    /// Schedule the cross on this calendar: its close must be a session start, and its oracle
    /// feed (if any) must be approved by the calendar.
    pub calendar: Option<Pubkey>,
    pub shards: u8,
    pub max_orders: u32,
    pub proceeds_to: Pubkey,
    /// Mint modes only: the issuer's elastic supply schedule as sell levels.
    pub schedule: Vec<SupplyLevel>,
    /// Deferred-mint mode only: the adapter authority allowed to bind the base mint.
    pub settler: Option<Pubkey>,
    /// Deferred-mint mode only: after this time an unbound cross can be abandoned and refunded.
    pub settle_deadline_ts: i64,
}

/// Arguments for `commit_order`. Sealed crosses send the commitment and leave `price` and
/// `quantity` zero; open crosses send the plaintext order and a zero commitment.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CommitOrderArgs {
    pub nonce: u64,
    pub side: OrderSide,
    pub escrow: u64,
    pub commitment: [u8; 32],
    pub price: u64,
    pub quantity: u64,
    /// Bump of the order PDA, computed by the client.
    pub order_bump: u8,
}

/// One step of an issuer's pre-committed supply schedule.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SupplyLevel {
    pub price: u64,
    pub quantity: u64,
}

#[program]
pub mod cross_core {
    use super::*;

    pub fn init_protocol(
        ctx: Context<InitProtocol>,
        guardian: Pubkey,
        fee_recipient: Pubkey,
        fee_bps: [u16; 4],
    ) -> Result<()> {
        require!(
            fee_bps.iter().all(|f| *f <= MAX_PROTOCOL_FEE_BPS),
            CrossError::FeeTooHigh
        );
        let p = &mut ctx.accounts.protocol;
        p.admin = ctx.accounts.admin.key();
        p.guardian = guardian;
        p.fee_recipient = fee_recipient;
        p.fee_bps = fee_bps;
        p.paused = false;
        p.bump = ctx.bumps.protocol;
        Ok(())
    }

    /// Fee changes apply to crosses created afterwards; existing crosses keep their snapshot.
    pub fn set_protocol_fees(
        ctx: Context<AdminOnly>,
        fee_recipient: Pubkey,
        fee_bps: [u16; 4],
    ) -> Result<()> {
        require!(
            fee_bps.iter().all(|f| *f <= MAX_PROTOCOL_FEE_BPS),
            CrossError::FeeTooHigh
        );
        ctx.accounts.protocol.fee_recipient = fee_recipient;
        ctx.accounts.protocol.fee_bps = fee_bps;
        Ok(())
    }

    /// Guardian or admin pause of new crosses and new orders. Reveals, clears, claims and
    /// refunds are never paused.
    pub fn set_paused(ctx: Context<GuardianOnly>, paused: bool) -> Result<()> {
        let signer = ctx.accounts.signer.key();
        let p = &mut ctx.accounts.protocol;
        require!(
            signer == p.guardian || signer == p.admin,
            CrossError::Unauthorized
        );
        p.paused = paused;
        emit!(PauseChanged { paused });
        Ok(())
    }

    pub fn create_cross(ctx: Context<CreateCross>, params: CreateCrossParams) -> Result<()> {
        let protocol = &ctx.accounts.protocol;
        require!(!protocol.paused, CrossError::Paused);
        require!(
            params.integrator_fee_bps <= MAX_INTEGRATOR_FEE_BPS,
            CrossError::FeeTooHigh
        );
        require!(
            params.tick > 0 && params.price_scale > 0,
            CrossError::InvalidParams
        );
        require!(
            params.ticks > 0 && usize::from(params.ticks) <= MAX_TICKS,
            CrossError::InvalidParams
        );
        require!(
            params.shards > 0 && params.shards <= MAX_SHARDS,
            CrossError::InvalidParams
        );
        require!(params.max_orders > 0, CrossError::InvalidParams);
        let deferred = params.supply_mode == SupplyMode::DeferredMint;
        require!(
            deferred == ctx.accounts.base_mint.is_none()
                && deferred == ctx.accounts.base_vault.is_none(),
            CrossError::InvalidParams
        );
        if let Some(base) = ctx.accounts.base_mint.as_ref() {
            require_keys_neq!(
                base.key(),
                ctx.accounts.quote_mint.key(),
                CrossError::InvalidParams
            );
        }
        let now = Clock::get()?.unix_timestamp;
        require!(
            params.open_ts < params.close_ts && params.close_ts > now,
            CrossError::InvalidTimeline
        );
        let reveal_end_ts = match params.disclosure {
            Disclosure::Open => params.close_ts,
            Disclosure::Sealed => {
                require!(
                    params.reveal_end_ts > params.close_ts,
                    CrossError::InvalidTimeline
                );
                params.reveal_end_ts
            }
        };

        let cross_key = ctx.accounts.cross.key();
        let c = &mut ctx.accounts.cross;
        c.creator = ctx.accounts.creator.key();
        c.cross_id = params.cross_id;
        c.kind = params.kind;
        c.supply_mode = params.supply_mode;
        c.disclosure = params.disclosure;
        c.state = CrossState::Live;
        c.base_mint = ctx
            .accounts
            .base_mint
            .as_ref()
            .map_or(Pubkey::default(), |m| m.key());
        c.quote_mint = ctx.accounts.quote_mint.key();
        c.base_token_program = ctx.accounts.base_token_program.key();
        c.quote_token_program = ctx.accounts.quote_token_program.key();
        c.base_decimals = ctx.accounts.base_mint.as_ref().map_or(0, |m| m.decimals);
        c.quote_decimals = ctx.accounts.quote_mint.decimals;
        c.proceeds_to = params.proceeds_to;
        c.min_price = params.min_price;
        c.tick = params.tick;
        c.ticks = params.ticks;
        c.price_scale = params.price_scale;
        c.open_ts = params.open_ts;
        c.close_ts = params.close_ts;
        c.reveal_end_ts = reveal_end_ts;
        c.reference_price = params.reference_price;
        c.min_matched = params.min_matched;
        c.max_imbalance_bps = params.max_imbalance_bps;
        // The protocol never takes more than 20% of a cross's total fees (ADR-0010):
        // p ≤ 0.2 · (p + i)  ⇔  p ≤ i / 4. A cross with no integrator fee pays no protocol fee.
        c.protocol_fee_bps =
            protocol.fee_bps[params.kind.index()].min(params.integrator_fee_bps / 4);
        c.integrator_fee_bps = params.integrator_fee_bps;
        c.integrator = params.integrator;
        c.fee_recipient = protocol.fee_recipient;
        c.gate_mint = params.gate_mint;
        if let Some(g) = params.oracle {
            // The guard needs real base decimals; deferred-mint launches have no reference market.
            require!(
                !deferred && g.max_divergence_bps > 0 && g.max_staleness_secs > 0,
                CrossError::InvalidParams
            );
        }
        c.oracle = params.oracle;
        if let Some(cal_key) = params.calendar {
            let info = ctx
                .accounts
                .calendar_account
                .as_ref()
                .ok_or(CrossError::CalendarMismatch)?;
            require_keys_eq!(info.key(), cal_key, CrossError::CalendarMismatch);
            require_keys_eq!(
                *info.owner,
                cross_calendar::ID,
                CrossError::CalendarMismatch
            );
            let data = info.try_borrow_data()?;
            let cal = cross_calendar::Calendar::try_deserialize(&mut &data[..])?;
            require!(
                cal.has_session_start(params.close_ts),
                CrossError::NotACalendarSession
            );
            if let Some(g) = params.oracle {
                require!(cal.approves_feed(&g.feed_id), CrossError::FeedNotApproved);
            }
        }
        c.calendar = params.calendar;
        c.shards = params.shards;
        c.max_orders = params.max_orders;
        c.bump = ctx.bumps.cross;
        c.quote_vault_bump = ctx.bumps.quote_vault;
        c.base_vault_bump = ctx.bumps.base_vault.unwrap_or_default();
        c.base_bound = !deferred;
        if deferred {
            require!(params.settler.is_some(), CrossError::InvalidParams);
            require!(
                params.settle_deadline_ts > reveal_end_ts,
                CrossError::InvalidTimeline
            );
            c.settler = params.settler;
            c.settle_deadline_ts = params.settle_deadline_ts;
        } else {
            require!(params.settler.is_none(), CrossError::InvalidParams);
        }
        c.book_bump = ctx.bumps.book;

        if let Some(r) = params.reference_price {
            require!(c.tick_index(r).is_some(), CrossError::OffGrid);
        }
        let max_price = c.max_price().ok_or(CrossError::Overflow)?;
        // The dust bond must cover buying one atom per order at the highest grid price (ADR-0003).
        let bond =
            clearing_core::buyer_pays(u64::from(params.max_orders), max_price, params.price_scale)
                .ok_or(CrossError::Overflow)?;
        c.dust_bond = bond;

        {
            let mut book = ctx.accounts.book.load_init()?;
            book.cross = cross_key;
            if params.supply_mode.mints() {
                require!(!params.schedule.is_empty(), CrossError::InvalidParams);
                if let Some(base) = ctx.accounts.base_mint.as_ref() {
                    require!(
                        Option::<Pubkey>::from(base.mint_authority) == Some(cross_key),
                        CrossError::MintAuthorityNotCross
                    );
                }
                for level in &params.schedule {
                    let i = c.tick_index(level.price).ok_or(CrossError::OffGrid)?;
                    require!(level.quantity > 0, CrossError::InvalidParams);
                    book.add(OrderSide::Sell, i, level.quantity)?;
                }
            } else {
                require!(params.schedule.is_empty(), CrossError::InvalidParams);
            }
        }

        if bond > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.quote_token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.creator_quote.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: ctx.accounts.quote_vault.to_account_info(),
                        authority: ctx.accounts.creator.to_account_info(),
                    },
                ),
                bond,
                ctx.accounts.quote_mint.decimals,
            )?;
        }

        emit!(CrossCreated {
            cross: cross_key,
            creator: c.creator,
            kind: c.kind,
            supply_mode: c.supply_mode,
            disclosure: c.disclosure,
            base_mint: c.base_mint,
            quote_mint: c.quote_mint,
            open_ts: c.open_ts,
            close_ts: c.close_ts,
            reveal_end_ts: c.reveal_end_ts,
            protocol_fee_bps: c.protocol_fee_bps,
            integrator_fee_bps: c.integrator_fee_bps
        });
        Ok(())
    }

    pub fn init_shard(ctx: Context<InitShard>, index: u8) -> Result<()> {
        require!(index < ctx.accounts.cross.shards, CrossError::InvalidParams);
        let mut shard = ctx.accounts.shard.load_init()?;
        shard.cross = ctx.accounts.cross.key();
        shard.index = index;
        Ok(())
    }

    /// Places an order and escrows its funds. Sealed crosses take a commitment; open crosses
    /// take the plaintext `price` and `quantity` and add them to the book immediately.
    pub fn commit_order(ctx: Context<CommitOrder>, args: CommitOrderArgs) -> Result<()> {
        let CommitOrderArgs {
            nonce,
            side,
            escrow,
            commitment,
            price,
            quantity,
            order_bump,
        } = args;
        require!(!ctx.accounts.protocol.paused, CrossError::Paused);
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.cross;
        require!(
            c.state == CrossState::Live && now >= c.open_ts && now < c.close_ts,
            CrossError::NotInCallWindow
        );
        require!(c.orders_total < c.max_orders, CrossError::CrossFull);
        require!(escrow > 0, CrossError::InvalidParams);
        if side == OrderSide::Sell {
            require!(!c.supply_mode.mints(), CrossError::SellsNotAccepted);
        }
        if let Some(gate_mint) = c.gate_mint {
            require!(
                holds_gate_pass(
                    ctx.accounts.pass.as_ref(),
                    &gate_mint,
                    &ctx.accounts.owner.key()
                ),
                CrossError::NotEligible
            );
        }

        let index = c.orders_total;
        let cross_key = c.key();
        let owner_key = ctx.accounts.owner.key();
        let nonce_bytes = nonce.to_le_bytes();
        let order_seeds: &[&[u8]] = &[
            ORDER_SEED,
            cross_key.as_ref(),
            owner_key.as_ref(),
            &nonce_bytes,
            &[order_bump],
        ];
        let expected = Pubkey::create_program_address(order_seeds, &crate::ID)
            .map_err(|_| CrossError::InvalidParams)?;
        require_keys_eq!(
            expected,
            ctx.accounts.order.key(),
            CrossError::InvalidParams
        );
        require!(
            ctx.accounts.order.data_is_empty() && ctx.accounts.order.lamports() == 0,
            CrossError::InvalidParams
        );
        let space = 8 + Order::INIT_SPACE;
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.order.to_account_info(),
                },
                &[order_seeds],
            ),
            Rent::get()?.minimum_balance(space),
            u64::try_from(space).map_err(|_| CrossError::Overflow)?,
            &crate::ID,
        )?;

        let mut o = Order {
            cross: cross_key,
            owner: owner_key,
            nonce,
            index,
            side,
            state: OrderState::Committed,
            commitment: [0; 32],
            price: 0,
            quantity: 0,
            escrow,
            bump: order_bump,
        };
        match c.disclosure {
            Disclosure::Sealed => {
                o.commitment = commitment;
            }
            Disclosure::Open => {
                validate_order(c, side, price, quantity, escrow)?;
                let shard_ix = usize::try_from(index % u32::from(c.shards))
                    .map_err(|_| CrossError::Overflow)?;
                let shard_acc = ctx
                    .accounts
                    .shard
                    .as_ref()
                    .ok_or(CrossError::ShardMissing)?;
                let mut shard = shard_acc.load_mut()?;
                require!(
                    usize::from(shard.index) == shard_ix && shard.cross == cross_key,
                    CrossError::WrongShard
                );
                shard.add(
                    side,
                    c.tick_index(price).ok_or(CrossError::OffGrid)?,
                    quantity,
                )?;
                o.state = OrderState::Revealed;
                o.price = price;
                o.quantity = quantity;
            }
        }
        {
            let info = ctx.accounts.order.to_account_info();
            let mut data = info.try_borrow_mut_data()?;
            o.try_serialize(&mut &mut data[..])?;
        }
        c.orders_total = c.orders_total.checked_add(1).ok_or(CrossError::Overflow)?;
        c.orders_open = c.orders_open.checked_add(1).ok_or(CrossError::Overflow)?;

        // Escrow transfer. The vault address is re-derived from the stored bump, the mint and
        // token program must be the cross's, and the token program checks ownership and mint.
        let (mint, program, decimals, vault_seed, vault_bump) = match side {
            OrderSide::Buy => (
                c.quote_mint,
                c.quote_token_program,
                c.quote_decimals,
                QUOTE_VAULT_SEED,
                c.quote_vault_bump,
            ),
            OrderSide::Sell => (
                c.base_mint,
                c.base_token_program,
                c.base_decimals,
                BASE_VAULT_SEED,
                c.base_vault_bump,
            ),
        };
        require_keys_eq!(ctx.accounts.escrow_mint.key(), mint, CrossError::WrongMint);
        require_keys_eq!(
            ctx.accounts.escrow_token_program.key(),
            program,
            CrossError::WrongMint
        );
        let vault = Pubkey::create_program_address(
            &[vault_seed, cross_key.as_ref(), &[vault_bump]],
            &crate::ID,
        )
        .map_err(|_| CrossError::WrongVault)?;
        require_keys_eq!(
            ctx.accounts.escrow_vault.key(),
            vault,
            CrossError::WrongVault
        );
        token_interface::transfer_checked(
            CpiContext::new(
                program,
                TransferChecked {
                    from: ctx.accounts.owner_escrow.to_account_info(),
                    mint: ctx.accounts.escrow_mint.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            escrow,
            decimals,
        )?;

        emit!(OrderCommitted {
            cross: cross_key,
            order: ctx.accounts.order.key(),
            owner: owner_key,
            side,
            escrow,
            index,
            sealed: c.disclosure == Disclosure::Sealed
        });
        Ok(())
    }

    /// Withdraws an order during the call window. Full refund, no fee.
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.cross;
        require!(
            c.state == CrossState::Live && now < c.close_ts,
            CrossError::NotInCallWindow
        );
        let o = &ctx.accounts.order;
        if o.state == OrderState::Revealed {
            let shard_acc = ctx
                .accounts
                .shard
                .as_ref()
                .ok_or(CrossError::ShardMissing)?;
            let mut shard = shard_acc.load_mut()?;
            let shard_ix =
                usize::try_from(o.index % u32::from(c.shards)).map_err(|_| CrossError::Overflow)?;
            require!(
                usize::from(shard.index) == shard_ix && shard.cross == c.key(),
                CrossError::WrongShard
            );
            shard.remove(
                o.side,
                c.tick_index(o.price).ok_or(CrossError::OffGrid)?,
                o.quantity,
            )?;
        }
        c.orders_open = c.orders_open.checked_sub(1).ok_or(CrossError::Overflow)?;
        let (creator, id, bump) = (c.creator, c.cross_id.to_le_bytes(), [c.bump]);
        let seeds: &[&[u8]] = &[CROSS_SEED, creator.as_ref(), &id, &bump];
        let cross_info = c.to_account_info();
        match o.side {
            OrderSide::Buy => transfer_signed(
                &ctx.accounts.quote_vault,
                ctx.accounts
                    .owner_quote
                    .as_ref()
                    .ok_or(CrossError::TokenAccountMissing)?,
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_token_program,
                &cross_info,
                seeds,
                o.escrow,
            )?,
            OrderSide::Sell => transfer_signed(
                &ctx.accounts.base_vault,
                ctx.accounts
                    .owner_base
                    .as_ref()
                    .ok_or(CrossError::TokenAccountMissing)?,
                &ctx.accounts.base_mint,
                &ctx.accounts.base_token_program,
                &cross_info,
                seeds,
                o.escrow,
            )?,
        }
        emit!(OrderCancelled {
            cross: c.key(),
            order: o.key(),
            owner: o.owner
        });
        Ok(())
    }

    /// Reveals a sealed order during the reveal window and adds it to its shard.
    pub fn reveal_order(
        ctx: Context<RevealOrder>,
        price: u64,
        quantity: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &ctx.accounts.cross;
        require!(c.disclosure == Disclosure::Sealed, CrossError::NotSealed);
        require!(
            c.state == CrossState::Live && now >= c.close_ts && now < c.reveal_end_ts,
            CrossError::NotInRevealWindow
        );
        let o = &mut ctx.accounts.order;
        require!(
            o.state == OrderState::Committed,
            CrossError::AlreadyRevealed
        );
        require!(
            commitment_of(&c.key(), &o.owner, o.nonce, o.side, price, quantity, &salt)
                == o.commitment,
            CrossError::CommitmentMismatch
        );
        validate_order(c, o.side, price, quantity, o.escrow)?;
        let mut shard = ctx.accounts.shard.load_mut()?;
        let shard_ix =
            usize::try_from(o.index % u32::from(c.shards)).map_err(|_| CrossError::Overflow)?;
        require!(
            usize::from(shard.index) == shard_ix && shard.cross == c.key(),
            CrossError::WrongShard
        );
        shard.add(
            o.side,
            c.tick_index(price).ok_or(CrossError::OffGrid)?,
            quantity,
        )?;
        o.state = OrderState::Revealed;
        o.price = price;
        o.quantity = quantity;
        emit!(OrderRevealed {
            cross: c.key(),
            order: o.key(),
            side: o.side,
            price,
            quantity
        });
        Ok(())
    }

    /// Adds one shard into the book. Permissionless; each shard merges exactly once.
    pub fn merge_shard(ctx: Context<MergeShard>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.cross;
        require!(
            c.state == CrossState::Live && now >= c.reveal_end_ts,
            CrossError::CallNotOver
        );
        let shard = ctx.accounts.shard.load()?;
        require!(shard.cross == c.key(), CrossError::WrongShard);
        let bit = 1u32
            .checked_shl(u32::from(shard.index))
            .ok_or(CrossError::Overflow)?;
        require!(c.merged_mask & bit == 0, CrossError::AlreadyMerged);
        ctx.accounts.book.load_mut()?.merge_from(&shard)?;
        c.merged_mask |= bit;
        Ok(())
    }

    /// Clears the cross once every shard is merged. Permissionless.
    pub fn clear(ctx: Context<Clear>) -> Result<()> {
        let c = &mut ctx.accounts.cross;
        require!(c.state == CrossState::Live, CrossError::WrongState);
        let all = if c.shards == 32 {
            u32::MAX
        } else {
            (1u32 << c.shards).wrapping_sub(1)
        };
        require!(c.merged_mask == all, CrossError::ShardsNotMerged);

        let book = ctx.accounts.book.load()?;
        let mut levels: Vec<clearing_core::Level> = Vec::new();
        for i in 0..usize::from(c.ticks) {
            if book.buy[i] == 0 && book.sell[i] == 0 {
                continue;
            }
            let price = c
                .min_price
                .checked_add(
                    u64::try_from(i)
                        .map_err(|_| CrossError::Overflow)?
                        .checked_mul(c.tick)
                        .ok_or(CrossError::Overflow)?,
                )
                .ok_or(CrossError::Overflow)?;
            levels.push(clearing_core::Level {
                price,
                buy: u128::from(book.buy[i]),
                sell: u128::from(book.sell[i]),
                buy_orders: book.buy_orders[i],
                sell_orders: book.sell_orders[i],
            });
        }
        let grid = OffsetGrid {
            min: c.min_price,
            tick: c.tick,
            ticks: c.ticks,
        };
        let result = clearing_core::clear(&levels, c.reference_price, &grid)
            .map_err(|_| CrossError::InvalidBook)?;
        let guards = clearing_core::PrintGuards {
            min_matched: u128::from(c.min_matched),
            max_imbalance_bps: c.max_imbalance_bps,
        };
        match result {
            None => {
                c.state = CrossState::NoPrint;
                c.no_print_reason = Some(NoPrintReason::NoCross);
            }
            Some(clearing) => match guards.check(&clearing) {
                Err(clearing_core::NoPrint::BelowMinimumVolume) => {
                    c.state = CrossState::NoPrint;
                    c.no_print_reason = Some(NoPrintReason::BelowMinimumVolume);
                }
                Err(clearing_core::NoPrint::ImbalanceTooHigh) => {
                    c.state = CrossState::NoPrint;
                    c.no_print_reason = Some(NoPrintReason::ImbalanceTooHigh);
                }
                Ok(()) => {
                    match oracle_verdict(c, ctx.accounts.oracle_price.as_ref(), clearing.price)? {
                        Some(reason) => {
                            c.state = CrossState::NoPrint;
                            c.no_print_reason = Some(reason);
                        }
                        None => {
                            c.state = CrossState::Cleared;
                            c.clearing = Some(ClearingSummary::from_core(&clearing));
                        }
                    }
                }
            },
        }
        emit!(CrossCleared {
            cross: c.key(),
            printed: c.state == CrossState::Cleared,
            clearing: c.clearing,
            no_print_reason: c.no_print_reason
        });
        Ok(())
    }

    /// Settles one order: pays its fill at the clearing price and refunds the rest. Anyone may
    /// crank it; funds always go to the order owner. Closes the order account.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let c = &mut ctx.accounts.cross;
        require!(
            c.state == CrossState::Cleared || c.state == CrossState::NoPrint,
            CrossError::WrongState
        );
        // A deferred-mint cross pays fills only once its adapter has bound the base mint.
        require!(
            c.state != CrossState::Cleared || c.base_bound,
            CrossError::SettlementPending
        );
        let o = &ctx.accounts.order;
        let cross_info = c.to_account_info();
        let (creator, id, bump) = (c.creator, c.cross_id.to_le_bytes(), [c.bump]);
        let seeds: &[&[u8]] = &[CROSS_SEED, creator.as_ref(), &id, &bump];

        let summary = match (c.state, o.state) {
            (CrossState::Cleared, OrderState::Revealed) => c.clearing,
            _ => None,
        };
        let (fill, quote_out, base_out, fee) = match summary {
            None => match o.side {
                OrderSide::Buy => (0, o.escrow, 0, 0),
                OrderSide::Sell => (0, 0, o.escrow, 0),
            },
            Some(s) => {
                let clearing = s.to_core();
                let fill = clearing_core::fill(o.side.into(), o.price, o.quantity, &clearing);
                match o.side {
                    OrderSide::Buy => {
                        let pay = clearing_core::buyer_pays(fill, s.price, c.price_scale)
                            .ok_or(CrossError::Overflow)?;
                        c.buyer_paid = c.buyer_paid.checked_add(pay).ok_or(CrossError::Overflow)?;
                        c.base_bought = c
                            .base_bought
                            .checked_add(fill)
                            .ok_or(CrossError::Overflow)?;
                        (
                            fill,
                            o.escrow.checked_sub(pay).ok_or(CrossError::Overflow)?,
                            fill,
                            0,
                        )
                    }
                    OrderSide::Sell => {
                        let gross = clearing_core::seller_receives(fill, s.price, c.price_scale)
                            .ok_or(CrossError::Overflow)?;
                        let fee = mul_bps(gross, c.total_fee_bps())?;
                        c.base_sold = c.base_sold.checked_add(fill).ok_or(CrossError::Overflow)?;
                        c.seller_paid = c
                            .seller_paid
                            .checked_add(gross)
                            .ok_or(CrossError::Overflow)?;
                        c.fees_accrued = c
                            .fees_accrued
                            .checked_add(fee)
                            .ok_or(CrossError::Overflow)?;
                        (
                            fill,
                            gross.checked_sub(fee).ok_or(CrossError::Overflow)?,
                            o.escrow.checked_sub(fill).ok_or(CrossError::Overflow)?,
                            fee,
                        )
                    }
                }
            }
        };

        if quote_out > 0 {
            transfer_signed(
                &ctx.accounts.quote_vault,
                &ctx.accounts.owner_quote,
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_token_program,
                &cross_info,
                seeds,
                quote_out,
            )?;
        }
        if base_out > 0 {
            let base_mint = ctx
                .accounts
                .base_mint
                .as_ref()
                .ok_or(CrossError::TokenAccountMissing)?;
            let owner_base = ctx
                .accounts
                .owner_base
                .as_ref()
                .ok_or(CrossError::TokenAccountMissing)?;
            if o.side == OrderSide::Buy && c.supply_mode.mints() {
                token_interface::mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.base_token_program.key(),
                        MintTo {
                            mint: base_mint.to_account_info(),
                            to: owner_base.to_account_info(),
                            authority: cross_info.clone(),
                        },
                        &[seeds],
                    ),
                    base_out,
                )?;
            } else {
                transfer_signed(
                    ctx.accounts
                        .base_vault
                        .as_ref()
                        .ok_or(CrossError::TokenAccountMissing)?,
                    owner_base,
                    base_mint,
                    &ctx.accounts.base_token_program,
                    &cross_info,
                    seeds,
                    base_out,
                )?;
            }
        }
        c.orders_open = c.orders_open.checked_sub(1).ok_or(CrossError::Overflow)?;
        emit!(OrderClaimed {
            cross: c.key(),
            order: o.key(),
            owner: o.owner,
            side: o.side,
            fill,
            quote_out,
            base_out,
            fee
        });
        Ok(())
    }

    /// Deferred-mint crosses: the registered settler binds the base mint it created after the
    /// clear. The cross PDA must already hold the mint authority.
    pub fn bind_base_mint(ctx: Context<BindBaseMint>) -> Result<()> {
        let c = &mut ctx.accounts.cross;
        require!(
            c.supply_mode == SupplyMode::DeferredMint,
            CrossError::WrongState
        );
        require!(
            c.state == CrossState::Cleared && !c.base_bound,
            CrossError::WrongState
        );
        require!(
            c.settler == Some(ctx.accounts.settler.key()),
            CrossError::NotSettler
        );
        let mint = &ctx.accounts.base_mint;
        require_keys_eq!(
            *mint.to_account_info().owner,
            c.base_token_program,
            CrossError::WrongMint
        );
        require_keys_neq!(mint.key(), c.quote_mint, CrossError::InvalidParams);
        require!(
            Option::<Pubkey>::from(mint.mint_authority) == Some(c.key()),
            CrossError::MintAuthorityNotCross
        );
        c.base_mint = mint.key();
        c.base_decimals = mint.decimals;
        c.base_bound = true;
        emit!(BaseMintBound {
            cross: c.key(),
            base_mint: c.base_mint
        });
        Ok(())
    }

    /// Deferred-mint crosses: if no base mint was bound by the deadline, anyone may abandon
    /// settlement; the cross becomes a no-print and every order is refunded in full.
    pub fn abandon_settlement(ctx: Context<AbandonSettlement>) -> Result<()> {
        let c = &mut ctx.accounts.cross;
        require!(
            c.supply_mode == SupplyMode::DeferredMint,
            CrossError::WrongState
        );
        require!(
            c.state == CrossState::Cleared && !c.base_bound,
            CrossError::WrongState
        );
        require!(
            Clock::get()?.unix_timestamp >= c.settle_deadline_ts,
            CrossError::DeadlineNotReached
        );
        c.state = CrossState::NoPrint;
        c.no_print_reason = Some(NoPrintReason::SettlementExpired);
        emit!(CrossCleared {
            cross: c.key(),
            printed: false,
            clearing: c.clearing,
            no_print_reason: c.no_print_reason
        });
        Ok(())
    }

    /// Distributes what is left once every order has been claimed: the issuer's proceeds and
    /// fees in mint mode, accrued fees in escrow mode, the dust and bond remainder to
    /// `proceeds_to`; then revokes the cross's mint authority in mint mode.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let c = &mut ctx.accounts.cross;
        require!(
            c.state == CrossState::Cleared || c.state == CrossState::NoPrint,
            CrossError::WrongState
        );
        require!(c.orders_open == 0, CrossError::OrdersOutstanding);
        let cross_info = c.to_account_info();
        let (creator, id, bump) = (c.creator, c.cross_id.to_le_bytes(), [c.bump]);
        let seeds: &[&[u8]] = &[CROSS_SEED, creator.as_ref(), &id, &bump];

        // Fees: in mint mode the issuer is the only seller and pays on buyers' total payment.
        let fees = match c.supply_mode {
            SupplyMode::Mint | SupplyMode::DeferredMint => {
                mul_bps(c.buyer_paid, c.total_fee_bps())?
            }
            SupplyMode::Escrow => c.fees_accrued,
        };
        let total_bps = u64::from(c.total_fee_bps());
        let protocol_fee = if total_bps == 0 {
            0
        } else {
            mul_div(fees, u64::from(c.protocol_fee_bps), total_bps)?
        };
        let integrator_fee = fees.checked_sub(protocol_fee).ok_or(CrossError::Overflow)?;
        if protocol_fee > 0 {
            transfer_signed(
                &ctx.accounts.quote_vault,
                &ctx.accounts.fee_recipient_quote,
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_token_program,
                &cross_info,
                seeds,
                protocol_fee,
            )?;
        }
        if integrator_fee > 0 {
            transfer_signed(
                &ctx.accounts.quote_vault,
                &ctx.accounts.integrator_quote,
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_token_program,
                &cross_info,
                seeds,
                integrator_fee,
            )?;
        }

        // Base dust (escrow mode): sold by sellers, not bought; the bond paid for it.
        let mut base_left = 0;
        if let Some(base_vault) = ctx.accounts.base_vault.as_mut() {
            base_vault.reload()?;
            base_left = base_vault.amount;
        }
        if base_left > 0 {
            transfer_signed(
                ctx.accounts
                    .base_vault
                    .as_ref()
                    .ok_or(CrossError::TokenAccountMissing)?,
                ctx.accounts
                    .proceeds_base
                    .as_ref()
                    .ok_or(CrossError::TokenAccountMissing)?,
                ctx.accounts
                    .base_mint
                    .as_ref()
                    .ok_or(CrossError::TokenAccountMissing)?,
                &ctx.accounts.base_token_program,
                &cross_info,
                seeds,
                base_left,
            )?;
        }
        // Everything else in the quote vault (issuer proceeds in mint mode, bond remainder and
        // rounding in all modes) goes to `proceeds_to`.
        ctx.accounts.quote_vault.reload()?;
        let quote_left = ctx.accounts.quote_vault.amount;
        if quote_left > 0 {
            transfer_signed(
                &ctx.accounts.quote_vault,
                &ctx.accounts.proceeds_quote,
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_token_program,
                &cross_info,
                seeds,
                quote_left,
            )?;
        }

        // A deferred-mint cross that never bound a mint has no authority to hand back.
        if c.supply_mode.mints() && c.base_bound {
            // After an allocation the supply is final: no one may mint again (DP4). If the cross
            // did not print, nothing was allocated and the creator gets the authority back.
            let next_authority = if c.state == CrossState::Cleared {
                None
            } else {
                Some(c.creator)
            };
            token_interface::set_authority(
                CpiContext::new_with_signer(
                    ctx.accounts.base_token_program.key(),
                    SetAuthority {
                        current_authority: cross_info.clone(),
                        account_or_mint: ctx
                            .accounts
                            .base_mint
                            .as_ref()
                            .ok_or(CrossError::TokenAccountMissing)?
                            .to_account_info(),
                    },
                    &[seeds],
                ),
                anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType::MintTokens,
                next_authority,
            )?;
        }
        c.state = CrossState::Finalized;
        emit!(CrossFinalized {
            cross: c.key(),
            protocol_fee,
            integrator_fee,
            proceeds_quote: quote_left,
            dust_base: base_left
        });
        Ok(())
    }
}

/// Applies the oracle guard, if any. `Ok(Some(reason))` means the cross must not print.
fn oracle_verdict(
    c: &Cross,
    account: Option<&UncheckedAccount>,
    price: u64,
) -> Result<Option<NoPrintReason>> {
    let Some(g) = c.oracle else { return Ok(None) };
    let account = account.ok_or(CrossError::OracleAccountMissing)?;
    if !oracle::is_pyth_receiver(account.owner) {
        return Ok(Some(NoPrintReason::OracleUnavailable));
    }
    let data = account.try_borrow_data()?;
    let Some(o) = oracle::parse_price_update(&data) else {
        return Ok(Some(NoPrintReason::OracleUnavailable));
    };
    let now = Clock::get()?.unix_timestamp;
    let fresh = now.saturating_sub(o.publish_time) <= i64::from(g.max_staleness_secs);
    if o.feed_id != g.feed_id || !o.fully_verified || !fresh {
        return Ok(Some(NoPrintReason::OracleUnavailable));
    }
    let Some(reference) =
        oracle::to_cross_units(&o, c.quote_decimals, c.base_decimals, c.price_scale)
    else {
        return Ok(Some(NoPrintReason::OracleUnavailable));
    };
    Ok(oracle::diverges(price, reference, g.max_divergence_bps)
        .then_some(NoPrintReason::OracleDivergence))
}

fn validate_order(
    c: &Cross,
    side: OrderSide,
    price: u64,
    quantity: u64,
    escrow: u64,
) -> Result<()> {
    require!(quantity > 0, CrossError::InvalidParams);
    require!(c.tick_index(price).is_some(), CrossError::OffGrid);
    match side {
        OrderSide::Buy => {
            let max_cost = clearing_core::buyer_pays(quantity, price, c.price_scale)
                .ok_or(CrossError::Overflow)?;
            require!(max_cost <= escrow, CrossError::InsufficientEscrow);
        }
        OrderSide::Sell => require!(quantity <= escrow, CrossError::InsufficientEscrow),
    }
    Ok(())
}

pub fn commitment_of(
    cross: &Pubkey,
    owner: &Pubkey,
    nonce: u64,
    side: OrderSide,
    price: u64,
    quantity: u64,
    salt: &[u8; 32],
) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        cross.as_ref(),
        owner.as_ref(),
        &nonce.to_le_bytes(),
        &[side as u8],
        &price.to_le_bytes(),
        &quantity.to_le_bytes(),
        salt,
    ])
    .to_bytes()
}

fn holds_gate_pass(pass: Option<&UncheckedAccount>, gate_mint: &Pubkey, owner: &Pubkey) -> bool {
    let Some(pass) = pass else { return false };
    if pass.owner != &cross_gate::ID || pass.data_is_empty() {
        return false;
    }
    let Ok(data) = pass.try_borrow_data() else {
        return false;
    };
    let Ok(p) = cross_gate::Pass::try_deserialize(&mut &data[..]) else {
        return false;
    };
    // The stored bump lets us verify the address without a bump search.
    let derived = Pubkey::create_program_address(
        &[
            cross_gate::PASS_SEED,
            gate_mint.as_ref(),
            owner.as_ref(),
            &[p.bump],
        ],
        &cross_gate::ID,
    );
    &p.mint == gate_mint && &p.owner == owner && derived.is_ok_and(|a| a == pass.key())
}

fn mul_bps(amount: u64, bps: u16) -> Result<u64> {
    mul_div(amount, u64::from(bps), BPS)
}

fn mul_div(a: u64, b: u64, d: u64) -> Result<u64> {
    let v = u128::from(a)
        .checked_mul(u128::from(b))
        .and_then(|x| x.checked_div(u128::from(d)))
        .ok_or(CrossError::Overflow)?;
    u64::try_from(v).map_err(|_| CrossError::Overflow.into())
}

#[allow(clippy::too_many_arguments)]
fn transfer_signed<'info>(
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    program: &Interface<'info, TokenInterface>,
    authority: &AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Protocol::INIT_SPACE, seeds = [PROTOCOL_SEED], bump)]
    pub protocol: Account<'info, Protocol>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PROTOCOL_SEED], bump = protocol.bump, has_one = admin @ CrossError::Unauthorized)]
    pub protocol: Account<'info, Protocol>,
}

#[derive(Accounts)]
pub struct GuardianOnly<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, Protocol>,
}

#[derive(Accounts)]
#[instruction(params: CreateCrossParams)]
pub struct CreateCross<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(init, payer = creator, space = 8 + Cross::INIT_SPACE, seeds = [CROSS_SEED, creator.key().as_ref(), &params.cross_id.to_le_bytes()], bump)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(init, payer = creator, space = Levels::SIZE, seeds = [BOOK_SEED, cross.key().as_ref()], bump)]
    pub book: AccountLoader<'info, Levels>,
    /// Omitted for deferred-mint crosses.
    #[account(mint::token_program = base_token_program)]
    pub base_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = creator, seeds = [QUOTE_VAULT_SEED, cross.key().as_ref()], bump, token::mint = quote_mint, token::authority = cross, token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = creator, seeds = [BASE_VAULT_SEED, cross.key().as_ref()], bump, token::mint = base_mint, token::authority = cross, token::token_program = base_token_program)]
    pub base_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = quote_mint, token::authority = creator, token::token_program = quote_token_program)]
    pub creator_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: required when `params.calendar` is set; owner and contents checked in the handler.
    pub calendar_account: Option<UncheckedAccount<'info>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct InitShard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub cross: Box<Account<'info, Cross>>,
    #[account(init, payer = payer, space = Levels::SIZE, seeds = [SHARD_SEED, cross.key().as_ref(), &[index]], bump)]
    pub shard: AccountLoader<'info, Levels>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    /// CHECK: created in the handler at the PDA `[ORDER_SEED, cross, owner, nonce]` using the
    /// client-supplied bump, which `create_program_address` verifies (no bump search).
    #[account(mut)]
    pub order: UncheckedAccount<'info>,
    /// Required for open disclosure (the order's shard); omitted for sealed crosses.
    #[account(mut)]
    pub shard: Option<AccountLoader<'info, Levels>>,
    /// CHECK: required when the cross is gated; validated in `holds_gate_pass`.
    pub pass: Option<UncheckedAccount<'info>>,
    /// CHECK: the escrowed token's mint (quote for buys, base for sells); checked against the
    /// cross in the handler, decimals come from the cross.
    pub escrow_mint: UncheckedAccount<'info>,
    /// CHECK: the cross's vault for the escrowed token; checked against the stored bump in the
    /// handler and by the token program on transfer.
    #[account(mut)]
    pub escrow_vault: UncheckedAccount<'info>,
    /// CHECK: the owner's account for the escrowed token; the token program enforces that the
    /// owner signs for it and that its mint matches.
    #[account(mut)]
    pub owner_escrow: UncheckedAccount<'info>,
    /// CHECK: token program of the escrowed token; checked against the cross in the handler.
    pub escrow_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(mut, close = owner, has_one = owner @ CrossError::Unauthorized, has_one = cross @ CrossError::WrongCross)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut)]
    pub shard: Option<AccountLoader<'info, Levels>>,
    #[account(address = cross.base_mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = cross.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, cross.key().as_ref()], bump = cross.quote_vault_bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [BASE_VAULT_SEED, cross.key().as_ref()], bump = cross.base_vault_bump)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = quote_mint, token::authority = owner, token::token_program = quote_token_program)]
    pub owner_quote: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = base_mint, token::authority = owner, token::token_program = base_token_program)]
    pub owner_base: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(address = cross.base_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
    #[account(address = cross.quote_token_program)]
    pub quote_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RevealOrder<'info> {
    pub owner: Signer<'info>,
    pub cross: Box<Account<'info, Cross>>,
    #[account(mut, has_one = owner @ CrossError::Unauthorized, has_one = cross @ CrossError::WrongCross)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut)]
    pub shard: AccountLoader<'info, Levels>,
}

#[derive(Accounts)]
pub struct MergeShard<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(mut, seeds = [BOOK_SEED, cross.key().as_ref()], bump = cross.book_bump)]
    pub book: AccountLoader<'info, Levels>,
    pub shard: AccountLoader<'info, Levels>,
}

#[derive(Accounts)]
pub struct Clear<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(seeds = [BOOK_SEED, cross.key().as_ref()], bump = cross.book_bump)]
    pub book: AccountLoader<'info, Levels>,
    /// CHECK: required when the cross has an oracle guard: a Pyth `PriceUpdateV2` account for the
    /// pinned feed (typically posted by the keeper in the same transaction); ownership, feed,
    /// verification level and freshness are checked in `oracle_verdict`.
    pub oracle_price: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Anyone may crank; pays for any missing owner token account.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    /// CHECK: receives the order's rent; bound by `has_one` on the order.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, close = owner, has_one = owner @ CrossError::Unauthorized, has_one = cross @ CrossError::WrongCross)]
    pub order: Box<Account<'info, Order>>,
    /// Omitted only when nothing is paid in base (refunds of a deferred-mint cross).
    #[account(mut, address = cross.base_mint)]
    pub base_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(address = cross.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, cross.key().as_ref()], bump = cross.quote_vault_bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Escrow mode only.
    #[account(mut, seeds = [BASE_VAULT_SEED, cross.key().as_ref()], bump = cross.base_vault_bump)]
    pub base_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = quote_mint, associated_token::authority = owner, associated_token::token_program = quote_token_program)]
    pub owner_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The owner's base account (create it first; the SDK adds an idempotent ATA creation).
    #[account(mut, token::mint = base_mint, token::authority = owner, token::token_program = base_token_program)]
    pub owner_base: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(address = cross.base_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
    #[account(address = cross.quote_token_program)]
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BindBaseMint<'info> {
    pub settler: Signer<'info>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
}

#[derive(Accounts)]
pub struct AbandonSettlement<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    /// Required whenever the cross has a bound base mint.
    #[account(mut, address = cross.base_mint)]
    pub base_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(address = cross.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [QUOTE_VAULT_SEED, cross.key().as_ref()], bump = cross.quote_vault_bump)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Escrow mode only.
    #[account(mut, seeds = [BASE_VAULT_SEED, cross.key().as_ref()], bump = cross.base_vault_bump)]
    pub base_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// May be the same account as the other payout accounts (e.g. an issuer acting as its own
    /// integrator); Anchor never writes token accounts back, so aliasing is safe.
    #[account(mut, dup, token::mint = quote_mint, token::authority = cross.fee_recipient, token::token_program = quote_token_program)]
    pub fee_recipient_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// May be the same account as the other payout accounts (e.g. an issuer acting as its own
    /// integrator); Anchor never writes token accounts back, so aliasing is safe.
    #[account(mut, dup, token::mint = quote_mint, token::authority = cross.integrator, token::token_program = quote_token_program)]
    pub integrator_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// May be the same account as the other payout accounts (e.g. an issuer acting as its own
    /// integrator); Anchor never writes token accounts back, so aliasing is safe.
    #[account(mut, dup, token::mint = quote_mint, token::authority = cross.proceeds_to, token::token_program = quote_token_program)]
    pub proceeds_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Escrow mode only (receives base dust).
    #[account(mut, token::mint = base_mint, token::authority = cross.proceeds_to, token::token_program = base_token_program)]
    pub proceeds_base: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(address = cross.base_token_program)]
    pub base_token_program: Interface<'info, TokenInterface>,
    #[account(address = cross.quote_token_program)]
    pub quote_token_program: Interface<'info, TokenInterface>,
}

// ---------------------------------------------------------------- events and errors

#[event]
pub struct PauseChanged {
    pub paused: bool,
}
#[event]
pub struct CrossCreated {
    pub cross: Pubkey,
    pub creator: Pubkey,
    pub kind: CrossKind,
    pub supply_mode: SupplyMode,
    pub disclosure: Disclosure,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub open_ts: i64,
    pub close_ts: i64,
    pub reveal_end_ts: i64,
    pub protocol_fee_bps: u16,
    pub integrator_fee_bps: u16,
}
#[event]
pub struct OrderCommitted {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub owner: Pubkey,
    pub side: OrderSide,
    pub escrow: u64,
    pub index: u32,
    pub sealed: bool,
}
#[event]
pub struct OrderCancelled {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub owner: Pubkey,
}
#[event]
pub struct OrderRevealed {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub side: OrderSide,
    pub price: u64,
    pub quantity: u64,
}
#[event]
pub struct CrossCleared {
    pub cross: Pubkey,
    pub printed: bool,
    pub clearing: Option<ClearingSummary>,
    pub no_print_reason: Option<NoPrintReason>,
}
#[event]
pub struct OrderClaimed {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub owner: Pubkey,
    pub side: OrderSide,
    pub fill: u64,
    pub quote_out: u64,
    pub base_out: u64,
    pub fee: u64,
}
#[event]
pub struct BaseMintBound {
    pub cross: Pubkey,
    pub base_mint: Pubkey,
}
#[event]
pub struct CrossFinalized {
    pub cross: Pubkey,
    pub protocol_fee: u64,
    pub integrator_fee: u64,
    pub proceeds_quote: u64,
    pub dust_base: u64,
}

#[error_code]
pub enum CrossError {
    #[msg("Protocol is paused for new crosses and orders")]
    Paused,
    #[msg("Signer is not authorised")]
    Unauthorized,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Invalid timeline")]
    InvalidTimeline,
    #[msg("Fee exceeds its cap")]
    FeeTooHigh,
    #[msg("Price is not on the cross's grid")]
    OffGrid,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Outside the call window")]
    NotInCallWindow,
    #[msg("Outside the reveal window")]
    NotInRevealWindow,
    #[msg("The call and reveal windows have not ended")]
    CallNotOver,
    #[msg("Cross has reached its order limit")]
    CrossFull,
    #[msg("This cross does not accept sell orders")]
    SellsNotAccepted,
    #[msg("Owner is not eligible for this cross")]
    NotEligible,
    #[msg("Shard account required")]
    ShardMissing,
    #[msg("Wrong shard for this order")]
    WrongShard,
    #[msg("Order does not belong to this cross")]
    WrongCross,
    #[msg("Cross is not sealed")]
    NotSealed,
    #[msg("Order already revealed")]
    AlreadyRevealed,
    #[msg("Reveal does not match the commitment")]
    CommitmentMismatch,
    #[msg("Escrow does not cover the order")]
    InsufficientEscrow,
    #[msg("Shard already merged")]
    AlreadyMerged,
    #[msg("Not every shard has been merged")]
    ShardsNotMerged,
    #[msg("Cross is in the wrong state for this action")]
    WrongState,
    #[msg("Book is inconsistent")]
    InvalidBook,
    #[msg("Orders remain unclaimed")]
    OrdersOutstanding,
    #[msg("Mint mode requires the cross PDA to hold the mint authority")]
    MintAuthorityNotCross,
    #[msg("The token account for this order side is required")]
    TokenAccountMissing,
    #[msg("Mint or token program does not match the cross")]
    WrongMint,
    #[msg("Vault does not match the cross")]
    WrongVault,
    #[msg("Settlement has not bound the base mint yet")]
    SettlementPending,
    #[msg("Only the registered settler may do this")]
    NotSettler,
    #[msg("Settlement deadline has not passed")]
    DeadlineNotReached,
    #[msg("This cross needs a Pyth price update account")]
    OracleAccountMissing,
    #[msg("Calendar account missing or does not match")]
    CalendarMismatch,
    #[msg("The cross must close at the start of a calendar session")]
    NotACalendarSession,
    #[msg("The oracle feed is not approved by the calendar")]
    FeedNotApproved,
}
