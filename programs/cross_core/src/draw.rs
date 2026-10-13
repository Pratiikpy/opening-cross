//! Randomness for the ending and the extension (ADR-0452).
//!
//! A draw is two permissionless steps so that nobody can pick the moment that gives them a
//! favourable number. `draw_begin` records the current slot, after the last order and the last
//! reveal that can affect the outcome. `draw_finish`, at least `DRAW_DELAY_SLOTS` later, hashes
//! the bank hashes the cluster recorded in the `SlotHashes` sysvar at four slots spread over
//! sixteen slots after that point. The four slots fall in different leaders' turns (a leader
//! produces four consecutive slots), so no single block producer controls the result; moving it
//! would take the cooperation of all four, each giving up a block.
//!
//! This is randomness the chain itself attests. It is not a verifiable random function; a cross
//! that needs one can name a VRF account in its rules (ADR-0452, "stronger sources").
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::{
    ext::{self, NO_BUCKET},
    state::*,
    CrossError,
};

/// Slots between `draw_begin` and the first hash a draw may use.
pub const DRAW_DELAY_SLOTS: u64 = 20;
/// The hashes used are those of the first recorded slots at or after `begin + 4k`, k = 1..=4.
const STRIDE: u64 = 4;
/// A draw that is not finished within this many slots of its start is void and may be restarted
/// (the sysvar keeps 512 slots).
pub const DRAW_WINDOW_SLOTS: u64 = 400;
/// How far past its target slot a recorded hash may be (skipped slots leave gaps).
const MAX_SKIP: u64 = 32;

/// The `SlotHashes` sysvar.
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

const PURPOSE_END: u8 = 1;
const PURPOSE_EXTENSION: u8 = 2;

#[derive(Accounts)]
pub struct DrawBegin<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
}

#[derive(Accounts)]
pub struct DrawFinish<'info> {
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
    /// CHECK: the `SlotHashes` sysvar, read as raw bytes (the sysvar is too large to deserialize).
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

pub fn draw_begin(ctx: Context<DrawBegin>) -> Result<()> {
    let c = &mut ctx.accounts.cross;
    require!(c.state == CrossState::Live, CrossError::WrongState);
    let clock = Clock::get()?;
    let info = c.to_account_info();
    let mut x = ext::read(&info)?;
    if x.draw.pending_slot > 0 {
        require!(
            clock.slot > x.draw.pending_slot.saturating_add(DRAW_WINDOW_SLOTS),
            CrossError::DrawPending
        );
    }
    let purpose = if x.draw.ext_pending {
        PURPOSE_EXTENSION
    } else if x.needs_draw()
        && !(x.draw.seed_ready && x.draw.seed_epoch == x.draw.epoch)
        && clock.unix_timestamp >= c.reveal_end_ts
    {
        PURPOSE_END
    } else {
        return err!(CrossError::NothingToDraw);
    };
    x.draw.pending_slot = clock.slot;
    x.draw.pending_purpose = purpose;
    ext::write(&info, &x)?;
    emit!(DrawStarted {
        cross: c.key(),
        slot: clock.slot,
        purpose
    });
    Ok(())
}

pub fn draw_finish(ctx: Context<DrawFinish>) -> Result<()> {
    let c = &mut ctx.accounts.cross;
    require!(c.state == CrossState::Live, CrossError::WrongState);
    let clock = Clock::get()?;
    let info = c.to_account_info();
    let mut x = ext::read(&info)?;
    let begun = x.draw.pending_slot;
    require!(begun > 0, CrossError::NothingToDraw);
    require!(
        clock.slot >= begun.saturating_add(DRAW_DELAY_SLOTS),
        CrossError::DrawPending
    );
    let hashes = {
        let data = ctx.accounts.slot_hashes.try_borrow_data()?;
        sample(&data, begun)?
    };
    let epoch = x.draw.epoch;
    let purpose = x.draw.pending_purpose;
    let seed = hashv(&[
        b"opening-cross/draw/v1",
        c.key().as_ref(),
        &[epoch, purpose],
        &hashes[0].1,
        &hashes[1].1,
        &hashes[2].1,
        &hashes[3].1,
    ])
    .to_bytes();
    x.draw.pending_slot = 0;
    x.draw.pending_purpose = 0;
    x.draw.seed = seed;

    let mut end_bucket = None;
    let mut extended_to = None;
    if purpose == PURPOSE_END {
        x.draw.seed_ready = true;
        x.draw.seed_epoch = epoch;
        if x.ending.random_end && epoch == 0 {
            let b = u64::from_le_bytes(seed[0..8].try_into().map_err(|_| CrossError::Overflow)?)
                .checked_rem(u64::from(x.ending.buckets))
                .ok_or(CrossError::InvalidParams)?;
            x.draw.end_bucket = u8::try_from(b).map_err(|_| CrossError::Overflow)?;
            end_bucket = Some(x.draw.end_bucket);
        }
    } else {
        // The extension opens a second window of a drawn length, starting now.
        let min = u64::from(x.ending.extension_min_secs);
        let span = u64::from(x.ending.extension_max_secs)
            .checked_sub(min)
            .and_then(|d| d.checked_add(1))
            .ok_or(CrossError::InvalidParams)?;
        let extra = u64::from_le_bytes(seed[8..16].try_into().map_err(|_| CrossError::Overflow)?)
            .checked_rem(span)
            .ok_or(CrossError::InvalidParams)?;
        let len = i64::try_from(min.checked_add(extra).ok_or(CrossError::Overflow)?)
            .map_err(|_| CrossError::Overflow)?;
        let reveal_span = c.reveal_end_ts.saturating_sub(c.close_ts);
        let old_reveal_end = c.reveal_end_ts;
        c.close_ts = clock.unix_timestamp.saturating_add(len);
        c.reveal_end_ts = c.close_ts.saturating_add(reveal_span);
        if c.settle_deadline_ts > 0 {
            c.settle_deadline_ts = c
                .settle_deadline_ts
                .saturating_add(c.reveal_end_ts.saturating_sub(old_reveal_end));
        }
        x.draw.epoch = x.draw.epoch.saturating_add(1);
        x.draw.ext_pending = false;
        x.draw.extension_used = true;
        x.draw.seed_ready = false;
        extended_to = Some(c.close_ts);
    }
    ext::write(&info, &x)?;
    emit!(DrawFinished {
        cross: c.key(),
        purpose,
        epoch,
        begun_slot: begun,
        sampled_slots: [hashes[0].0, hashes[1].0, hashes[2].0, hashes[3].0],
        seed,
        end_bucket: end_bucket.unwrap_or(NO_BUCKET),
        close_ts: extended_to.unwrap_or(c.close_ts)
    });
    Ok(())
}

/// For `k = 1..=4`, the first recorded slot at or after `begun + 4k` and its hash. Fails unless
/// the sysvar still reaches back to every target (so "the first recorded slot at or after" is
/// really the first), and unless each hash is within `MAX_SKIP` slots of its target.
pub fn sample(data: &[u8], begun: u64) -> Result<[(u64, [u8; 32]); 4]> {
    let count = usize::try_from(read_u64(data, 0)?).map_err(|_| CrossError::DrawExpired)?;
    let entry = |i: usize| -> Result<(u64, [u8; 32])> {
        let at = 8usize
            .checked_add(i.checked_mul(40).ok_or(CrossError::Overflow)?)
            .ok_or(CrossError::Overflow)?;
        let slot = read_u64(data, at)?;
        let hash: [u8; 32] = data
            .get(at + 8..at + 40)
            .and_then(|h| h.try_into().ok())
            .ok_or(CrossError::DrawExpired)?;
        Ok((slot, hash))
    };
    require!(count > 0, CrossError::DrawExpired);
    // Entries are newest first; the last one is the oldest the sysvar still holds.
    let oldest = entry(count - 1)?.0;
    let mut out = [(0u64, [0u8; 32]); 4];
    for (k, slot_out) in out.iter_mut().enumerate() {
        let target = begun
            .checked_add(STRIDE * (u64::try_from(k).map_err(|_| CrossError::Overflow)? + 1))
            .ok_or(CrossError::Overflow)?;
        require!(oldest <= target, CrossError::DrawExpired);
        // Entries are sorted newest first, so those at or after the target form a prefix; the
        // first recorded slot at or after the target is the last entry of that prefix.
        let (mut lo, mut hi) = (0usize, count);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if entry(mid)?.0 >= target {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let found = lo.checked_sub(1).map(entry).transpose()?;
        let e = found.ok_or(CrossError::DrawExpired)?;
        require!(e.0 - target <= MAX_SKIP, CrossError::DrawExpired);
        *slot_out = e;
    }
    Ok(out)
}

fn read_u64(data: &[u8], at: usize) -> Result<u64> {
    let end = at.checked_add(8).ok_or(CrossError::Overflow)?;
    let b: [u8; 8] = data
        .get(at..end)
        .and_then(|b| b.try_into().ok())
        .ok_or(CrossError::DrawExpired)?;
    Ok(u64::from_le_bytes(b))
}

#[event]
pub struct DrawStarted {
    pub cross: Pubkey,
    pub slot: u64,
    pub purpose: u8,
}

#[event]
pub struct DrawFinished {
    pub cross: Pubkey,
    pub purpose: u8,
    pub epoch: u8,
    pub begun_slot: u64,
    pub sampled_slots: [u64; 4],
    pub seed: [u8; 32],
    pub end_bucket: u8,
    pub close_ts: i64,
}
