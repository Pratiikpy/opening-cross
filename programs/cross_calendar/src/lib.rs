//! Opening Cross exchange calendar (ROADMAP C6, PRD [W5]).
//!
//! A calendar lists upcoming trading sessions as UTC instants, plus the Pyth feed ids approved
//! for oracle-guarded crosses on that calendar. Reopen crosses are scheduled against it: a cross
//! bound to a calendar must close exactly when one of its sessions starts (checked by
//! `cross_core`).
//!
//! Nothing on a calendar changes instantly. The admin (a multisig in production) proposes a new
//! session list and feed set; the proposal can be applied by anyone only after the calendar's
//! timelock (at least seven days) has passed, and the admin can cancel it during the wait. Market
//! participants therefore always see a schedule change a week before it can take effect.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;

declare_id!("CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN");

pub const CALENDAR_SEED: &[u8] = b"calendar";
/// Upcoming sessions held at once; older sessions are dropped by the next update.
pub const MAX_SESSIONS: usize = 64;
pub const MAX_FEEDS: usize = 8;
/// Floor on every calendar's timelock (PRD [W5]: multisig with a 7-day timelock).
pub const MIN_TIMELOCK_SECS: i64 = 7 * 24 * 60 * 60;

#[program]
pub mod cross_calendar {
    use super::*;

    pub fn create_calendar(
        ctx: Context<CreateCalendar>,
        id: u64,
        timelock_secs: i64,
        sessions: Vec<Session>,
        feeds: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(
            timelock_secs >= MIN_TIMELOCK_SECS,
            CalendarError::TimelockTooShort
        );
        validate(&sessions, &feeds)?;
        let c = &mut ctx.accounts.calendar;
        c.admin = ctx.accounts.admin.key();
        c.id = id;
        c.timelock_secs = timelock_secs;
        c.sessions = sessions;
        c.feeds = feeds;
        c.pending = None;
        c.bump = ctx.bumps.calendar;
        emit!(CalendarUpdated {
            calendar: c.key(),
            sessions: c.sessions.len() as u32,
            feeds: c.feeds.len() as u32
        });
        Ok(())
    }

    /// Proposes a new session list and feed set. Replaces any earlier proposal and restarts the
    /// timelock.
    pub fn propose_update(
        ctx: Context<AdminOnly>,
        sessions: Vec<Session>,
        feeds: Vec<[u8; 32]>,
    ) -> Result<()> {
        validate(&sessions, &feeds)?;
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.calendar;
        let eta = now
            .checked_add(c.timelock_secs)
            .ok_or(CalendarError::Overflow)?;
        c.pending = Some(PendingUpdate {
            sessions,
            feeds,
            eta,
        });
        emit!(UpdateProposed {
            calendar: c.key(),
            eta
        });
        Ok(())
    }

    pub fn cancel_update(ctx: Context<AdminOnly>) -> Result<()> {
        let c = &mut ctx.accounts.calendar;
        require!(c.pending.is_some(), CalendarError::NothingPending);
        c.pending = None;
        emit!(UpdateCancelled { calendar: c.key() });
        Ok(())
    }

    /// Applies a proposal once its timelock has passed. Permissionless.
    pub fn apply_update(ctx: Context<ApplyUpdate>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.calendar;
        let pending = c.pending.take().ok_or(CalendarError::NothingPending)?;
        require!(now >= pending.eta, CalendarError::TimelockActive);
        c.sessions = pending.sessions;
        c.feeds = pending.feeds;
        emit!(CalendarUpdated {
            calendar: c.key(),
            sessions: c.sessions.len() as u32,
            feeds: c.feeds.len() as u32
        });
        Ok(())
    }

    /// Admin handover is itself time-locked: it goes through the same proposal path by setting
    /// `pending_admin`, applied after the timelock.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.calendar;
        c.pending_admin = Some(PendingAdmin {
            admin: new_admin,
            eta: now
                .checked_add(c.timelock_secs)
                .ok_or(CalendarError::Overflow)?,
        });
        Ok(())
    }

    pub fn apply_admin(ctx: Context<ApplyUpdate>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.calendar;
        let p = c
            .pending_admin
            .take()
            .ok_or(CalendarError::NothingPending)?;
        require!(now >= p.eta, CalendarError::TimelockActive);
        c.admin = p.admin;
        emit!(CalendarAdminChanged {
            calendar: c.key(),
            admin: p.admin
        });
        Ok(())
    }
}

fn validate(sessions: &[Session], feeds: &[[u8; 32]]) -> Result<()> {
    require!(
        sessions.len() <= MAX_SESSIONS && feeds.len() <= MAX_FEEDS,
        CalendarError::TooMany
    );
    let mut prev_end = i64::MIN;
    for s in sessions {
        // Strictly increasing, non-overlapping sessions.
        require!(
            s.start_ts < s.end_ts && s.start_ts >= prev_end,
            CalendarError::BadSessions
        );
        prev_end = s.end_ts;
    }
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Session {
    /// UTC instant the market (re)opens — reopen crosses close here.
    pub start_ts: i64,
    /// UTC instant the session ends.
    pub end_ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
pub struct PendingUpdate {
    #[max_len(MAX_SESSIONS)]
    pub sessions: Vec<Session>,
    #[max_len(MAX_FEEDS)]
    pub feeds: Vec<[u8; 32]>,
    pub eta: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PendingAdmin {
    pub admin: Pubkey,
    pub eta: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Calendar {
    pub admin: Pubkey,
    pub id: u64,
    pub timelock_secs: i64,
    #[max_len(MAX_SESSIONS)]
    pub sessions: Vec<Session>,
    #[max_len(MAX_FEEDS)]
    pub feeds: Vec<[u8; 32]>,
    pub pending: Option<PendingUpdate>,
    pub pending_admin: Option<PendingAdmin>,
    pub bump: u8,
}

impl Calendar {
    /// `true` if some session starts exactly at `ts`.
    pub fn has_session_start(&self, ts: i64) -> bool {
        self.sessions.iter().any(|s| s.start_ts == ts)
    }
    pub fn approves_feed(&self, feed: &[u8; 32]) -> bool {
        self.feeds.iter().any(|f| f == feed)
    }
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateCalendar<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Calendar::INIT_SPACE, seeds = [CALENDAR_SEED, admin.key().as_ref(), &id.to_le_bytes()], bump)]
    pub calendar: Account<'info, Calendar>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ CalendarError::Unauthorized)]
    pub calendar: Account<'info, Calendar>,
}

#[derive(Accounts)]
pub struct ApplyUpdate<'info> {
    #[account(mut)]
    pub calendar: Account<'info, Calendar>,
}

#[event]
pub struct CalendarUpdated {
    pub calendar: Pubkey,
    pub sessions: u32,
    pub feeds: u32,
}
#[event]
pub struct UpdateProposed {
    pub calendar: Pubkey,
    pub eta: i64,
}
#[event]
pub struct UpdateCancelled {
    pub calendar: Pubkey,
}
#[event]
pub struct CalendarAdminChanged {
    pub calendar: Pubkey,
    pub admin: Pubkey,
}

#[error_code]
pub enum CalendarError {
    #[msg("Timelock must be at least seven days")]
    TimelockTooShort,
    #[msg("Too many sessions or feeds")]
    TooMany,
    #[msg("Sessions must be increasing and must not overlap")]
    BadSessions,
    #[msg("No pending update")]
    NothingPending,
    #[msg("Timelock has not passed")]
    TimelockActive,
    #[msg("Signer is not the calendar admin")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
}
