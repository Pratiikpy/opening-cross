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
    token_interface::{self, Mint, SetAuthority, TokenAccount, TokenInterface, TransferChecked},
};

pub mod classbook;
pub mod create;
pub mod draw;
pub mod ext;
pub mod feed;
pub mod halt;
pub mod identity;
pub mod lock;
pub mod neutral;
pub mod oracle;
pub mod orders;
pub mod refunds;
pub mod rules;
pub mod series;
pub mod state;

#[allow(ambiguous_glob_reexports)]
pub use classbook::*;
#[allow(ambiguous_glob_reexports)]
pub use draw::*;
#[allow(ambiguous_glob_reexports)]
pub use ext::*;
#[allow(ambiguous_glob_reexports)]
pub use feed::*;
#[allow(ambiguous_glob_reexports)]
pub use halt::*;
#[allow(ambiguous_glob_reexports)]
pub use identity::*;
#[allow(ambiguous_glob_reexports)]
pub use lock::*;
#[allow(ambiguous_glob_reexports)]
pub use neutral::*;
#[allow(ambiguous_glob_reexports)]
pub use orders::*;
#[allow(ambiguous_glob_reexports)]
pub use refunds::*;
#[allow(ambiguous_glob_reexports)]
pub use rules::*;
#[allow(ambiguous_glob_reexports)]
pub use series::*;
use state::*;

declare_id!("F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ");

/// How long after the reveal window an unfinished extension draw holds the clear back before the
/// cross clears as it stands (3 days).
pub const EXTENSION_GRACE_SECS: i64 = 3 * 24 * 60 * 60;

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

/// Arguments for `commit_order_ext`: those of `commit_order` and the order's class and lock.
/// (A separate type keeps `commit_order`'s arguments flat in the generated clients.)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CommitOrderExtArgs {
    pub nonce: u64,
    pub side: OrderSide,
    pub escrow: u64,
    pub commitment: [u8; 32],
    pub price: u64,
    pub quantity: u64,
    pub order_bump: u8,
    /// Allocation class: 0 general, 1 identity-verified small, 2 locked, 3 priority.
    pub class: u8,
    /// Class 2: seconds the fill stays locked.
    pub lock_secs: u32,
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
        p.pending_admin = None;
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

    /// Brings a protocol account written by an earlier layout up to the current one. Only the
    /// stored admin may run it; it grows the account (the admin pays the extra rent) and sets every
    /// field added since to its default. Idempotent: a current account is left unchanged.
    pub fn migrate_protocol(ctx: Context<MigrateProtocol>) -> Result<()> {
        let info = ctx.accounts.protocol.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, CrossError::Unauthorized);
        let (pda, _) = Pubkey::find_program_address(&[PROTOCOL_SEED], &crate::ID);
        require_keys_eq!(info.key(), pda, CrossError::Unauthorized);
        let target = 8 + Protocol::INIT_SPACE;
        {
            let data = info.try_borrow_data()?;
            require!(
                data.len() >= 8 + 32 && data[..8] == *Protocol::DISCRIMINATOR,
                CrossError::Unauthorized
            );
            let stored_admin =
                Pubkey::new_from_array(data[8..40].try_into().map_err(|_| CrossError::Overflow)?);
            require_keys_eq!(
                stored_admin,
                ctx.accounts.admin.key(),
                CrossError::Unauthorized
            );
            if data.len() >= target {
                return Ok(());
            }
        }
        let old_len = info.data_len();
        let rent = Rent::get()?
            .minimum_balance(target)
            .saturating_sub(info.lamports());
        if rent > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.admin.to_account_info(),
                        to: info.clone(),
                    },
                ),
                rent,
            )?;
        }
        info.resize(target)?;
        // Zero every added byte explicitly: `pending_admin = None` is a single 0 tag byte.
        let mut data = info.try_borrow_mut_data()?;
        for b in data[old_len..].iter_mut() {
            *b = 0;
        }
        Ok(())
    }

    /// First step of an admin handover (e.g. to a multisig vault). Nothing changes until the
    /// proposed admin accepts, so a mistyped address cannot lock the protocol. `None` withdraws it.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Option<Pubkey>) -> Result<()> {
        ctx.accounts.protocol.pending_admin = new_admin;
        emit!(AdminProposed {
            admin: ctx.accounts.protocol.admin,
            proposed: new_admin
        });
        Ok(())
    }

    /// Second step: the proposed admin signs to take over.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let p = &mut ctx.accounts.protocol;
        require!(
            p.pending_admin == Some(ctx.accounts.new_admin.key()),
            CrossError::Unauthorized
        );
        let previous = p.admin;
        p.admin = ctx.accounts.new_admin.key();
        p.pending_admin = None;
        emit!(AdminChanged {
            previous,
            admin: p.admin
        });
        Ok(())
    }

    /// The admin may rotate the guardian (the key allowed to pause new activity).
    pub fn set_guardian(ctx: Context<AdminOnly>, guardian: Pubkey) -> Result<()> {
        ctx.accounts.protocol.guardian = guardian;
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
        let bond = create::populate(
            create::Setup {
                protocol: &ctx.accounts.protocol,
                cross: &mut ctx.accounts.cross,
                book: &ctx.accounts.book,
                creator: ctx.accounts.creator.key(),
                base_mint: ctx.accounts.base_mint.as_deref(),
                has_base_vault: ctx.accounts.base_vault.is_some(),
                quote_mint: &ctx.accounts.quote_mint,
                base_token_program: ctx.accounts.base_token_program.key(),
                quote_token_program: ctx.accounts.quote_token_program.key(),
                calendar_account: ctx.accounts.calendar_account.as_ref().map(|a| a.as_ref()),
                bumps: create::Bumps {
                    cross: ctx.bumps.cross,
                    quote_vault: ctx.bumps.quote_vault,
                    base_vault: ctx.bumps.base_vault,
                    book: ctx.bumps.book,
                },
            },
            &params,
        )?;
        let c = &ctx.accounts.cross;
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
            cross: c.key(),
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
        let x = ext::read(&ctx.accounts.cross.to_account_info())?;
        require!(
            x.valid_shard_index(&ctx.accounts.cross, index),
            CrossError::InvalidParams
        );
        let mut shard = ctx.accounts.shard.load_init()?;
        shard.cross = ctx.accounts.cross.key();
        shard.index = index;
        Ok(())
    }

    /// Fixes the rules of a cross (ADR-0450): the creator, in the slot the cross was created in,
    /// before any order exists. Remaining accounts: the lender print feed when the cross feeds it.
    pub fn set_rules<'info>(
        ctx: Context<'info, SetRules<'info>>,
        input: CompactRules,
    ) -> Result<()> {
        rules::set_rules(ctx, input)
    }

    /// Registers the halt state of a base mint (ADR-0455). Signed by the mint authority or the
    /// protocol admin.
    pub fn init_halt_state(
        ctx: Context<InitHaltState>,
        venue_signer: Option<Pubkey>,
        breaker: Option<BreakerSetup>,
    ) -> Result<()> {
        halt::init_halt_state(ctx, venue_signer, breaker)
    }

    /// The issuer authority or the venue signer halts the asset. Only a printing resume cross
    /// lifts the halt.
    pub fn set_halt(ctx: Context<HaltSignal>) -> Result<()> {
        halt::set_halt(ctx)
    }

    /// The issuer authority flags or unflags a corporate action.
    pub fn set_corporate_action(ctx: Context<HaltSignal>, flag: bool) -> Result<()> {
        halt::set_corporate_action(ctx, flag)
    }

    /// Anyone copies the mint's pause state into its halt state.
    pub fn sync_pause(ctx: Context<SyncPause>) -> Result<()> {
        halt::sync_pause(ctx)
    }

    /// Anyone feeds a verified oracle update to the asset's circuit breaker.
    pub fn observe_price(ctx: Context<ObservePrice>) -> Result<()> {
        halt::observe_price(ctx)
    }

    /// Registers the lender price feed of a base mint (ADR-0451).
    pub fn init_print_feed(
        ctx: Context<InitPrintFeed>,
        publishers: Vec<Pubkey>,
        min_matched: u64,
    ) -> Result<()> {
        feed::init_print_feed(ctx, publishers, min_matched)
    }

    /// Changes who may publish to a lender price feed, and the minimum print size.
    pub fn set_feed_publishers(
        ctx: Context<FeedAuthority>,
        publishers: Vec<Pubkey>,
        min_matched: u64,
    ) -> Result<()> {
        feed::set_feed_publishers(ctx, publishers, min_matched)
    }

    /// Starts the draw that closes an epoch or sets the extension length (ADR-0452). Anyone may
    /// call it once the call, and any reveal window, is over.
    pub fn draw_begin(ctx: Context<DrawBegin>) -> Result<()> {
        draw::draw_begin(ctx)
    }

    /// Finishes a draw from the block hashes that followed `draw_begin`, and applies it.
    pub fn draw_finish(ctx: Context<DrawFinish>) -> Result<()> {
        draw::draw_finish(ctx)
    }

    /// Creates a recurring series of escrow crosses (ADR-0456).
    pub fn create_series(
        ctx: Context<CreateSeries>,
        series_id: u64,
        config: SeriesConfig,
    ) -> Result<()> {
        series::create_series(ctx, series_id, config)
    }

    /// Spawns the next cross of a series when it is due. Permissionless. Remaining accounts: the
    /// lender print feed, when the series' rules feed it.
    pub fn spawn_next<'info>(ctx: Context<'info, SpawnNext<'info>>) -> Result<()> {
        series::spawn_next(ctx)
    }

    /// The series' authority pauses or resumes spawning.
    pub fn set_series_active(ctx: Context<SeriesAuthority>, active: bool) -> Result<()> {
        series::set_series_active(ctx, active)
    }

    /// The series' authority withdraws tokens the series holds.
    pub fn series_withdraw(ctx: Context<SeriesWithdraw>, amount: u64) -> Result<()> {
        series::series_withdraw(ctx, amount)
    }

    /// Emits the cross's extension tail as an event (permissionless, read-only).
    pub fn log_ext(ctx: Context<LogExt>) -> Result<()> {
        ext::log_ext(ctx)
    }

    /// Creates the class book a cross with allocation classes or declared insiders needs.
    pub fn init_class_book(ctx: Context<InitClassBook>) -> Result<()> {
        classbook::init_class_book(ctx)
    }

    /// Returns an applicant record's rent to its owner once the cross is finalized.
    pub fn close_applicant(ctx: Context<CloseApplicant>) -> Result<()> {
        identity::close_applicant(ctx)
    }

    /// Creates the vault that holds the cross's locked tokens.
    pub fn init_lock_vault(ctx: Context<InitLockVault>) -> Result<()> {
        lock::init_lock_vault(ctx)
    }

    /// Pays the vested part of a lockup to its owner. Anyone may call it.
    pub fn release_locked(ctx: Context<ReleaseLocked>) -> Result<()> {
        lock::release_locked(ctx)
    }

    /// The protocol admin names the arbiter that rules on insider challenges.
    pub fn set_arbiter(ctx: Context<SetArbiter>, arbiter: Pubkey) -> Result<()> {
        neutral::set_arbiter(ctx, arbiter)
    }

    /// Alleges that `subject` was an undeclared insider; posts a deposit (ADR-0454).
    pub fn challenge_insider(
        ctx: Context<ChallengeInsider>,
        subject: Pubkey,
        evidence: [u8; 32],
    ) -> Result<()> {
        neutral::challenge_insider(ctx, subject, evidence)
    }

    /// The arbiter rules on a challenge, slashing part of the bond when it is upheld.
    pub fn resolve_challenge(
        ctx: Context<ResolveChallenge>,
        upheld: bool,
        slash: u64,
    ) -> Result<()> {
        neutral::resolve_challenge(ctx, upheld, slash)
    }

    /// Refunds up to twelve orders that are owed nothing but their escrow (a cross that did not print, or orders
    /// that were not filled) in one transaction, to their owners' own token accounts. Anyone may call it.
    pub fn push_refunds<'info>(ctx: Context<'info, PushRefunds<'info>>) -> Result<()> {
        refunds::push_refunds(ctx)
    }

    /// Anyone closes an insider challenge the arbiter has not ruled on within fourteen days; the
    /// challenger's deposit returns and the bond is untouched.
    pub fn expire_challenge(ctx: Context<ExpireChallenge>) -> Result<()> {
        neutral::expire_challenge(ctx)
    }

    /// Places an order and escrows its funds. Sealed crosses take a commitment; open crosses
    /// take the plaintext `price` and `quantity` and add them to the book immediately.
    ///
    /// Remaining accounts, only those the cross's rules call for and in this order (ADR-0450):
    /// the applicant record (identity limits), the class book (classes, insiders), the priority
    /// pass (class 3 outside the early window).
    pub fn commit_order<'info>(
        ctx: Context<'info, CommitOrder<'info>>,
        args: CommitOrderArgs,
    ) -> Result<()> {
        orders::commit(ctx, args, OrderExtra::default())
    }

    /// `commit_order` with an allocation class and a lock (ADR-0453, ADR-0454).
    pub fn commit_order_ext<'info>(
        ctx: Context<'info, CommitOrder<'info>>,
        args: CommitOrderExtArgs,
    ) -> Result<()> {
        orders::commit(
            ctx,
            CommitOrderArgs {
                nonce: args.nonce,
                side: args.side,
                escrow: args.escrow,
                commitment: args.commitment,
                price: args.price,
                quantity: args.quantity,
                order_bump: args.order_bump,
            },
            OrderExtra {
                class: args.class,
                lock_secs: args.lock_secs,
            },
        )
    }

    /// Withdraws an order during the call window. Full refund, no fee. Remaining accounts: the
    /// applicant record, then the class book, when the rules call for them.
    pub fn cancel_order<'info>(ctx: Context<'info, CancelOrder<'info>>) -> Result<()> {
        orders::cancel(ctx)
    }

    /// Reveals a sealed order during the reveal window and adds it to its shard. Remaining
    /// accounts: the class book, when the cross has one.
    pub fn reveal_order<'info>(
        ctx: Context<'info, RevealOrder<'info>>,
        price: u64,
        quantity: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        orders::reveal(ctx, price, quantity, salt)
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
        if shard.index < 32 {
            let bit = 1u32
                .checked_shl(u32::from(shard.index))
                .ok_or(CrossError::Overflow)?;
            require!(c.merged_mask & bit == 0, CrossError::AlreadyMerged);
            ctx.accounts.book.load_mut()?.merge_from(&shard)?;
            c.merged_mask |= bit;
            return Ok(());
        }
        // Auxiliary shards: ending buckets and the extension window (ADR-0452).
        let info = c.to_account_info();
        let mut x = ext::read(&info)?;
        require!(x.valid_shard_index(c, shard.index), CrossError::WrongShard);
        let bit = ext::CrossExt::aux_bit(shard.index);
        require!(x.draw.aux_merged & bit == 0, CrossError::AlreadyMerged);
        if shard.index < ext::AUX_EXT_BASE {
            // The drawn end decides which buckets count; a bucket after it never merges.
            require!(
                !x.ending.random_end || x.draw.end_bucket != ext::NO_BUCKET,
                CrossError::DrawRequired
            );
            require!(
                shard.index - ext::AUX_END_BASE <= x.last_bucket(),
                CrossError::BucketExcluded
            );
        } else {
            require!(x.draw.epoch > 0, CrossError::WrongShard);
        }
        ctx.accounts.book.load_mut()?.merge_from(&shard)?;
        x.draw.aux_merged |= bit;
        ext::write(&info, &x)?;
        Ok(())
    }

    /// Clears the cross once every shard is merged. Permissionless.
    ///
    /// Remaining accounts, in this order and only those the stored rules call for (ADR-0450):
    /// the halt state, then the base mint (halt rule, or float and valuation rules without a
    /// declared supply), then the lender print feed.
    pub fn clear<'info>(ctx: Context<'info, Clear<'info>>) -> Result<()> {
        let c = &mut ctx.accounts.cross;
        require!(c.state == CrossState::Live, CrossError::WrongState);
        let all = if c.shards == 32 {
            u32::MAX
        } else {
            (1u32 << c.shards).wrapping_sub(1)
        };
        require!(c.merged_mask == all, CrossError::ShardsNotMerged);
        let info = c.to_account_info();
        let mut x = ext::read(&info)?;
        let now = Clock::get()?.unix_timestamp;
        // An extension waiting for its draw holds the clear back; if nobody finishes the draw
        // the cross is not stuck: after a grace period it clears as it stands.
        let mut may_extend = x.ending.extension_max_secs > 0 && !x.draw.extension_used;
        if x.draw.ext_pending {
            require!(
                now >= c.reveal_end_ts.saturating_add(EXTENSION_GRACE_SECS),
                CrossError::ExtensionPending
            );
            may_extend = false;
        }
        if x.needs_draw() {
            require!(
                x.draw.seed_ready && x.draw.seed_epoch == x.draw.epoch,
                CrossError::DrawRequired
            );
        }
        let required = x.required_aux(c.shards);
        require!(
            x.draw.aux_merged & required == required,
            CrossError::ShardsNotMerged
        );
        let aux = ClearAux::parse(&x, c, ctx.remaining_accounts)?;

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
        let cap = (x.guards.max_matched > 0).then(|| u128::from(x.guards.max_matched));
        let result = clearing_core::clear_with(&levels, c.reference_price, &grid, cap)
            .map_err(|_| CrossError::InvalidBook)?;
        let outcome = match result {
            None => Err(NoPrintReason::NoCross),
            Some(clearing) => {
                match print_verdict(c, &x, &aux, &clearing, ctx.accounts.oracle_price.as_ref())? {
                    Some(reason) => Err(reason),
                    None => Ok(clearing),
                }
            }
        };
        match outcome {
            Err(reason) if may_extend => {
                // One extension, by a drawn length, before the cross gives up (ADR-0452).
                x.draw.ext_pending = true;
                ext::write(&info, &x)?;
                emit!(ExtensionPending {
                    cross: c.key(),
                    reason
                });
                return Ok(());
            }
            Err(reason) => {
                c.state = CrossState::NoPrint;
                c.no_print_reason = Some(reason);
            }
            Ok(clearing) => {
                c.state = CrossState::Cleared;
                c.clearing = Some(ClearingSummary::from_core(&clearing));
                if x.rules_set {
                    let (m, ub) = aux.marginal(&x, c, &clearing)?;
                    x.clearing = ext::ClearingExt {
                        class_qty: m.qty.map(|q| u64::try_from(q).unwrap_or(u64::MAX)),
                        tickets: m.tickets,
                        rho: m.rho,
                        cleared_ts: now,
                        insider_ub: u64::try_from(ub).unwrap_or(u64::MAX),
                    };
                    ext::write(&info, &x)?;
                }
                aux.on_print(c, &x, &clearing)?;
            }
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
    /// crank it; funds always go to the order owner. Closes the order account. A locked fill goes
    /// to the cross's lock vault; remaining accounts: the lock vault, then the lockup record.
    pub fn claim<'info>(ctx: Context<'info, Claim<'info>>) -> Result<()> {
        orders::claim(ctx)
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
        // The deadline splits time in two (ADR-0026): `abandon_settlement` runs from it on, so a bind may only
        // run before it. Otherwise the outcome would depend on which transaction landed first.
        require!(
            Clock::get()?.unix_timestamp < c.settle_deadline_ts,
            CrossError::SettlementDeadlinePassed
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
    pub fn finalize<'info>(ctx: Context<'info, Finalize<'info>>) -> Result<()> {
        let c = &mut ctx.accounts.cross;
        require!(
            c.state == CrossState::Cleared || c.state == CrossState::NoPrint,
            CrossError::WrongState
        );
        require!(c.orders_open == 0, CrossError::OrdersOutstanding);
        let x = ext::read(&c.to_account_info())?;
        if c.state == CrossState::Cleared && x.neutrality.bond_quote > 0 {
            // The insider bond is released with the proceeds only after its challenge window.
            let closes = x
                .clearing
                .cleared_ts
                .saturating_add(i64::from(x.neutrality.challenge_secs));
            require!(
                Clock::get()?.unix_timestamp >= closes && x.neutral_state.open_challenges == 0,
                CrossError::ChallengesOutstanding
            );
        }
        // Escrow mode: rationing leaves `base_sold - base_bought` base atoms in the vault, which belong to
        // `proceeds_to` (ADR-0025). A call that omits the accounts to sweep them is refused rather than
        // finalizing and stranding them. A cross without dust may still omit them.
        if c.supply_mode == SupplyMode::Escrow && c.base_sold > c.base_bought {
            require!(
                ctx.accounts.base_vault.is_some()
                    && ctx.accounts.base_mint.is_some()
                    && ctx.accounts.proceeds_base.is_some(),
                CrossError::BaseDustAccountsMissing
            );
        }
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
        // A referral is paid out of the protocol's fee and nothing else (ADR-0460).
        let referral = if x.referral.share_bps > 0 && protocol_fee > 0 {
            mul_div(protocol_fee, u64::from(x.referral.share_bps), BPS)?
        } else {
            0
        };
        if referral > 0 {
            let to = ctx
                .remaining_accounts
                .first()
                .ok_or(CrossError::ReferralAccountMissing)?;
            let acc = InterfaceAccount::<TokenAccount>::try_from(to)
                .map_err(|_| CrossError::ReferralAccountMissing)?;
            require!(
                acc.mint == c.quote_mint && acc.owner == x.referral.referrer,
                CrossError::ReferralAccountMissing
            );
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.quote_token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.quote_vault.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: to.clone(),
                        authority: cross_info.clone(),
                    },
                    &[seeds],
                ),
                referral,
                ctx.accounts.quote_mint.decimals,
            )?;
        }
        let protocol_to_recipient = protocol_fee
            .checked_sub(referral)
            .ok_or(CrossError::Overflow)?;
        if protocol_to_recipient > 0 {
            transfer_signed(
                &ctx.accounts.quote_vault,
                &ctx.accounts.fee_recipient_quote,
                &ctx.accounts.quote_mint,
                &ctx.accounts.quote_token_program,
                &cross_info,
                seeds,
                protocol_to_recipient,
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

/// Accounts a rule-bearing cross needs at the clear, taken from the remaining accounts in the order
/// the stored rules define (ADR-0450). A missing or wrong account is an error, never a skipped rule.
struct ClearAux<'info> {
    halt: Option<&'info AccountInfo<'info>>,
    mint: Option<&'info AccountInfo<'info>>,
    class_book: Option<&'info AccountInfo<'info>>,
    feed: Option<&'info AccountInfo<'info>>,
    /// The extra oracle accounts (ADR-0459), in the order of `oracle_set.extra_feeds`.
    oracles: Vec<&'info AccountInfo<'info>>,
    /// The cross's calendar, when the oracle band widens outside its sessions.
    calendar: Option<&'info AccountInfo<'info>>,
}

impl<'info> ClearAux<'info> {
    fn parse(
        x: &ext::CrossExt,
        c: &Account<Cross>,
        remaining: &'info [AccountInfo<'info>],
    ) -> Result<Self> {
        let mut it = remaining.iter();
        let mut aux = ClearAux {
            halt: None,
            mint: None,
            class_book: None,
            feed: None,
            oracles: Vec::new(),
            calendar: None,
        };
        if let Some(h) = x.guards.halt_source {
            let acc = it.next().ok_or(CrossError::HaltMismatch)?;
            require_keys_eq!(acc.key(), h, CrossError::HaltMismatch);
            aux.halt = Some(acc);
        }
        if x.reads_mint_at_clear() {
            let acc = it.next().ok_or(CrossError::WrongMint)?;
            require_keys_eq!(acc.key(), c.base_mint, CrossError::WrongMint);
            aux.mint = Some(acc);
        }
        if x.uses_class_book() {
            aux.class_book = Some(it.next().ok_or(CrossError::ClassBookMissing)?);
        }
        if x.has(ext::FLAG_FEEDS_LENDERS) {
            aux.feed = Some(it.next().ok_or(CrossError::FeedMismatch)?);
        }
        for _ in 0..x.oracle_set.extra_count {
            aux.oracles
                .push(it.next().ok_or(CrossError::OracleAccountMissing)?);
        }
        if x.oracle_set.off_hours_widen_bps > 0 {
            let acc = it.next().ok_or(CrossError::CalendarMismatch)?;
            require_keys_eq!(
                acc.key(),
                c.calendar.ok_or(CrossError::CalendarMismatch)?,
                CrossError::CalendarMismatch
            );
            aux.calendar = Some(acc);
        }
        Ok(aux)
    }

    /// The class tallies at the clearing tick, the lottery start, and an upper bound on what
    /// declared insiders were allocated (ADR-0453, ADR-0454).
    fn marginal(
        &self,
        x: &ext::CrossExt,
        c: &Account<Cross>,
        cl: &clearing_core::Clearing,
    ) -> Result<(clearing_core::Marginal, u128)> {
        let Some(cb) = self.class_book else {
            return Ok((clearing_core::Marginal::default(), 0));
        };
        let loader = classbook::loader(cb, &c.key())?;
        let book = loader.load()?;
        let t = c.tick_index(cl.price).ok_or(CrossError::OffGrid)?;
        let mut m = clearing_core::Marginal {
            qty: [
                u128::from(book.qty[0][t]),
                u128::from(book.qty[1][t]),
                u128::from(book.qty[2][t]),
            ],
            tickets: book.tickets[t],
            rho: 0,
        };
        if x.alloc.lottery_unit > 0 && m.tickets > 0 {
            let r = u64::from_le_bytes(
                x.draw.seed[16..24]
                    .try_into()
                    .map_err(|_| CrossError::Overflow)?,
            )
            .checked_rem(u64::from(m.tickets))
            .ok_or(CrossError::Overflow)?;
            m.rho = u32::try_from(r).map_err(|_| CrossError::Overflow)?;
        }
        let ub = if x.neutrality.insider_count > 0 {
            let better = book
                .insider_qty
                .iter()
                .skip(t.saturating_add(1))
                .take(usize::from(c.ticks))
                .fold(0u128, |a, q| a.saturating_add(u128::from(*q)));
            clearing_core::class0_fill_upper_bound(
                better,
                u128::from(book.insider_qty[t]),
                cl,
                &x.policy(),
                &m,
            )
        } else {
            0
        };
        Ok((m, ub))
    }

    /// Declared supply, else the base mint's current supply.
    fn total_supply(&self, x: &ext::CrossExt) -> Result<u64> {
        if x.guards.total_supply > 0 {
            return Ok(x.guards.total_supply);
        }
        let Some(m) = self.mint else { return Ok(0) };
        let d = m.try_borrow_data()?;
        // SPL and Token-2022 mints share the base layout: the supply follows the mint authority.
        Ok(d.get(36..44)
            .and_then(|b| <[u8; 8]>::try_from(b).ok())
            .map_or(0, u64::from_le_bytes))
    }

    /// After a print: a resume cross lifts the halt; a publisher's sufficiently large print moves
    /// the lender feed.
    fn on_print(
        &self,
        c: &Account<Cross>,
        x: &ext::CrossExt,
        cl: &clearing_core::Clearing,
    ) -> Result<()> {
        let clock = Clock::get()?;
        if let (Some(acc), true) = (self.halt, x.has(ext::FLAG_RESUMES_HALT)) {
            let mut h = halt::load(acc, &c.base_mint)?;
            h.resume(c.key(), cl.price, clock.unix_timestamp);
            halt::store(acc, &h)?;
            emit!(HaltChanged {
                base_mint: c.base_mint,
                halted: false,
                reason: HaltReason::None
            });
        }
        if let Some(acc) = self.feed {
            let mut f = feed::load(acc, &c.base_mint, &c.quote_mint)?;
            if f.accepts(&c.creator, cl.matched) {
                f.price = cl.price;
                f.price_scale = c.price_scale;
                f.matched = u64::try_from(cl.matched).unwrap_or(u64::MAX);
                f.cross = c.key();
                f.ts = clock.unix_timestamp;
                f.slot = clock.slot;
                f.prints = f.prints.saturating_add(1);
                feed::store(acc, &f)?;
                emit!(PrintFed {
                    base_mint: c.base_mint,
                    cross: c.key(),
                    price: cl.price,
                    matched: f.matched
                });
            }
        }
        Ok(())
    }
}

/// Every guard on a cleared cross, in a fixed order: the pure guards (recomputable from the book
/// by the verifier), then the state of the world (pause, halt, corporate action), then the
/// oracle. `Ok(None)` means the cross prints.
fn print_verdict(
    c: &Account<Cross>,
    x: &ext::CrossExt,
    aux: &ClearAux,
    clearing: &clearing_core::Clearing,
    oracle_account: Option<&UncheckedAccount>,
) -> Result<Option<NoPrintReason>> {
    use clearing_core::PrintFailure as F;
    let base = clearing_core::PrintGuards {
        min_matched: u128::from(c.min_matched),
        max_imbalance_bps: c.max_imbalance_bps,
    };
    let raise = clearing_core::RaiseGuards {
        min_raise_quote: u128::from(x.guards.min_raise_quote),
        price_scale: c.price_scale,
        total_supply: u128::from(aux.total_supply(x)?),
        min_float_bps: u32::from(x.guards.min_float_bps),
        max_fdv_x100: u64::from(x.guards.max_fdv_x100),
        anchor_price: x.guards.anchor_price,
        move_bps: u32::from(x.guards.move_bps),
    };
    // Declared insiders' allocation does not count toward the minimum raise or the float.
    let (_, insider_ub) = aux.marginal(x, c, clearing)?;
    let counted = clearing.matched.saturating_sub(insider_ub);
    if let Err(f) = clearing_core::check_all(&base, &raise, clearing, counted) {
        return Ok(Some(match f {
            F::BelowMinimumVolume => NoPrintReason::BelowMinimumVolume,
            F::ImbalanceTooHigh => NoPrintReason::ImbalanceTooHigh,
            F::BelowMinimumRaise => NoPrintReason::BelowMinimumRaise,
            F::FloatTooLow => NoPrintReason::FloatTooLow,
            F::FdvTooHigh => NoPrintReason::FdvTooHigh,
            F::PriceMoved => NoPrintReason::PriceMoved,
        }));
    }
    // A split or a dividend changes the mint's multiplier: the grid was drawn for the old one.
    if x.has(ext::FLAG_GUARD_SCALED_UI) {
        let mint = aux.mint.ok_or(CrossError::WrongMint)?;
        let now = Clock::get()?.unix_timestamp;
        let current = halt::scaled_ui_multiplier(&mint.try_borrow_data()?, now);
        if current != Some(x.guards.multiplier_bits) {
            return Ok(Some(NoPrintReason::CorporateAction));
        }
    }
    if let Some(acc) = aux.halt {
        let paused = aux.mint.is_some_and(|m| {
            m.try_borrow_data()
                .map(|d| halt::mint_is_paused(&d))
                .unwrap_or(false)
        });
        if paused {
            return Ok(Some(NoPrintReason::IssuerPaused));
        }
        let h = halt::load(acc, &c.base_mint)?;
        if !x.has(ext::FLAG_RESUMES_HALT) {
            if h.corporate_action {
                return Ok(Some(NoPrintReason::CorporateAction));
            }
            if h.halted {
                return Ok(Some(NoPrintReason::Halted));
            }
        }
    }
    oracle_verdict(c, x, aux, oracle_account, clearing.price)
}

/// One oracle's price in the cross's units, or `None` when the account is not a fresh, fully verified Pyth update for
/// the feed it is supposed to carry.
fn oracle_reference(
    c: &Cross,
    account: &AccountInfo,
    feed_id: &[u8; 32],
    max_staleness_secs: u32,
    now: i64,
) -> Option<u128> {
    if !oracle::is_pyth_receiver(account.owner) {
        return None;
    }
    let data = account.try_borrow_data().ok()?;
    let o = oracle::parse_price_update(&data)?;
    let fresh = now.saturating_sub(o.publish_time) <= i64::from(max_staleness_secs);
    if &o.feed_id != feed_id || !o.fully_verified || !fresh {
        return None;
    }
    oracle::to_cross_units(&o, c.quote_decimals, c.base_decimals, c.price_scale)
}

/// The median of one to three prices; of two, their mean (rounded down).
fn median(values: &mut [u128]) -> Option<u128> {
    values.sort_unstable();
    match values {
        [] => None,
        [a] => Some(*a),
        [a, b] => a.checked_add(*b).map(|s| s / 2),
        [_, m, _] => Some(*m),
        _ => None,
    }
}

/// Applies the oracle guard, if any. `Ok(Some(reason))` means the cross must not print. With extra feeds
/// (ADR-0459) the reference is the median of the usable prices, the guard needs its quorum of them, and outside the
/// calendar's sessions the bound is wider; with none this is the single-feed guard of ADR-0005, unchanged.
fn oracle_verdict(
    c: &Cross,
    x: &ext::CrossExt,
    aux: &ClearAux,
    account: Option<&UncheckedAccount>,
    price: u64,
) -> Result<Option<NoPrintReason>> {
    let Some(g) = c.oracle else { return Ok(None) };
    let account = account.ok_or(CrossError::OracleAccountMissing)?;
    let now = Clock::get()?.unix_timestamp;
    let os = &x.oracle_set;
    let mut prices: Vec<u128> = Vec::with_capacity(3);
    if let Some(p) = oracle_reference(c, account, &g.feed_id, g.max_staleness_secs, now) {
        prices.push(p);
    }
    for (i, acc) in aux.oracles.iter().enumerate() {
        let feed = os.extra_feeds.get(i).ok_or(CrossError::InvalidParams)?;
        if let Some(p) = oracle_reference(c, acc, feed, g.max_staleness_secs, now) {
            prices.push(p);
        }
    }
    let quorum = usize::from(os.quorum.max(1));
    if prices.len() < quorum {
        return Ok(Some(NoPrintReason::OracleUnavailable));
    }
    if os.max_spread_bps > 0 && prices.len() >= 2 {
        let lo = prices.iter().copied().min().unwrap_or(0);
        let hi = prices.iter().copied().max().unwrap_or(0);
        let wide = hi.saturating_sub(lo).saturating_mul(10_000)
            > lo.saturating_mul(u128::from(os.max_spread_bps));
        if wide {
            return Ok(Some(NoPrintReason::OracleDisagreement));
        }
    }
    let Some(reference) = median(&mut prices) else {
        return Ok(Some(NoPrintReason::OracleUnavailable));
    };
    let mut bound = g.max_divergence_bps;
    if let Some(cal) = aux.calendar {
        let data = cal.try_borrow_data()?;
        require_keys_eq!(*cal.owner, cross_calendar::ID, CrossError::CalendarMismatch);
        let calendar = cross_calendar::Calendar::try_deserialize(&mut &data[..])?;
        let open = calendar
            .sessions
            .iter()
            .any(|s| s.start_ts <= now && now < s.end_ts);
        if !open {
            bound = bound.saturating_add(os.off_hours_widen_bps);
        }
    }
    Ok(oracle::diverges(price, reference, bound).then_some(NoPrintReason::OracleDivergence))
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

/// The shard an order's per-tick quantity lives in: `sha256(owner ‖ nonce)` read as a little-endian `u32`, modulo
/// the number of shards. It depends only on what the order's owner already knows, so concurrent bidders never race
/// for a shard (an arrival-order rule changes with every order that lands first), and cancel and reveal find the
/// same shard again from the stored owner and nonce.
pub fn shard_of(owner: &Pubkey, nonce: u64, shards: u8) -> usize {
    let h = solana_sha256_hasher::hashv(&[owner.as_ref(), &nonce.to_le_bytes()]).to_bytes();
    (u32::from_le_bytes([h[0], h[1], h[2], h[3]]) % u32::from(shards.max(1))) as usize
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
pub struct MigrateProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: owner, address, discriminator and stored admin are checked in the handler (the
    /// account may not deserialize under the current layout, which is why it is migrated).
    #[account(mut)]
    pub protocol: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [PROTOCOL_SEED], bump = protocol.bump)]
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
    #[account(init, payer = creator, space = CROSS_SPACE, seeds = [CROSS_SEED, creator.key().as_ref(), &params.cross_id.to_le_bytes()], bump)]
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
pub struct AdminProposed {
    pub admin: Pubkey,
    pub proposed: Option<Pubkey>,
}

#[event]
pub struct AdminChanged {
    pub previous: Pubkey,
    pub admin: Pubkey,
}

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

#[event]
pub struct ExtensionPending {
    pub cross: Pubkey,
    pub reason: NoPrintReason,
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
    #[msg("This cross holds base dust: base_vault, base_mint and proceeds_base are required")]
    BaseDustAccountsMissing,
    #[msg("The settlement deadline has passed")]
    SettlementDeadlinePassed,
    #[msg("This cross was created before the extension tail existed and cannot take rules")]
    LegacyCross,
    #[msg("Rules can only be set by the creator, in the creating slot, before any order")]
    RulesLocked,
    #[msg("The halt state does not belong to this cross's base mint")]
    HaltMismatch,
    #[msg("The lender print feed does not belong to this cross's base mint")]
    FeedMismatch,
    #[msg("The price grid does not follow the standard policy")]
    GridPolicy,
    #[msg("A fresh, fully verified oracle update for the registered feed is required")]
    OracleUnavailable,
    #[msg("Orders can no longer be cancelled")]
    CancelClosed,
    #[msg("The draw for this cross has not been finished")]
    DrawRequired,
    #[msg("That ending bucket falls after the drawn end and never counts")]
    BucketExcluded,
    #[msg("The extension is waiting for its draw")]
    ExtensionPending,
    #[msg("A draw is already in flight")]
    DrawPending,
    #[msg("There is nothing to draw now")]
    NothingToDraw,
    #[msg("The block hashes needed for the draw are no longer available; begin the draw again")]
    DrawExpired,
    #[msg("The applicant record is missing or does not match")]
    ApplicantMismatch,
    #[msg("This identity has reached its order or escrow limit")]
    IdentityLimit,
    #[msg("The class book is missing or does not match")]
    ClassBookMissing,
    #[msg("The order does not qualify for the class it asked for")]
    ClassNotAllowed,
    #[msg("A lottery order must be exactly one lot")]
    LotSize,
    #[msg("The lock vault or lockup record is missing or does not match")]
    LockupMismatch,
    #[msg("Nothing has vested yet")]
    NothingToRelease,
    #[msg("The challenge window has closed")]
    ChallengeWindowClosed,
    #[msg("The challenge record does not match")]
    ChallengeMismatch,
    #[msg("Insider challenges are still open, or their window has not passed")]
    ChallengesOutstanding,
    #[msg("The series is paused or has spawned all its crosses")]
    SeriesInactive,
    #[msg("The previous cross of the series is missing or has not resolved")]
    SeriesPreviousMissing,
    #[msg("The next cross is not due yet")]
    SpawnTooEarly,
    #[msg("The calendar has no session ahead")]
    NoSessionAhead,
    #[msg("The referrer's quote token account is missing or does not match")]
    ReferralAccountMissing,
    #[msg("This order has a fill; claim it instead")]
    NotRefundOnly,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_median_of_one_two_and_three_prices() {
        assert_eq!(median(&mut []), None);
        assert_eq!(median(&mut [7]), Some(7));
        assert_eq!(median(&mut [9, 3]), Some(6));
        assert_eq!(median(&mut [10, 1, 5]), Some(5));
        // An outlier does not move the middle value.
        assert_eq!(median(&mut [1_000_000, 120, 121]), Some(121));
        // Rounding of the mean of two is down, and cannot overflow.
        assert_eq!(median(&mut [1, 2]), Some(1));
        assert_eq!(median(&mut [u128::MAX, u128::MAX]), None);
    }

    #[test]
    fn mul_div_rounds_down_and_refuses_overflow() {
        assert_eq!(mul_div(10, 3, 4).unwrap(), 7);
        assert!(mul_div(u64::MAX, u64::MAX, 1).is_err());
        assert!(mul_div(1, 1, 0).is_err());
    }
}
