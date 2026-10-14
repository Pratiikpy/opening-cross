//! Opening Cross backing watchdog (PRODUCT_FEATURES F6; ADR-0655).
//!
//! F6 asks for proof of backing for real assets and an automatic pause when the backing cannot be verified. This
//! program is the pause. For an asset whose issuer opted in, anyone can call `check`, and if the asset's attested
//! backing is missing, older than the issuer's limit, or below the issuer's coverage of the **live** token supply,
//! the watchdog halts the asset in `cross_core`. A halted asset does not print in an ordinary cross and resumes
//! only through a resume cross (ADR-0455), so the first price after a halt is a one-price auction.
//!
//! What it does not do, said once: it does not prove that a custodian holds what the attester signed. The attester is
//! named by the issuer in the policy and is whoever the issuer's holders are asked to trust. The chain can enforce
//! that the claim exists, is fresh, covers the supply as it is now and is made by the named key, and it halts when any
//! of those fail. Nothing more is claimed.
//!
//! How an issuer opts in: create the asset's halt state in `cross_core` with this program's `watchdog` PDA for the
//! mint as the venue signer, then call `create_policy`. Both are public and permanent, so a holder can read, before
//! buying, that the asset halts itself.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

declare_id!("HThrduwqRFvjHKPiQiRitsSw5yuGkXmAPkykAvMRQYkp");

// `cross_core`'s interface, from its IDL: the halt state and the `set_halt` call, without linking its code.
declare_program!(cross_core);

pub const POLICY_SEED: &[u8] = b"policy";
pub const ATTESTATION_SEED: &[u8] = b"attestation";
pub const WATCHDOG_SEED: &[u8] = b"watchdog";
const HALT_SEED: &[u8] = b"halt";
/// An attestation older than this can never be considered fresh, whatever a policy asks for: a policy must name an age
/// between a minute and thirty days.
pub const MIN_AGE_SECS: i64 = 60;
pub const MAX_AGE_SECS: i64 = 30 * 86_400;
/// Coverage a policy may demand, in basis points of the live supply: from 1% to 200%.
pub const MIN_COVERAGE_BPS: u16 = 100;
pub const MAX_COVERAGE_BPS: u16 = 20_000;
const BPS: u128 = 10_000;

#[program]
pub mod cross_backing {
    use super::*;

    /// Opts an asset in. Only the asset's halt-state authority can; the halt state must name this program's watchdog
    /// for the mint as its venue signer, or the policy could never act. The terms are fixed for good.
    pub fn create_policy(
        ctx: Context<CreatePolicy>,
        attester: Pubkey,
        min_coverage_bps: u16,
        max_age_secs: i64,
    ) -> Result<()> {
        require!(
            (MIN_COVERAGE_BPS..=MAX_COVERAGE_BPS).contains(&min_coverage_bps)
                && (MIN_AGE_SECS..=MAX_AGE_SECS).contains(&max_age_secs),
            BackingError::BadPolicy
        );
        let halt = read_halt(&ctx.accounts.halt)?;
        require_keys_eq!(
            halt.base_mint,
            ctx.accounts.mint.key(),
            BackingError::WrongHalt
        );
        require_keys_eq!(
            halt.authority,
            ctx.accounts.authority.key(),
            BackingError::Unauthorized
        );
        require!(
            halt.venue_signer == Some(ctx.accounts.watchdog.key()),
            BackingError::WatchdogNotVenueSigner
        );
        let p = &mut ctx.accounts.policy;
        p.mint = ctx.accounts.mint.key();
        p.attester = attester;
        p.min_coverage_bps = min_coverage_bps;
        p.max_age_secs = max_age_secs;
        p.bump = ctx.bumps.policy;
        emit!(PolicyCreated {
            policy: p.key(),
            mint: p.mint,
            attester,
            min_coverage_bps,
            max_age_secs
        });
        Ok(())
    }

    /// The attester states how much backing exists, in the mint's own atoms, as of now. The previous statement is
    /// replaced; the time is the chain's, never the attester's.
    pub fn attest(ctx: Context<Attest>, backing_atoms: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts.attestation;
        a.mint = ctx.accounts.policy.mint;
        a.backing_atoms = backing_atoms;
        a.posted_ts = now;
        a.bump = ctx.bumps.attestation;
        emit!(Attested {
            mint: a.mint,
            attester: ctx.accounts.attester.key(),
            backing_atoms,
            posted_ts: now
        });
        Ok(())
    }

    /// Halts the asset if its backing cannot be verified right now. Permissionless. Refuses (with `Backed`) when
    /// the backing is fresh and covers the live supply, so a call that changes nothing says so.
    pub fn check(ctx: Context<Check>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &ctx.accounts.policy;
        let supply = ctx.accounts.mint.supply;
        let verdict = match read_attestation(&ctx.accounts.attestation, &p.mint) {
            None => Verdict::Missing,
            Some(a) => verdict(
                a.backing_atoms,
                a.posted_ts,
                supply,
                now,
                p.min_coverage_bps,
                p.max_age_secs,
            ),
        };
        require!(verdict != Verdict::Backed, BackingError::Backed);
        let mint = p.mint;
        let bump = [ctx.bumps.watchdog];
        let seeds: &[&[u8]] = &[WATCHDOG_SEED, mint.as_ref(), &bump];
        cross_core::cpi::set_halt(CpiContext::new_with_signer(
            ctx.accounts.cross_core_program.key(),
            cross_core::cpi::accounts::SetHalt {
                signer: ctx.accounts.watchdog.to_account_info(),
                halt: ctx.accounts.halt.to_account_info(),
            },
            &[seeds],
        ))?;
        emit!(BackingFailed {
            mint,
            reason: verdict as u8,
            supply,
            checked_ts: now
        });
        Ok(())
    }
}

/// Why backing cannot be verified, or that it can. The numbers are part of the event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Verdict {
    Backed = 0,
    Missing = 1,
    Stale = 2,
    Short = 3,
}

/// The verdict on one attestation: stale first (an old figure says nothing about now), then the coverage of the live supply.
pub fn verdict(
    backing: u64,
    posted_ts: i64,
    supply: u64,
    now: i64,
    min_coverage_bps: u16,
    max_age_secs: i64,
) -> Verdict {
    match now.checked_sub(posted_ts) {
        Some(age) if (0..=max_age_secs).contains(&age) => {}
        _ => return Verdict::Stale,
    }
    // backing / supply >= min_coverage_bps / 10_000, without division.
    if u128::from(backing) * BPS < u128::from(supply) * u128::from(min_coverage_bps) {
        return Verdict::Short;
    }
    Verdict::Backed
}

fn read_halt(info: &UncheckedAccount) -> Result<cross_core::accounts::HaltState> {
    require_keys_eq!(*info.owner, cross_core::ID, BackingError::WrongHalt);
    let data = info.try_borrow_data()?;
    cross_core::accounts::HaltState::try_deserialize(&mut &data[..])
        .map_err(|_| error!(BackingError::WrongHalt))
}

/// The attestation account if it exists and belongs to this mint.
fn read_attestation(info: &UncheckedAccount, mint: &Pubkey) -> Option<Attestation> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    let a = Attestation::try_deserialize(&mut &data[..]).ok()?;
    (&a.mint == mint).then_some(a)
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub mint: Pubkey,
    pub attester: Pubkey,
    pub min_coverage_bps: u16,
    pub max_age_secs: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Attestation {
    pub mint: Pubkey,
    pub backing_atoms: u64,
    pub posted_ts: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CreatePolicy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the mint's halt state in `cross_core`; owner, mint, authority and venue signer are checked in the handler.
    #[account(seeds = [HALT_SEED, mint.key().as_ref()], bump, seeds::program = cross_core::ID)]
    pub halt: UncheckedAccount<'info>,
    /// CHECK: this program's watchdog PDA for the mint; it only has to be the halt state's venue signer.
    #[account(seeds = [WATCHDOG_SEED, mint.key().as_ref()], bump)]
    pub watchdog: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + Policy::INIT_SPACE, seeds = [POLICY_SEED, mint.key().as_ref()], bump)]
    pub policy: Box<Account<'info, Policy>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Attest<'info> {
    #[account(mut)]
    pub attester: Signer<'info>,
    #[account(seeds = [POLICY_SEED, policy.mint.as_ref()], bump = policy.bump, has_one = attester @ BackingError::Unauthorized)]
    pub policy: Box<Account<'info, Policy>>,
    #[account(init_if_needed, payer = attester, space = 8 + Attestation::INIT_SPACE, seeds = [ATTESTATION_SEED, policy.mint.as_ref()], bump)]
    pub attestation: Box<Account<'info, Attestation>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Check<'info> {
    #[account(seeds = [POLICY_SEED, mint.key().as_ref()], bump = policy.bump)]
    pub policy: Box<Account<'info, Policy>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the attestation PDA of the mint; absent or empty means "missing", which is itself a verdict.
    #[account(seeds = [ATTESTATION_SEED, mint.key().as_ref()], bump)]
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: the watchdog PDA signs the halt; it holds no data and no funds.
    #[account(seeds = [WATCHDOG_SEED, mint.key().as_ref()], bump)]
    pub watchdog: UncheckedAccount<'info>,
    /// CHECK: the mint's halt state in `cross_core`; `cross_core` checks it.
    #[account(mut, seeds = [HALT_SEED, mint.key().as_ref()], bump, seeds::program = cross_core::ID)]
    pub halt: UncheckedAccount<'info>,
    #[account(address = cross_core::ID)]
    pub cross_core_program: UncheckedAccount<'info>,
}

#[event]
pub struct PolicyCreated {
    pub policy: Pubkey,
    pub mint: Pubkey,
    pub attester: Pubkey,
    pub min_coverage_bps: u16,
    pub max_age_secs: i64,
}
#[event]
pub struct Attested {
    pub mint: Pubkey,
    pub attester: Pubkey,
    pub backing_atoms: u64,
    pub posted_ts: i64,
}
#[event]
pub struct BackingFailed {
    pub mint: Pubkey,
    /// 1 missing, 2 stale, 3 short of the coverage.
    pub reason: u8,
    pub supply: u64,
    pub checked_ts: i64,
}

#[error_code]
pub enum BackingError {
    #[msg("Coverage must be 1% to 200% and the age one minute to thirty days")]
    BadPolicy,
    #[msg("The halt state is not this mint's")]
    WrongHalt,
    #[msg("Only the halt state's authority can opt the asset in")]
    Unauthorized,
    #[msg("The halt state's venue signer is not this program's watchdog for the mint")]
    WatchdogNotVenueSigner,
    #[msg("The backing is fresh and covers the supply: nothing to halt")]
    Backed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_is_exact_at_the_boundary() {
        // 100% of a supply of 1,000.
        assert_eq!(verdict(1_000, 100, 1_000, 100, 10_000, 60), Verdict::Backed);
        assert_eq!(verdict(999, 100, 1_000, 100, 10_000, 60), Verdict::Short);
        // 150% demanded.
        assert_eq!(verdict(1_500, 0, 1_000, 0, 15_000, 60), Verdict::Backed);
        assert_eq!(verdict(1_499, 0, 1_000, 0, 15_000, 60), Verdict::Short);
        // More backing than needed is fine; a supply of zero is covered by anything.
        assert_eq!(verdict(0, 0, 0, 0, 10_000, 60), Verdict::Backed);
        assert_eq!(
            verdict(u64::MAX, 0, u64::MAX, 0, 10_000, 60),
            Verdict::Backed
        );
        assert_eq!(
            verdict(u64::MAX, 0, u64::MAX, 0, 20_000, 60),
            Verdict::Short
        );
        assert_eq!(
            verdict(u64::MAX, 0, u64::MAX / 2, 0, 20_000, 60),
            Verdict::Backed
        );
    }

    #[test]
    fn age_is_checked_before_coverage_and_a_future_stamp_is_not_trusted() {
        assert_eq!(verdict(1_000, 0, 1_000, 60, 10_000, 60), Verdict::Backed);
        assert_eq!(verdict(1_000, 0, 1_000, 61, 10_000, 60), Verdict::Stale);
        // Old and short: stale is reported.
        assert_eq!(verdict(1, 0, 1_000, 61, 10_000, 60), Verdict::Stale);
        // A timestamp in the future is not a fresh one.
        assert_eq!(verdict(1_000, 10, 1_000, 5, 10_000, 60), Verdict::Stale);
    }
}
