//! Halt state of a base mint, and the triggers that set it (ADR-0455, PRODUCT_FEATURES W11/W8).
//!
//! A halted asset does not trade through ordinary crosses, and it resumes only through a cross:
//! a cross flagged `RESUMES_HALT` that prints lifts the halt (`clear` does this), so the first
//! price after a halt is always a one-price auction and never a stale quote. Triggers set the
//! halt; nothing but a printing resume cross clears it.
//!
//! Triggers (all recorded with a reason so the print feed and the UI can say why):
//! - the issuer's pause: the Token-2022 pausable extension on the mint, read by `sync_pause`;
//! - the venue's signal: `set_halt` by the registered venue signer;
//! - the oracle circuit breaker: `observe_price` compares two verified Pyth updates for the
//!   registered feed that are at most `window_slots` apart and halts on a move above `move_bps`;
//! - a corporate action: `set_corporate_action` by the issuer authority.
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        pausable::PausableConfig, scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions,
        StateWithExtensions,
    },
    state::Mint as Mint2022,
};

use crate::{oracle, CrossError};

pub const HALT_SEED: &[u8] = b"halt";
/// The oldest an oracle update may be when it is fed to the circuit breaker. Without a bound a stale
/// update (the receiver keeps old ones) could be replayed to trip the breaker on a price from the past.
pub const MAX_UPDATE_AGE_SECS: i64 = 120;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum HaltReason {
    None,
    IssuerPause,
    VenueHalt,
    CircuitBreaker,
    CorporateAction,
}

/// Oracle circuit breaker settings and the last observation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Breaker {
    pub feed_id: [u8; 32],
    /// Two observations further apart than this many slots are not compared.
    pub window_slots: u32,
    /// Halt when `|new − last| · 10_000 > move_bps · last`.
    pub move_bps: u32,
    pub last_price: i64,
    pub last_exponent: i32,
    pub last_slot: u64,
    /// Publish time of the last accepted update: an older or equal one is never accepted again.
    pub last_publish_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct HaltState {
    pub base_mint: Pubkey,
    /// The issuer's authority: may halt and flag corporate actions.
    pub authority: Pubkey,
    /// A venue (an exchange or a market operator) that may signal a halt.
    pub venue_signer: Option<Pubkey>,
    pub halted: bool,
    pub reason: HaltReason,
    pub corporate_action: bool,
    pub since_ts: i64,
    pub since_slot: u64,
    /// The issuer lifted its pause on the mint; the halt stays until a resume cross prints.
    pub issuer_unpaused: bool,
    pub breaker: Option<Breaker>,
    pub last_resume_cross: Option<Pubkey>,
    pub last_resume_price: u64,
    pub last_resume_ts: i64,
    pub bump: u8,
}

impl HaltState {
    /// Marks the asset halted; a halt already in force keeps its original reason and time.
    pub fn halt(&mut self, reason: HaltReason, now: i64, slot: u64) {
        if !self.halted {
            self.halted = true;
            self.reason = reason;
            self.since_ts = now;
            self.since_slot = slot;
            self.issuer_unpaused = false;
        }
    }

    /// A resume cross printed at `price`: the halt and any corporate-action flag are lifted.
    pub fn resume(&mut self, cross: Pubkey, price: u64, now: i64) {
        self.halted = false;
        self.reason = HaltReason::None;
        self.corporate_action = false;
        self.issuer_unpaused = false;
        self.last_resume_cross = Some(cross);
        self.last_resume_price = price;
        self.last_resume_ts = now;
        if let Some(b) = self.breaker.as_mut() {
            // The next observation starts a fresh comparison from the post-resume market.
            b.last_price = 0;
            b.last_slot = 0;
        }
    }
}

/// Whether the Token-2022 mint in `data` is paused by its pausable extension. A mint without the
/// extension, or a classic SPL mint, is never paused.
pub fn mint_is_paused(data: &[u8]) -> bool {
    StateWithExtensions::<Mint2022>::unpack(data)
        .ok()
        .and_then(|m| {
            m.get_extension::<PausableConfig>()
                .ok()
                .map(|p| bool::from(p.paused))
        })
        .unwrap_or(false)
}

/// The effective multiplier of a Token-2022 mint's scaled-UI-amount extension at `now`, as the bits of its `f64`
/// (equality is all the guard needs, so no floating-point arithmetic runs on chain). `None` for a mint without the
/// extension.
pub fn scaled_ui_multiplier(data: &[u8], now: i64) -> Option<u64> {
    let mint = StateWithExtensions::<Mint2022>::unpack(data).ok()?;
    let cfg = mint.get_extension::<ScaledUiAmountConfig>().ok()?;
    let effective_from: i64 = cfg.new_multiplier_effective_timestamp.into();
    let bits = if now >= effective_from {
        cfg.new_multiplier.0
    } else {
        cfg.multiplier.0
    };
    Some(u64::from_le_bytes(bits))
}

/// The mint authority as stored in the mint account (classic SPL or Token-2022 base layout).
pub fn mint_authority_of(data: &[u8]) -> Option<Pubkey> {
    // COption<Pubkey>: 4-byte tag, then 32 bytes.
    if data.len() < 36 || data[..4] != [1, 0, 0, 0] {
        return None;
    }
    Some(Pubkey::new_from_array(data[4..36].try_into().ok()?))
}

/// Verifies that `account` is the halt state of `base_mint` and returns it deserialized.
pub fn load(account: &AccountInfo, base_mint: &Pubkey) -> Result<HaltState> {
    require_keys_eq!(*account.owner, crate::ID, CrossError::HaltMismatch);
    let data = account.try_borrow_data()?;
    let s = HaltState::try_deserialize(&mut &data[..])?;
    require_keys_eq!(s.base_mint, *base_mint, CrossError::HaltMismatch);
    let (pda, _) = Pubkey::find_program_address(&[HALT_SEED, base_mint.as_ref()], &crate::ID);
    require_keys_eq!(pda, account.key(), CrossError::HaltMismatch);
    Ok(s)
}

/// Writes `state` back to its account.
pub fn store(account: &AccountInfo, state: &HaltState) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data[..];
    state.try_serialize(&mut cursor)
}

// ------------------------------------------------------------------ instructions

#[derive(Accounts)]
pub struct InitHaltState<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: the base mint; its mint authority must be the signer, or the signer the protocol admin.
    pub base_mint: UncheckedAccount<'info>,
    #[account(seeds = [crate::state::PROTOCOL_SEED], bump = protocol.bump)]
    pub protocol: Account<'info, crate::state::Protocol>,
    #[account(init, payer = authority, space = 8 + HaltState::INIT_SPACE, seeds = [HALT_SEED, base_mint.key().as_ref()], bump)]
    pub halt: Account<'info, HaltState>,
    pub system_program: Program<'info, System>,
}

pub fn init_halt_state(
    ctx: Context<InitHaltState>,
    venue_signer: Option<Pubkey>,
    breaker: Option<BreakerSetup>,
) -> Result<()> {
    let mint = &ctx.accounts.base_mint;
    require!(
        *mint.owner == anchor_spl::token::ID || *mint.owner == anchor_spl::token_2022::ID,
        CrossError::WrongMint
    );
    let signer = ctx.accounts.authority.key();
    let is_admin = signer == ctx.accounts.protocol.admin;
    let is_mint_authority = mint_authority_of(&mint.try_borrow_data()?) == Some(signer);
    require!(is_admin || is_mint_authority, CrossError::Unauthorized);
    let h = &mut ctx.accounts.halt;
    h.base_mint = mint.key();
    h.authority = signer;
    h.venue_signer = venue_signer;
    h.halted = false;
    h.reason = HaltReason::None;
    h.corporate_action = false;
    h.since_ts = 0;
    h.since_slot = 0;
    h.issuer_unpaused = false;
    h.breaker = match breaker {
        None => None,
        Some(b) => {
            require!(
                b.window_slots > 0 && b.move_bps > 0,
                CrossError::InvalidParams
            );
            Some(Breaker {
                feed_id: b.feed_id,
                window_slots: b.window_slots,
                move_bps: b.move_bps,
                last_price: 0,
                last_exponent: 0,
                last_slot: 0,
                last_publish_ts: 0,
            })
        }
    };
    h.last_resume_cross = None;
    h.last_resume_price = 0;
    h.last_resume_ts = 0;
    h.bump = ctx.bumps.halt;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BreakerSetup {
    pub feed_id: [u8; 32],
    pub window_slots: u32,
    pub move_bps: u32,
}

#[derive(Accounts)]
pub struct HaltSignal<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub halt: Account<'info, HaltState>,
}

/// The issuer authority or the registered venue signer halts the asset. A halt can only be
/// lifted by a printing resume cross.
pub fn set_halt(ctx: Context<HaltSignal>) -> Result<()> {
    let h = &mut ctx.accounts.halt;
    let signer = ctx.accounts.signer.key();
    let reason = if signer == h.authority {
        HaltReason::IssuerPause
    } else if h.venue_signer == Some(signer) {
        HaltReason::VenueHalt
    } else {
        return err!(CrossError::Unauthorized);
    };
    let clock = Clock::get()?;
    h.halt(reason, clock.unix_timestamp, clock.slot);
    emit!(HaltChanged {
        base_mint: h.base_mint,
        halted: true,
        reason
    });
    Ok(())
}

/// The issuer authority flags or unflags a corporate action (a split, a dividend, a multiplier
/// change). A flagged mint does not print in an ordinary cross.
pub fn set_corporate_action(ctx: Context<HaltSignal>, flag: bool) -> Result<()> {
    let h = &mut ctx.accounts.halt;
    require_keys_eq!(
        ctx.accounts.signer.key(),
        h.authority,
        CrossError::Unauthorized
    );
    h.corporate_action = flag;
    if flag {
        let clock = Clock::get()?;
        h.halt(
            HaltReason::CorporateAction,
            clock.unix_timestamp,
            clock.slot,
        );
    }
    emit!(HaltChanged {
        base_mint: h.base_mint,
        halted: h.halted,
        reason: h.reason
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SyncPause<'info> {
    #[account(mut, has_one = base_mint @ CrossError::HaltMismatch)]
    pub halt: Account<'info, HaltState>,
    /// CHECK: bound to the halt state by `has_one`; read for its pausable extension.
    pub base_mint: UncheckedAccount<'info>,
}

/// Anyone copies the mint's pause into the halt state. A paused mint halts the asset; a mint
/// that was unpaused marks `issuer_unpaused`, so a keeper knows to schedule the resume cross.
pub fn sync_pause(ctx: Context<SyncPause>) -> Result<()> {
    let paused = mint_is_paused(&ctx.accounts.base_mint.try_borrow_data()?);
    let h = &mut ctx.accounts.halt;
    let clock = Clock::get()?;
    if paused {
        h.halt(HaltReason::IssuerPause, clock.unix_timestamp, clock.slot);
    } else if h.halted && h.reason == HaltReason::IssuerPause {
        h.issuer_unpaused = true;
    }
    emit!(HaltChanged {
        base_mint: h.base_mint,
        halted: h.halted,
        reason: h.reason
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ObservePrice<'info> {
    #[account(mut)]
    pub halt: Account<'info, HaltState>,
    /// CHECK: a Pyth `PriceUpdateV2` account; owner, verification level and feed are checked.
    pub price_update: UncheckedAccount<'info>,
}

/// Anyone feeds a verified oracle update to the circuit breaker. Two observations within the
/// window whose prices differ by more than the breaker's bound halt the asset.
pub fn observe_price(ctx: Context<ObservePrice>) -> Result<()> {
    let h = &mut ctx.accounts.halt;
    let b = h.breaker.as_mut().ok_or(CrossError::InvalidParams)?;
    let acc = &ctx.accounts.price_update;
    require!(
        oracle::is_pyth_receiver(acc.owner),
        CrossError::OracleUnavailable
    );
    let o =
        oracle::parse_price_update(&acc.try_borrow_data()?).ok_or(CrossError::OracleUnavailable)?;
    require!(
        o.feed_id == b.feed_id && o.fully_verified && o.price > 0,
        CrossError::OracleUnavailable
    );
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp.saturating_sub(o.publish_time) <= MAX_UPDATE_AGE_SECS
            && o.publish_time > b.last_publish_ts,
        CrossError::OracleUnavailable
    );
    let mut tripped = false;
    if b.last_slot > 0
        && b.last_exponent == o.exponent
        && clock.slot >= b.last_slot
        && clock.slot - b.last_slot <= u64::from(b.window_slots)
    {
        let diff = u128::from(o.price.abs_diff(b.last_price));
        let lhs = diff.saturating_mul(10_000);
        let rhs = u128::from(b.move_bps).saturating_mul(u128::try_from(b.last_price).unwrap_or(0));
        tripped = b.last_price > 0 && lhs > rhs;
    }
    b.last_price = o.price;
    b.last_exponent = o.exponent;
    b.last_slot = clock.slot;
    b.last_publish_ts = o.publish_time;
    if tripped {
        h.halt(HaltReason::CircuitBreaker, clock.unix_timestamp, clock.slot);
    }
    emit!(HaltChanged {
        base_mint: h.base_mint,
        halted: h.halted,
        reason: h.reason
    });
    Ok(())
}

#[event]
pub struct HaltChanged {
    pub base_mint: Pubkey,
    pub halted: bool,
    pub reason: HaltReason,
}
