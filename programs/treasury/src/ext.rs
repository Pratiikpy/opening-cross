//! The treasury extension tail (ADR-0470).
//!
//! A `Treasury` account written by the first release is exactly `8 + Treasury::INIT_SPACE` bytes.
//! The extension lives in the bytes after that, in the same account: Anchor decodes the Borsh prefix
//! and ignores what follows, and writes back only the prefix. A treasury without a tail (magic
//! absent) behaves exactly as before; `init_ext` grows the account by the tail's size, once.
use anchor_lang::prelude::*;

use crate::{Treasury, TreasuryError};

pub const EXT_MAGIC: [u8; 4] = *b"TEX1";
pub const COINS_SEED: &[u8] = b"coins";
pub const DIST_SEED: &[u8] = b"dist";

/// Day, in seconds, for the minimum safe windows.
pub const DAY: i64 = 86_400;
/// A wind-down window shorter than this could sweep holders' funds before they notice.
pub const MIN_WINDOW_SECS: i64 = 180 * DAY;
pub const MIN_VOTE_PERIOD_SECS: i64 = 3 * DAY;
pub const MIN_TIMELOCK_SECS: i64 = DAY;
pub const MIN_QUORUM_BPS: u16 = 1_000;
pub const MIN_THRESHOLD_BPS: u16 = 5_000;
/// A passed proposal can be executed only within this long after its timelock ends.
pub const EXEC_WINDOW_SECS: i64 = 14 * DAY;
pub const MAX_INSIDERS: usize = 4;
pub const MIN_STREAM_SECS: i64 = 3_600;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Ext {
    pub magic: [u8; 4],
    pub coin_vault_bump: u8,
    pub dist_vault_bump: u8,

    // Governance. `vote_period_secs == 0` disables proposals.
    pub vote_period_secs: i64,
    pub timelock_secs: i64,
    pub quorum_bps: u16,
    pub threshold_bps: u16,
    pub max_proposal_bps: u16,
    pub proposer_min_bps: u16,
    pub proposal_count: u64,

    // Coins held by the program on behalf of others. Invariant:
    // coin_vault.amount == votes_locked + total_staked + grants_unreleased.
    pub votes_locked: u64,
    pub total_staked: u64,
    pub grants_unreleased: u64,
    pub grant_count: u64,
    pub min_lockup_secs: i64,

    // NAV floor. `nav_period_secs == 0` disables it.
    pub nav_open: bool,
    pub nav_period_secs: i64,
    pub nav_cap_bps: u16,
    pub nav_period_start: i64,
    pub nav_period_supply: u64,
    pub nav_burned: u64,
    pub insiders: [Pubkey; MAX_INSIDERS],

    // Distributions to staked coins. A deposit streams to the stakers over `stream_secs` (0: at once), so a coin
    // staked for a moment earns a moment's share. `stream_amount` is what has not been released yet.
    pub acc_per_stake: u128,
    pub stream_secs: i64,
    pub stream_amount: u64,
    pub stream_end: i64,
    pub stream_last: i64,

    // Verified-revenue rounds. `rev_share_bps == 0` disables them.
    pub rev_share_bps: u16,
    pub rev_credential: Pubkey,
    pub rev_schema: Pubkey,
    pub round_secs: i64,
    pub rev_start: i64,
    pub pay_grace_secs: i64,
    pub missed_rounds: u32,
    pub tranche_min_revenue: u64,
    pub tranche_amount: u64,

    // Disclosure feed. `disclosure_period_secs == 0` disables it.
    pub disclosure_period_secs: i64,
    pub last_disclosure_ts: i64,
    pub last_disclosure_hash: [u8; 32],
    pub disclosures: u32,
    pub open_request_ts: i64,
    pub request_min_bps: u16,

    // IP and asset assignment gate.
    pub assign_required: bool,
    pub assigned: bool,
    pub assign_credential: Pubkey,
    pub assign_schema: Pubkey,

    // Wind-down. `window_secs == 0` disables the sweep.
    pub window_secs: i64,
    pub recovery: Pubkey,
    pub wind_start: i64,
    pub swept: bool,
}

/// What the team chooses when it extends a treasury. Every field is fixed afterwards.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ExtParams {
    pub vote_period_secs: i64,
    pub timelock_secs: i64,
    pub quorum_bps: u16,
    pub threshold_bps: u16,
    pub max_proposal_bps: u16,
    pub proposer_min_bps: u16,
    pub min_lockup_secs: i64,
    pub nav_period_secs: i64,
    pub nav_cap_bps: u16,
    pub insiders: [Pubkey; MAX_INSIDERS],
    pub stream_secs: i64,
    pub rev_share_bps: u16,
    pub rev_credential: Pubkey,
    pub rev_schema: Pubkey,
    pub round_secs: i64,
    pub rev_start: i64,
    pub pay_grace_secs: i64,
    pub tranche_min_revenue: u64,
    pub tranche_amount: u64,
    pub disclosure_period_secs: i64,
    pub request_min_bps: u16,
    pub assign_required: bool,
    pub assign_credential: Pubkey,
    pub assign_schema: Pubkey,
    pub window_secs: i64,
    pub recovery: Pubkey,
}

impl ExtParams {
    /// Rejects parameters that would give the team a back door: weak quorums, instant votes,
    /// a short sweep window, or a half-configured feature.
    pub fn validate(&self) -> Result<()> {
        if self.vote_period_secs != 0 {
            require!(
                self.vote_period_secs >= MIN_VOTE_PERIOD_SECS
                    && self.timelock_secs >= MIN_TIMELOCK_SECS
                    && self.quorum_bps >= MIN_QUORUM_BPS
                    && self.quorum_bps <= 10_000
                    && self.threshold_bps >= MIN_THRESHOLD_BPS
                    && self.threshold_bps < 10_000
                    && self.max_proposal_bps > 0
                    && self.max_proposal_bps <= 10_000
                    && self.proposer_min_bps <= 10_000,
                TreasuryError::InvalidParams
            );
        }
        if self.nav_period_secs != 0 {
            require!(
                self.nav_cap_bps > 0 && self.nav_cap_bps <= 10_000,
                TreasuryError::InvalidParams
            );
        }
        if self.rev_share_bps != 0 {
            require!(
                self.rev_share_bps <= 10_000
                    && self.round_secs > 0
                    && self.pay_grace_secs > 0
                    && self.rev_start > 0,
                TreasuryError::InvalidParams
            );
        }
        if self.tranche_amount != 0 {
            require!(self.rev_share_bps != 0, TreasuryError::InvalidParams);
        }
        if self.disclosure_period_secs != 0 {
            require!(
                self.disclosure_period_secs >= DAY && self.request_min_bps <= 10_000,
                TreasuryError::InvalidParams
            );
        }
        if self.window_secs != 0 {
            require!(
                self.window_secs >= MIN_WINDOW_SECS && self.recovery != Pubkey::default(),
                TreasuryError::InvalidParams
            );
        }
        // A stream shorter than an hour is no defence against staking for one block to catch a deposit.
        require!(
            self.stream_secs == 0 || self.stream_secs >= MIN_STREAM_SECS,
            TreasuryError::InvalidParams
        );
        require!(self.min_lockup_secs >= 0, TreasuryError::InvalidParams);
        Ok(())
    }
}

impl Ext {
    pub const OFFSET: usize = 8 + Treasury::INIT_SPACE;
    pub const SIZE: usize = Self::INIT_SPACE;
    /// Account length of a treasury that carries the tail.
    pub const TOTAL: usize = Self::OFFSET + Self::SIZE;

    pub fn new(p: &ExtParams, coin_vault_bump: u8, dist_vault_bump: u8) -> Self {
        Self {
            magic: EXT_MAGIC,
            coin_vault_bump,
            dist_vault_bump,
            vote_period_secs: p.vote_period_secs,
            timelock_secs: p.timelock_secs,
            quorum_bps: p.quorum_bps,
            threshold_bps: p.threshold_bps,
            max_proposal_bps: p.max_proposal_bps,
            proposer_min_bps: p.proposer_min_bps,
            proposal_count: 0,
            votes_locked: 0,
            total_staked: 0,
            grants_unreleased: 0,
            grant_count: 0,
            min_lockup_secs: p.min_lockup_secs,
            nav_open: false,
            nav_period_secs: p.nav_period_secs,
            nav_cap_bps: p.nav_cap_bps,
            nav_period_start: 0,
            nav_period_supply: 0,
            nav_burned: 0,
            insiders: p.insiders,
            acc_per_stake: 0,
            stream_secs: p.stream_secs,
            stream_amount: 0,
            stream_end: 0,
            stream_last: 0,
            rev_share_bps: p.rev_share_bps,
            rev_credential: p.rev_credential,
            rev_schema: p.rev_schema,
            round_secs: p.round_secs,
            rev_start: p.rev_start,
            pay_grace_secs: p.pay_grace_secs,
            missed_rounds: 0,
            tranche_min_revenue: p.tranche_min_revenue,
            tranche_amount: p.tranche_amount,
            disclosure_period_secs: p.disclosure_period_secs,
            last_disclosure_ts: 0,
            last_disclosure_hash: [0; 32],
            disclosures: 0,
            open_request_ts: 0,
            request_min_bps: p.request_min_bps,
            assign_required: p.assign_required,
            assigned: false,
            assign_credential: p.assign_credential,
            assign_schema: p.assign_schema,
            window_secs: p.window_secs,
            recovery: p.recovery,
            wind_start: 0,
            swept: false,
        }
    }

    pub fn is_insider(&self, key: &Pubkey, authority: &Pubkey) -> bool {
        key == authority
            || self
                .insiders
                .iter()
                .any(|i| *i != Pubkey::default() && i == key)
    }

    /// The conditions every outflow to the team (allowance spend, executed spend proposal, revenue
    /// tranche) must meet once the treasury is extended. NAV mode freezes team spending so that
    /// holders can redeem against an intact vault.
    pub fn guard_team_outflow(&self, now: i64) -> Result<()> {
        require!(!self.nav_open, TreasuryError::NavMode);
        require!(
            !self.assign_required || self.assigned,
            TreasuryError::AssignmentRequired
        );
        if self.disclosure_period_secs != 0 && self.open_request_ts != 0 {
            let due = self
                .open_request_ts
                .checked_add(self.disclosure_period_secs)
                .ok_or(TreasuryError::Overflow)?;
            require!(now <= due, TreasuryError::DisclosureOverdue);
        }
        Ok(())
    }
}

/// Reads the tail, if the account carries one.
#[inline(never)]
pub fn load(info: &AccountInfo) -> Result<Option<Ext>> {
    let data = info.try_borrow_data()?;
    if data.len() < Ext::TOTAL {
        return Ok(None);
    }
    let Some(tail) = data.get(Ext::OFFSET..Ext::TOTAL) else {
        return Ok(None);
    };
    if tail.get(..4) != Some(&EXT_MAGIC[..]) {
        return Ok(None);
    }
    let mut slice = tail;
    Ok(Some(Ext::deserialize(&mut slice)?))
}

/// Like [`load`], but the tail must exist.
#[inline(never)]
pub fn require(info: &AccountInfo) -> Result<Ext> {
    load(info)?.ok_or_else(|| error!(TreasuryError::NotExtended))
}

/// Writes the tail back. The account must already be long enough.
#[inline(never)]
pub fn store(info: &AccountInfo, ext: &Ext) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let tail = data
        .get_mut(Ext::OFFSET..Ext::TOTAL)
        .ok_or(TreasuryError::NotExtended)?;
    let mut w: &mut [u8] = tail;
    ext.serialize(&mut w)?;
    Ok(())
}
