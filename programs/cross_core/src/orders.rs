//! Order entry, cancellation, reveal and claim with the rules of a cross applied (ADR-0450 to
//! ADR-0454). The handlers in `lib.rs` delegate here. A cross without rules takes none of the new
//! branches: it reads one byte of its tail and behaves exactly as before.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, MintTo, TransferChecked};

use crate::{
    classbook,
    ext::{self, CrossExt, OrderExt},
    identity, lock,
    state::*,
    CancelOrder, Claim, CommitOrder, CommitOrderArgs, CrossError, OrderCancelled, OrderClaimed,
    OrderCommitted, OrderRevealed, RevealOrder,
};

/// What `commit_order_ext` adds to `commit_order`.
#[derive(Clone, Copy, Debug, Default)]
pub struct OrderExtra {
    /// Allocation class the buyer claims: 0 general, 1 identity-verified small, 2 locked,
    /// 3 priority. The program checks the claim against the cross's rules.
    pub class: u8,
    /// Class 2: seconds the fill stays locked.
    pub lock_secs: u32,
}

/// What the rules decide about one order.
#[derive(Clone, Copy, Debug, Default)]
struct Admission {
    class: u8,
    flags: u8,
    lock_cliff: u32,
    lock_vest: u32,
}

/// The extra accounts a rule-bearing cross needs for an order, taken from the remaining accounts in
/// a fixed order: the applicant record (identity limits), the class book (classes and insiders),
/// then the priority pass when the order claims class 3 without the early window.
struct RuleAccounts<'info> {
    applicant: Option<&'info AccountInfo<'info>>,
    class_book: Option<&'info AccountInfo<'info>>,
    priority_pass: Option<&'info AccountInfo<'info>>,
}

impl<'info> RuleAccounts<'info> {
    fn parse(
        x: &CrossExt,
        class: u8,
        now: i64,
        remaining: &'info [AccountInfo<'info>],
    ) -> Result<Self> {
        let mut it = remaining.iter();
        let applicant = if x.uses_identity() {
            Some(it.next().ok_or(CrossError::ApplicantMismatch)?)
        } else {
            None
        };
        let class_book = if x.uses_class_book() {
            Some(it.next().ok_or(CrossError::ClassBookMissing)?)
        } else {
            None
        };
        let early = x.alloc.early_until_ts > 0 && now < x.alloc.early_until_ts;
        let priority_pass = if class == 3 && x.alloc.priority_gate.is_some() && !early {
            Some(it.next().ok_or(CrossError::NotEligible)?)
        } else {
            None
        };
        Ok(Self {
            applicant,
            class_book,
            priority_pass,
        })
    }
}

/// Whether `pass` is the `cross_gate` pass of `owner` for `gate_mint`.
pub fn holds_pass(pass: &AccountInfo, gate_mint: &Pubkey, owner: &Pubkey) -> bool {
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

/// Applies the cross's rules to one order: its class, its lock and its insider flag.
#[allow(clippy::too_many_arguments)]
fn admit(
    x: &CrossExt,
    c: &Cross,
    owner: &Pubkey,
    side: OrderSide,
    escrow: u64,
    now: i64,
    extra: &OrderExtra,
    priority_pass_ok: bool,
) -> Result<Admission> {
    let a = &x.alloc;
    if side == OrderSide::Sell {
        require!(
            extra.class == 0 && extra.lock_secs == 0,
            CrossError::ClassNotAllowed
        );
        return Ok(Admission::default());
    }
    if x.is_insider(owner) {
        // A declared insider takes no class: its fill is locked and left out of the raise.
        require!(
            extra.class == 0 && extra.lock_secs == 0,
            CrossError::ClassNotAllowed
        );
        return Ok(Admission {
            flags: ext::ORDER_INSIDER,
            lock_cliff: x.neutrality.insider_cliff_secs,
            lock_vest: x.neutrality.insider_vest_secs,
            ..Admission::default()
        });
    }
    match extra.class {
        0 => {
            require!(extra.lock_secs == 0, CrossError::ClassNotAllowed);
            Ok(Admission::default())
        }
        1 => {
            // Identity-verified small orders: the gate pass was checked at the top of the commit.
            require!(
                a.small_cap_quote > 0
                    && escrow <= a.small_cap_quote
                    && c.gate_mint.is_some()
                    && extra.lock_secs == 0,
                CrossError::ClassNotAllowed
            );
            Ok(Admission {
                class: 1,
                lock_cliff: a.class1_cliff_secs,
                lock_vest: a.class1_vest_secs,
                ..Admission::default()
            })
        }
        2 => {
            require!(
                a.min_lock_secs > 0
                    && extra.lock_secs >= a.min_lock_secs
                    && extra.lock_secs <= lock::MAX_LOCK_SECS,
                CrossError::ClassNotAllowed
            );
            Ok(Admission {
                class: 2,
                lock_cliff: extra.lock_secs,
                lock_vest: a.lock_vest_secs,
                ..Admission::default()
            })
        }
        3 => {
            let early = a.early_until_ts > 0 && now < a.early_until_ts;
            require!(
                extra.lock_secs == 0 && (early || priority_pass_ok),
                CrossError::ClassNotAllowed
            );
            Ok(Admission {
                class: 3,
                ..Admission::default()
            })
        }
        _ => err!(CrossError::ClassNotAllowed),
    }
}

/// A class-1 order in a lottery cross is exactly one lot.
fn check_lot(x: &CrossExt, class: u8, quantity: u64) -> Result<()> {
    if class == 1 && x.alloc.lottery_unit > 0 {
        require!(quantity == x.alloc.lottery_unit, CrossError::LotSize);
    }
    Ok(())
}

pub fn commit<'info>(
    ctx: Context<'info, CommitOrder<'info>>,
    args: CommitOrderArgs,
    extra: OrderExtra,
) -> Result<()> {
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
    let x = ext::read(&c.to_account_info())?;
    if side == OrderSide::Sell {
        require!(!c.supply_mode.mints(), CrossError::SellsNotAccepted);
    }
    let (epoch, bucket) = x.placement(c.close_ts, now);
    let owner_key = ctx.accounts.owner.key();
    if let Some(gate_mint) = c.gate_mint {
        require!(
            crate::holds_gate_pass(ctx.accounts.pass.as_ref(), &gate_mint, &owner_key),
            CrossError::NotEligible
        );
    }
    let rules = RuleAccounts::parse(&x, extra.class, now, ctx.remaining_accounts)?;
    let priority_ok = match (rules.priority_pass, x.alloc.priority_gate) {
        (Some(p), Some(g)) => holds_pass(p, &g, &owner_key),
        _ => false,
    };
    let adm = admit(&x, c, &owner_key, side, escrow, now, &extra, priority_ok)?;
    if let Some(a) = rules.applicant {
        identity::on_commit(
            &x,
            &c.key(),
            &ctx.accounts.owner.to_account_info(),
            a,
            &ctx.accounts.system_program.to_account_info(),
            side,
            escrow,
        )?;
    }

    let index = c.orders_total;
    let cross_key = c.key();
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
    let space = ext::ORDER_BODY
        + if x.order_tail() {
            ext::ORDER_EXT_SPACE
        } else {
            0
        };
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
    let mut ticket = 0;
    match c.disclosure {
        Disclosure::Sealed => {
            o.commitment = commitment;
        }
        Disclosure::Open => {
            crate::validate_order(c, side, price, quantity, escrow)?;
            let shard_ix = x.shard_index(c, &owner_key, nonce, epoch, bucket);
            let shard_acc = ctx
                .accounts
                .shard
                .as_ref()
                .ok_or(CrossError::ShardMissing)?;
            let mut shard = shard_acc.load_mut()?;
            require!(
                shard.index == shard_ix && shard.cross == cross_key,
                CrossError::WrongShard
            );
            let tick = c.tick_index(price).ok_or(CrossError::OffGrid)?;
            shard.add(side, tick, quantity)?;
            if let (Some(cb), OrderSide::Buy) = (rules.class_book, side) {
                check_lot(&x, adm.class, quantity)?;
                let loader = classbook::loader(cb, &cross_key)?;
                ticket = loader.load_mut()?.add(
                    adm.class,
                    adm.flags & ext::ORDER_INSIDER != 0,
                    tick,
                    quantity,
                )?;
            }
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
    if x.order_tail() {
        let placement = OrderExt {
            version: ext::EXT_VERSION,
            epoch,
            bucket,
            class: adm.class,
            flags: adm.flags,
            lock_cliff: adm.lock_cliff,
            lock_vest: adm.lock_vest,
            placed_ts: now,
            ticket,
        };
        ext::write_order(&ctx.accounts.order.to_account_info(), &placement)?;
        emit!(OrderPlacement {
            cross: cross_key,
            order: ctx.accounts.order.key(),
            ext: placement
        });
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

pub fn cancel<'info>(ctx: Context<'info, CancelOrder<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &mut ctx.accounts.cross;
    require!(
        c.state == CrossState::Live && now < c.close_ts,
        CrossError::NotInCallWindow
    );
    let x = ext::read(&c.to_account_info())?;
    let ox = if x.order_tail() {
        ext::read_order(&ctx.accounts.order.to_account_info())?
    } else {
        OrderExt::default()
    };
    if x.ending.ending_secs > 0 || x.ending.cancel_cutoff_secs > 0 || x.draw.epoch > 0 {
        // An order placed in the ending period, after the cutoff or in the extension stays
        // (ADR-0452); it is still refunded in full if the draw leaves its bucket out.
        require!(
            now < x.cancel_deadline(c.close_ts)
                && x.draw.epoch == 0
                && ox.epoch == 0
                && ox.bucket == ext::NO_BUCKET,
            CrossError::CancelClosed
        );
    }
    // A lottery ticket cannot be withdrawn: the draw needs every number to be a live order.
    require!(
        !(x.alloc.lottery_unit > 0 && ox.class == 1),
        CrossError::CancelClosed
    );
    let o = &ctx.accounts.order;
    let mut remaining = ctx.remaining_accounts.iter();
    if x.uses_identity() {
        let a = remaining.next().ok_or(CrossError::ApplicantMismatch)?;
        identity::on_cancel(&c.key(), &o.owner, a, o.side, o.escrow)?;
    }
    let mut class_book = None;
    if o.state == OrderState::Revealed && x.uses_class_book() && o.side == OrderSide::Buy {
        class_book = Some(remaining.next().ok_or(CrossError::ClassBookMissing)?);
    }
    if o.state == OrderState::Revealed {
        let shard_acc = ctx
            .accounts
            .shard
            .as_ref()
            .ok_or(CrossError::ShardMissing)?;
        let mut shard = shard_acc.load_mut()?;
        let shard_ix = x.shard_index(c, &o.owner, o.nonce, ox.epoch, ox.bucket);
        require!(
            shard.index == shard_ix && shard.cross == c.key(),
            CrossError::WrongShard
        );
        let tick = c.tick_index(o.price).ok_or(CrossError::OffGrid)?;
        shard.remove(o.side, tick, o.quantity)?;
        if let Some(cb) = class_book {
            classbook::loader(cb, &c.key())?.load_mut()?.remove(
                ox.class,
                ox.is_insider(),
                tick,
                o.quantity,
            )?;
        }
    }
    c.orders_open = c.orders_open.checked_sub(1).ok_or(CrossError::Overflow)?;
    let (creator, id, bump) = (c.creator, c.cross_id.to_le_bytes(), [c.bump]);
    let seeds: &[&[u8]] = &[CROSS_SEED, creator.as_ref(), &id, &bump];
    let cross_info = c.to_account_info();
    match o.side {
        OrderSide::Buy => crate::transfer_signed(
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
        OrderSide::Sell => crate::transfer_signed(
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

pub fn reveal<'info>(
    ctx: Context<'info, RevealOrder<'info>>,
    price: u64,
    quantity: u64,
    salt: [u8; 32],
) -> Result<()> {
    let c = &ctx.accounts.cross;
    let o = &mut ctx.accounts.order;
    let shard_acc = &ctx.accounts.shard;
    let remaining_accounts = ctx.remaining_accounts;
    let now = Clock::get()?.unix_timestamp;
    require!(c.disclosure == Disclosure::Sealed, CrossError::NotSealed);
    require!(
        c.state == CrossState::Live && now >= c.close_ts && now < c.reveal_end_ts,
        CrossError::NotInRevealWindow
    );
    require!(
        o.state == OrderState::Committed,
        CrossError::AlreadyRevealed
    );
    require!(
        crate::commitment_of(&c.key(), &o.owner, o.nonce, o.side, price, quantity, &salt)
            == o.commitment,
        CrossError::CommitmentMismatch
    );
    crate::validate_order(c, o.side, price, quantity, o.escrow)?;
    let x = ext::read(&c.to_account_info())?;
    let mut ox = if x.order_tail() {
        ext::read_order(&o.to_account_info())?
    } else {
        OrderExt::default()
    };
    // An order from an earlier window cannot reveal into a later one.
    require!(ox.epoch == x.draw.epoch, CrossError::NotInRevealWindow);
    let tick = c.tick_index(price).ok_or(CrossError::OffGrid)?;
    if x.uses_class_book() && o.side == OrderSide::Buy {
        let cb = remaining_accounts
            .first()
            .ok_or(CrossError::ClassBookMissing)?;
        check_lot(&x, ox.class, quantity)?;
        ox.ticket = classbook::loader(cb, &c.key())?.load_mut()?.add(
            ox.class,
            ox.is_insider(),
            tick,
            quantity,
        )?;
        ext::write_order(&o.to_account_info(), &ox)?;
    }
    let mut shard = shard_acc.load_mut()?;
    let shard_ix = x.shard_index(c, &o.owner, o.nonce, ox.epoch, ox.bucket);
    require!(
        shard.index == shard_ix && shard.cross == c.key(),
        CrossError::WrongShard
    );
    shard.add(o.side, tick, quantity)?;
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

/// What one order is owed at settlement, computed from the clearing summary alone (ADR-0003).
#[derive(Clone, Copy, Debug, Default)]
pub struct Outcome {
    pub fill: u64,
    pub quote_out: u64,
    pub base_out: u64,
    pub fee: u64,
    /// Buys: quote the fill costs. Sells: gross quote the fill brings in.
    pub notional: u64,
}

/// The fill, the payouts and the fee of one order. A cross that did not print, an order that was never revealed
/// and one the draw left out are refunded in full.
pub fn outcome(c: &Cross, x: &CrossExt, o: &Order, ox: &OrderExt) -> Result<Outcome> {
    let summary = match (c.state, o.state) {
        (CrossState::Cleared, OrderState::Revealed) if !x.excludes(ox) => c.clearing,
        _ => None,
    };
    let Some(s) = summary else {
        return Ok(match o.side {
            OrderSide::Buy => Outcome {
                quote_out: o.escrow,
                ..Outcome::default()
            },
            OrderSide::Sell => Outcome {
                base_out: o.escrow,
                ..Outcome::default()
            },
        });
    };
    let clearing = s.to_core();
    let fill = if x.uses_class_book() || !x.alloc.reserve_bps.iter().all(|b| *b == 0) {
        let m = clearing_core::Marginal {
            qty: x.clearing.class_qty.map(u128::from),
            tickets: x.clearing.tickets,
            rho: x.clearing.rho,
        };
        clearing_core::fill_with_policy(
            o.side.into(),
            o.price,
            o.quantity,
            ox.class,
            ox.ticket,
            &clearing,
            &x.policy(),
            &m,
        )
    } else {
        clearing_core::fill(o.side.into(), o.price, o.quantity, &clearing)
    };
    Ok(match o.side {
        OrderSide::Buy => {
            let pay = clearing_core::buyer_pays(fill, s.price, c.price_scale)
                .ok_or(CrossError::Overflow)?;
            Outcome {
                fill,
                quote_out: o.escrow.checked_sub(pay).ok_or(CrossError::Overflow)?,
                base_out: fill,
                fee: 0,
                notional: pay,
            }
        }
        OrderSide::Sell => {
            let gross = clearing_core::seller_receives(fill, s.price, c.price_scale)
                .ok_or(CrossError::Overflow)?;
            let fee = crate::mul_bps(gross, c.total_fee_bps())?;
            Outcome {
                fill,
                quote_out: gross.checked_sub(fee).ok_or(CrossError::Overflow)?,
                base_out: o.escrow.checked_sub(fill).ok_or(CrossError::Overflow)?,
                fee,
                notional: gross,
            }
        }
    })
}

/// Adds a settled order to the cross's running totals.
fn record(c: &mut Cross, o: &Order, out: &Outcome) -> Result<()> {
    if out.fill == 0 {
        return Ok(());
    }
    match o.side {
        OrderSide::Buy => {
            c.buyer_paid = c
                .buyer_paid
                .checked_add(out.notional)
                .ok_or(CrossError::Overflow)?;
            c.base_bought = c
                .base_bought
                .checked_add(out.fill)
                .ok_or(CrossError::Overflow)?;
        }
        OrderSide::Sell => {
            c.base_sold = c
                .base_sold
                .checked_add(out.fill)
                .ok_or(CrossError::Overflow)?;
            c.seller_paid = c
                .seller_paid
                .checked_add(out.notional)
                .ok_or(CrossError::Overflow)?;
            c.fees_accrued = c
                .fees_accrued
                .checked_add(out.fee)
                .ok_or(CrossError::Overflow)?;
        }
    }
    Ok(())
}

pub fn claim<'info>(ctx: Context<'info, Claim<'info>>) -> Result<()> {
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
    let x = ext::read(&cross_info)?;
    let ox = if x.order_tail() {
        ext::read_order(&o.to_account_info())?
    } else {
        OrderExt::default()
    };
    let out = outcome(c, &x, o, &ox)?;
    record(c, o, &out)?;
    let Outcome {
        fill,
        quote_out,
        base_out,
        fee,
        ..
    } = out;

    // Remaining accounts, only for a locked fill: the lock vault and the lockup record. A refund needs none,
    // so a client that knows nothing of locks can always collect one (ADR-0454).
    let mut rem = ctx.remaining_accounts.iter();
    let lock_accs = if fill > 0 && o.side == OrderSide::Buy && ox.locked() {
        Some((
            rem.next().ok_or(CrossError::LockupMismatch)?,
            rem.next().ok_or(CrossError::LockupMismatch)?,
        ))
    } else {
        None
    };
    if quote_out > 0 {
        crate::transfer_signed(
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
        let locked = fill > 0 && lock_accs.is_some();
        if let (true, Some((vault, lockup))) = (locked, lock_accs) {
            // The fill goes to the cross's lock vault and a lockup record says when it is the
            // owner's to take (ADR-0454).
            require_keys_eq!(
                vault.key(),
                lock::lock_vault_address(&c.key()),
                CrossError::LockupMismatch
            );
            if c.supply_mode.mints() {
                token_interface::mint_to(
                    CpiContext::new_with_signer(
                        ctx.accounts.base_token_program.key(),
                        MintTo {
                            mint: base_mint.to_account_info(),
                            to: vault.clone(),
                            authority: cross_info.clone(),
                        },
                        &[seeds],
                    ),
                    base_out,
                )?;
            } else {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.base_token_program.key(),
                        TransferChecked {
                            from: ctx
                                .accounts
                                .base_vault
                                .as_ref()
                                .ok_or(CrossError::TokenAccountMissing)?
                                .to_account_info(),
                            mint: base_mint.to_account_info(),
                            to: vault.clone(),
                            authority: cross_info.clone(),
                        },
                        &[seeds],
                    ),
                    base_out,
                    base_mint.decimals,
                )?;
            }
            lock::open_lockup(
                lockup,
                &o.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &c.key(),
                &o.owner,
                o.nonce,
                base_out,
                x.clearing.cleared_ts,
                ox.lock_cliff,
                ox.lock_vest,
            )?;
            emit!(lock::LockCreated {
                cross: c.key(),
                owner: o.owner,
                amount: base_out,
                start_ts: x.clearing.cleared_ts,
                cliff_secs: ox.lock_cliff,
                vest_secs: ox.lock_vest
            });
        } else {
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
                crate::transfer_signed(
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

/// An order's placement and what it asked for, emitted when the cross keeps an order extension.
#[event]
pub struct OrderPlacement {
    pub cross: Pubkey,
    pub order: Pubkey,
    pub ext: OrderExt,
}
