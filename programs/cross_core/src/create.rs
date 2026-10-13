//! Cross creation shared by `create_cross` and `spawn_next` (ADR-0456): the validation, the field
//! assignment, the dust bond and the issuer's supply schedule. Moving the bond is left to the caller,
//! because who signs for it differs (the creator, or a series' own address).
use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::{ext, state::*, CreateCrossParams, CrossError};

/// Bump seeds of the accounts a cross creation initialises.
pub struct Bumps {
    pub cross: u8,
    pub quote_vault: u8,
    pub base_vault: Option<u8>,
    pub book: u8,
}

/// Everything creation needs from the accounts around it.
pub struct Setup<'a, 'info> {
    pub protocol: &'a Protocol,
    pub cross: &'a mut Account<'info, Cross>,
    pub book: &'a AccountLoader<'info, Levels>,
    pub creator: Pubkey,
    pub base_mint: Option<&'a InterfaceAccount<'info, Mint>>,
    pub has_base_vault: bool,
    pub quote_mint: &'a InterfaceAccount<'info, Mint>,
    pub base_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub calendar_account: Option<&'a AccountInfo<'info>>,
    pub bumps: Bumps,
}

/// Validates `params`, fills the cross and its book and returns the dust bond the creator owes.
pub fn populate(s: Setup, params: &CreateCrossParams) -> Result<u64> {
    let Setup {
        protocol,
        cross,
        book,
        creator,
        base_mint,
        has_base_vault,
        quote_mint,
        base_token_program,
        quote_token_program,
        calendar_account,
        bumps,
    } = s;
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
        deferred == base_mint.is_none() && deferred != has_base_vault,
        CrossError::InvalidParams
    );
    if let Some(base) = base_mint {
        require_keys_neq!(base.key(), quote_mint.key(), CrossError::InvalidParams);
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

    let cross_key = cross.key();
    let c = cross;
    c.creator = creator;
    c.cross_id = params.cross_id;
    c.kind = params.kind;
    c.supply_mode = params.supply_mode;
    c.disclosure = params.disclosure;
    c.state = CrossState::Live;
    c.base_mint = base_mint.map_or(Pubkey::default(), |m| m.key());
    c.quote_mint = quote_mint.key();
    c.base_token_program = base_token_program;
    c.quote_token_program = quote_token_program;
    c.base_decimals = base_mint.map_or(0, |m| m.decimals);
    c.quote_decimals = quote_mint.decimals;
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
    c.protocol_fee_bps = protocol.fee_bps[params.kind.index()].min(params.integrator_fee_bps / 4);
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
        let info = calendar_account.ok_or(CrossError::CalendarMismatch)?;
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
    c.bump = bumps.cross;
    c.quote_vault_bump = bumps.quote_vault;
    c.base_vault_bump = bumps.base_vault.unwrap_or_default();
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
    c.book_bump = bumps.book;
    ext::write(
        &c.to_account_info(),
        &ext::CrossExt {
            version: ext::EXT_VERSION,
            created_slot: Clock::get()?.slot,
            ..ext::CrossExt::default()
        },
    )?;

    if let Some(r) = params.reference_price {
        require!(c.tick_index(r).is_some(), CrossError::OffGrid);
    }
    let max_price = c.max_price().ok_or(CrossError::Overflow)?;
    // The dust bond must cover buying one atom per order at the highest grid price (ADR-0003).
    let bond =
        clearing_core::buyer_pays(u64::from(params.max_orders), max_price, params.price_scale)
            .ok_or(CrossError::Overflow)?;
    c.dust_bond = bond;

    let mut book = book.load_init()?;
    book.cross = cross_key;
    if params.supply_mode.mints() {
        require!(!params.schedule.is_empty(), CrossError::InvalidParams);
        if let Some(base) = base_mint {
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
    Ok(bond)
}
