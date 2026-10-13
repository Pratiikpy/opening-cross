//! Recurring crosses (ADR-0456, PRODUCT_FEATURES Y1): a series spawns the next cross in a schedule by
//! itself.
//!
//! A `Series` holds the template of a cross and where its schedule comes from: a fixed interval, or the
//! session starts of a `cross_calendar`. Anyone may call `spawn_next` when the next cross is due; the
//! program computes the close time, the grid (fixed, or re-centred on the last print) and the call
//! window, creates the cross with the series' own address as its creator, applies the series' rules in
//! the same instruction and posts the dust bond from the series' funds. Crosses run one at a time: the
//! next is spawned only once the previous has cleared or failed.
//!
//! The recurring flows are compositions of the same cross: an ownership coin's secondary trading is a
//! series of escrow crosses; a treasury buyback is the treasury program signing buy orders into each
//! cross; a holder exit is holders' sells; a liquidation is the treasury's inventory sold into the next
//! cross. None needs a different mechanism, only a schedule that does not depend on a person.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{
    create,
    ext::CROSS_SPACE,
    rules::{self, RulesInput},
    state::*,
    CreateCrossParams, CrossError,
};

pub const SERIES_SEED: &[u8] = b"series";
/// A cross is spawned at most this long before it opens, so a series does not lock rent in crosses
/// that are weeks away.
pub const SPAWN_LEAD_SECS: i64 = 24 * 60 * 60;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct SeriesGrid {
    /// A grid re-centred on the last print each time, instead of the fixed one.
    pub relative: bool,
    /// Fixed grid.
    pub min_price: u64,
    pub tick: u64,
    pub ticks: u16,
    /// Relative grid: tick size as basis points of the centre (`ticks` of them, centred).
    pub tick_bps: u16,
    /// Relative grid: the centre of the first cross, before any print exists.
    pub center: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct SeriesConfig {
    pub kind: CrossKind,
    pub disclosure: Disclosure,
    pub price_scale: u64,
    pub grid: SeriesGrid,
    /// Interval mode: the close of the first cross.
    pub start_ts: i64,
    /// Interval mode: seconds between closes. 0 means the calendar sets the closes.
    pub interval_secs: i64,
    pub calendar: Option<Pubkey>,
    /// Length of the call window before each close.
    pub call_secs: i64,
    /// Sealed crosses: length of the reveal window after each close.
    pub reveal_secs: i64,
    pub min_matched: u64,
    pub max_imbalance_bps: Option<u32>,
    pub integrator_fee_bps: u16,
    pub integrator: Pubkey,
    pub gate_mint: Option<Pubkey>,
    pub shards: u8,
    pub max_orders: u32,
    /// Where each cross pays out; the default (all zeros) is the series itself, which also returns
    /// the dust bond to the series' funds.
    pub proceeds_to: Pubkey,
    pub oracle: Option<OracleGuard>,
    /// 0 = no limit.
    pub max_crosses: u64,
    /// Rules every spawned cross gets (no bond: the series cannot sign for one).
    pub rules: RulesInput,
}

#[account]
#[derive(InitSpace)]
pub struct Series {
    /// May pause the series, change nothing else, and withdraw its funds.
    pub authority: Pubkey,
    pub series_id: u64,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub config: SeriesConfig,
    /// Crosses spawned so far; the next cross's id.
    pub next_index: u64,
    pub last_cross: Option<Pubkey>,
    pub last_close_ts: i64,
    /// Price of the last cross that printed (0 until one has).
    pub last_price: u64,
    pub active: bool,
    pub bump: u8,
}

impl Series {
    fn seeds<'a>(&'a self, id: &'a [u8; 8], bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
        [SERIES_SEED, self.authority.as_ref(), id, bump]
    }
}

pub fn series_address(authority: &Pubkey, series_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[SERIES_SEED, authority.as_ref(), &series_id.to_le_bytes()],
        &crate::ID,
    )
    .0
}

#[derive(Accounts)]
#[instruction(series_id: u64)]
pub struct CreateSeries<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Series::INIT_SPACE, seeds = [SERIES_SEED, authority.key().as_ref(), &series_id.to_le_bytes()], bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(mint::token_program = base_token_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn create_series(
    ctx: Context<CreateSeries>,
    series_id: u64,
    config: SeriesConfig,
) -> Result<()> {
    require!(
        matches!(config.kind, CrossKind::Recurring | CrossKind::Reopen),
        CrossError::InvalidParams
    );
    require!(
        config.price_scale > 0 && config.call_secs > 0 && config.reveal_secs >= 0,
        CrossError::InvalidParams
    );
    require!(
        (config.disclosure == Disclosure::Sealed) == (config.reveal_secs > 0),
        CrossError::InvalidParams
    );
    // The schedule comes from an interval or from a calendar, not both.
    require!(
        (config.interval_secs > 0) != config.calendar.is_some()
            && (config.interval_secs == 0 || config.start_ts > 0),
        CrossError::InvalidParams
    );
    let g = config.grid;
    if g.relative {
        require!(
            g.tick_bps > 0 && g.ticks >= 2 && g.center > 0,
            CrossError::InvalidParams
        );
    } else {
        require!(g.tick > 0 && g.ticks > 0, CrossError::InvalidParams);
    }
    require!(
        config.rules.neutrality.bond_quote == 0,
        CrossError::InvalidParams
    );
    let s = &mut ctx.accounts.series;
    s.authority = ctx.accounts.authority.key();
    s.series_id = series_id;
    s.base_mint = ctx.accounts.base_mint.key();
    s.quote_mint = ctx.accounts.quote_mint.key();
    s.base_token_program = ctx.accounts.base_token_program.key();
    s.quote_token_program = ctx.accounts.quote_token_program.key();
    s.config = config;
    s.next_index = 0;
    s.last_cross = None;
    s.last_close_ts = 0;
    s.last_price = 0;
    s.active = true;
    s.bump = ctx.bumps.series;
    emit!(SeriesCreated {
        series: s.key(),
        authority: s.authority
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SeriesAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ CrossError::Unauthorized)]
    pub series: Box<Account<'info, Series>>,
}

/// The authority pauses or resumes spawning. A cross already running is unaffected.
pub fn set_series_active(ctx: Context<SeriesAuthority>, active: bool) -> Result<()> {
    ctx.accounts.series.active = active;
    Ok(())
}

#[derive(Accounts)]
pub struct SeriesWithdraw<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority @ CrossError::Unauthorized)]
    pub series: Box<Account<'info, Series>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = series, token::token_program = token_program)]
    pub from: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The authority takes tokens out of an account the series owns (leftover bond, proceeds).
pub fn series_withdraw(ctx: Context<SeriesWithdraw>, amount: u64) -> Result<()> {
    let s = &ctx.accounts.series;
    let id = s.series_id.to_le_bytes();
    let bump = [s.bump];
    let seeds = s.seeds(&id, &bump);
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.from.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.series.to_account_info(),
            },
            &[&seeds[..]],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}

#[derive(Accounts)]
pub struct SpawnNext<'info> {
    /// Pays the new cross's rent; anyone may.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(init, payer = payer, space = CROSS_SPACE, seeds = [CROSS_SEED, series.key().as_ref(), &series.next_index.to_le_bytes()], bump)]
    pub cross: Box<Account<'info, Cross>>,
    #[account(init, payer = payer, space = Levels::SIZE, seeds = [BOOK_SEED, cross.key().as_ref()], bump)]
    pub book: AccountLoader<'info, Levels>,
    #[account(address = series.base_mint, mint::token_program = base_token_program)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.quote_mint, mint::token_program = quote_token_program)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, seeds = [QUOTE_VAULT_SEED, cross.key().as_ref()], bump, token::mint = quote_mint, token::authority = cross, token::token_program = quote_token_program)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = payer, seeds = [BASE_VAULT_SEED, cross.key().as_ref()], bump, token::mint = base_mint, token::authority = cross, token::token_program = base_token_program)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The series' quote account: it pays the dust bond.
    #[account(mut, token::mint = quote_mint, token::authority = series, token::token_program = quote_token_program)]
    pub series_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The previous cross; required from the second cross on.
    pub previous: Option<Box<Account<'info, Cross>>>,
    /// CHECK: the series' calendar, when it has one; owner and contents checked in the handler.
    pub calendar_account: Option<UncheckedAccount<'info>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Close time of the next cross, derived on chain so the caller cannot pick it.
fn next_close(
    cfg: &SeriesConfig,
    index: u64,
    last_close: i64,
    now: i64,
    calendar: Option<&AccountInfo>,
) -> Result<i64> {
    let floor = now.max(last_close);
    if cfg.interval_secs > 0 {
        let first = cfg
            .start_ts
            .checked_add(
                i64::try_from(index)
                    .map_err(|_| CrossError::Overflow)?
                    .checked_mul(cfg.interval_secs)
                    .ok_or(CrossError::Overflow)?,
            )
            .ok_or(CrossError::Overflow)?;
        if first > floor {
            return Ok(first);
        }
        // Missed slots are skipped: the first slot strictly after the floor.
        let behind = floor.checked_sub(first).ok_or(CrossError::Overflow)?;
        let steps = behind
            .checked_div(cfg.interval_secs)
            .and_then(|k| k.checked_add(1))
            .ok_or(CrossError::Overflow)?;
        return first
            .checked_add(
                steps
                    .checked_mul(cfg.interval_secs)
                    .ok_or(CrossError::Overflow)?,
            )
            .ok_or_else(|| error!(CrossError::Overflow));
    }
    let info = calendar.ok_or(CrossError::CalendarMismatch)?;
    require_keys_eq!(
        info.key(),
        cfg.calendar.ok_or(CrossError::CalendarMismatch)?,
        CrossError::CalendarMismatch
    );
    require_keys_eq!(
        *info.owner,
        cross_calendar::ID,
        CrossError::CalendarMismatch
    );
    let data = info.try_borrow_data()?;
    let cal = cross_calendar::Calendar::try_deserialize(&mut &data[..])?;
    cal.sessions
        .iter()
        .map(|s| s.start_ts)
        .filter(|t| *t > floor)
        .min()
        .ok_or_else(|| error!(CrossError::NoSessionAhead))
}

/// The grid of the next cross and the reference price to centre it on.
fn grid_for(cfg: &SeriesConfig, last_price: u64) -> Result<(u64, u64, u16, Option<u64>)> {
    let g = cfg.grid;
    if !g.relative {
        let reference = (last_price >= g.min_price).then_some(last_price);
        let reference = reference.and_then(|p| {
            let off = p.checked_sub(g.min_price)?;
            let i = off
                .checked_div(g.tick)?
                .min(u64::from(g.ticks).checked_sub(1)?);
            g.min_price.checked_add(i.checked_mul(g.tick)?)
        });
        return Ok((g.min_price, g.tick, g.ticks, reference));
    }
    let center = if last_price > 0 { last_price } else { g.center };
    let tick = u64::try_from(
        u128::from(center)
            .checked_mul(u128::from(g.tick_bps))
            .and_then(|v| v.checked_div(10_000))
            .ok_or(CrossError::Overflow)?
            .max(1),
    )
    .map_err(|_| CrossError::Overflow)?;
    let below = u64::from(g.ticks / 2)
        .checked_mul(tick)
        .ok_or(CrossError::Overflow)?;
    // The grid starts one tick or more above zero; a centre too small for the width is clamped.
    let min_price = center.saturating_sub(below).max(tick);
    let i = center
        .saturating_sub(min_price)
        .checked_div(tick)
        .ok_or(CrossError::Overflow)?
        .min(u64::from(g.ticks).saturating_sub(1));
    let reference = min_price
        .checked_add(i.checked_mul(tick).ok_or(CrossError::Overflow)?)
        .ok_or(CrossError::Overflow)?;
    Ok((min_price, tick, g.ticks, Some(reference)))
}

pub fn spawn_next<'info>(ctx: Context<'info, SpawnNext<'info>>) -> Result<()> {
    let cfg = ctx.accounts.series.config;
    let now = Clock::get()?.unix_timestamp;
    {
        let s = &mut ctx.accounts.series;
        require!(
            s.active && (cfg.max_crosses == 0 || s.next_index < cfg.max_crosses),
            CrossError::SeriesInactive
        );
        // One cross at a time: the previous one must have resolved, and its print re-centres the grid.
        if s.next_index > 0 {
            let prev = ctx
                .accounts
                .previous
                .as_ref()
                .ok_or(CrossError::SeriesPreviousMissing)?;
            require!(
                s.last_cross == Some(prev.key()) && prev.state != CrossState::Live,
                CrossError::SeriesPreviousMissing
            );
            if prev.state != CrossState::NoPrint {
                if let Some(cl) = prev.clearing {
                    s.last_price = cl.price;
                }
            }
        }
    }
    let s = &ctx.accounts.series;
    let close_ts = next_close(
        &cfg,
        s.next_index,
        s.last_close_ts,
        now,
        ctx.accounts.calendar_account.as_ref().map(|a| a.as_ref()),
    )?;
    let open_ts = close_ts
        .checked_sub(cfg.call_secs)
        .ok_or(CrossError::Overflow)?;
    require!(
        now.saturating_add(SPAWN_LEAD_SECS) >= open_ts,
        CrossError::SpawnTooEarly
    );
    let (min_price, tick, ticks, reference) = grid_for(&cfg, s.last_price)?;
    let series_key = s.key();
    let params = CreateCrossParams {
        cross_id: s.next_index,
        kind: cfg.kind,
        supply_mode: SupplyMode::Escrow,
        disclosure: cfg.disclosure,
        min_price,
        tick,
        ticks,
        price_scale: cfg.price_scale,
        open_ts,
        close_ts,
        reveal_end_ts: close_ts
            .checked_add(cfg.reveal_secs)
            .ok_or(CrossError::Overflow)?,
        reference_price: reference,
        min_matched: cfg.min_matched,
        max_imbalance_bps: cfg.max_imbalance_bps,
        integrator_fee_bps: cfg.integrator_fee_bps,
        integrator: cfg.integrator,
        gate_mint: cfg.gate_mint,
        oracle: cfg.oracle,
        calendar: cfg.calendar,
        shards: cfg.shards,
        max_orders: cfg.max_orders,
        proceeds_to: if cfg.proceeds_to == Pubkey::default() {
            series_key
        } else {
            cfg.proceeds_to
        },
        schedule: Vec::new(),
        settler: None,
        settle_deadline_ts: 0,
    };
    let bond = create::populate(
        create::Setup {
            protocol: &ctx.accounts.protocol,
            cross: &mut ctx.accounts.cross,
            book: &ctx.accounts.book,
            creator: series_key,
            base_mint: Some(&ctx.accounts.base_mint),
            has_base_vault: true,
            quote_mint: &ctx.accounts.quote_mint,
            base_token_program: ctx.accounts.base_token_program.key(),
            quote_token_program: ctx.accounts.quote_token_program.key(),
            calendar_account: ctx.accounts.calendar_account.as_ref().map(|a| a.as_ref()),
            bumps: create::Bumps {
                cross: ctx.bumps.cross,
                quote_vault: ctx.bumps.quote_vault,
                base_vault: Some(ctx.bumps.base_vault),
                book: ctx.bumps.book,
            },
        },
        &params,
    )?;
    // The rules are set here and now, as `set_rules` would in the creating slot.
    rules::apply(&ctx.accounts.cross, cfg.rules, ctx.remaining_accounts, None)?;
    if bond > 0 {
        let s = &ctx.accounts.series;
        let id = s.series_id.to_le_bytes();
        let bump = [s.bump];
        let seeds = s.seeds(&id, &bump);
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.quote_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.series_quote.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.quote_vault.to_account_info(),
                    authority: ctx.accounts.series.to_account_info(),
                },
                &[&seeds[..]],
            ),
            bond,
            ctx.accounts.quote_mint.decimals,
        )?;
    }
    let cross = &ctx.accounts.cross;
    let s = &mut ctx.accounts.series;
    s.next_index = s.next_index.checked_add(1).ok_or(CrossError::Overflow)?;
    s.last_cross = Some(cross.key());
    s.last_close_ts = close_ts;
    emit!(crate::CrossCreated {
        cross: cross.key(),
        creator: cross.creator,
        kind: cross.kind,
        supply_mode: cross.supply_mode,
        disclosure: cross.disclosure,
        base_mint: cross.base_mint,
        quote_mint: cross.quote_mint,
        open_ts: cross.open_ts,
        close_ts: cross.close_ts,
        reveal_end_ts: cross.reveal_end_ts,
        protocol_fee_bps: cross.protocol_fee_bps,
        integrator_fee_bps: cross.integrator_fee_bps
    });
    emit!(SeriesSpawned {
        series: series_key,
        cross: cross.key(),
        index: cross.cross_id,
        close_ts
    });
    Ok(())
}

#[event]
pub struct SeriesCreated {
    pub series: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct SeriesSpawned {
    pub series: Pubkey,
    pub cross: Pubkey,
    pub index: u64,
    pub close_ts: i64,
}
