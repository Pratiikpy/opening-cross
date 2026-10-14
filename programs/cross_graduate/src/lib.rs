//! Opening Cross graduation votes (PRODUCT_FEATURES D10, Z0; ADR-0656).
//!
//! "Graduation by holder vote, gated on retention and organic volume, never on market cap." A cross whose creator set
//! `FLAG_GOVERNED_GRADUATION` before the first order (a rule, public and permanent, like every other) cannot be seeded
//! into a pool by its creator on his own: `cross_settle`'s seeding instructions refuse to open a pool for it unless this
//! program has published an **outcome** naming that venue. The outcome comes from a vote:
//!
//! - **Who votes, and retention.** Anyone who holds the cross's token locks it in the round's escrow for the whole voting
//!   window. A token that was sold cannot vote, and a token that votes cannot be sold until the window ends, so the vote
//!   is weighted by what holders actually kept. Votes are returned after the window.
//! - **Quorum.** Locked tokens must reach the charter's share of the token's live supply.
//! - **Majority.** The winning venue must hold a strict majority of what was locked; a tie fails.
//! - **Organic volume.** When the charter asks for it, a named attester must have posted a volume of at least the charter's
//!   minimum before the round is finalized. The program cannot measure organic volume; the charter says who does.
//! - **Never market cap.** No price or valuation enters any condition.
//!
//! A failed round can be followed by another, up to three, started by the creator. A passed one cannot be undone.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("47f6BhDPCxmW9C9DuuMS2VnbCoU4wnSvjReEwy9Zdke7");

// `cross_core`'s interface, from its IDL: the cross account, without linking its code.
declare_program!(cross_core);

pub const CHARTER_SEED: &[u8] = b"charter";
pub const ROUND_SEED: &[u8] = b"round";
pub const VOTE_SEED: &[u8] = b"vote";
pub const OUTCOME_SEED: &[u8] = b"outcome";
/// Venues a round can choose between: 0 DAMM v2, 1 DLMM, 2 Raydium CPMM, 3 MetaDAO futarchy (the order of `cross_settle`'s adapters).
pub const VENUES: usize = 4;
pub const MIN_WINDOW_SECS: i64 = 3 * 86_400;
pub const MAX_WINDOW_SECS: i64 = 30 * 86_400;
/// The lowest quorum a charter may ask for: 10% of the live supply.
pub const MIN_QUORUM_BPS: u16 = 1_000;
pub const MAX_ROUNDS: u8 = 3;
const BPS: u128 = 10_000;

// Where `cross_core` keeps the rule flags this program reads (ADR-0450): the cross body, then the extension tail: a
// version byte, `rules_set`, `created_slot` (8) and `flags` (2). The host tests pin these against the real types.
/// Size of a cross account's body: discriminator plus the `Cross` struct.
pub const CROSS_BODY: usize = 668;
const TAIL_VERSION: u8 = 1;
const TAIL_FLAGS: usize = 10;
/// `cross_core::ext::FLAG_GOVERNED_GRADUATION`.
pub const FLAG_GOVERNED_GRADUATION: u16 = 1 << 5;

#[program]
pub mod cross_graduate {
    use super::*;

    /// Binds a cross's graduation to a vote. The creator, before the first order, on a cross that carries
    /// `FLAG_GOVERNED_GRADUATION`. The terms cannot change.
    pub fn init_charter(
        ctx: Context<InitCharter>,
        quorum_bps: u16,
        window_secs: i64,
        min_volume: u64,
        volume_attester: Option<Pubkey>,
    ) -> Result<()> {
        require!(
            (MIN_QUORUM_BPS..=10_000).contains(&quorum_bps)
                && (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs),
            GraduateError::BadCharter
        );
        require!(
            min_volume == 0 || volume_attester.is_some(),
            GraduateError::BadCharter
        );
        let data = ctx.accounts.cross.try_borrow_data()?;
        let cross = read_cross(&ctx.accounts.cross, &data)?;
        require_keys_eq!(
            cross.creator,
            ctx.accounts.creator.key(),
            GraduateError::NotTheCreator
        );
        require!(
            matches!(cross.state, cross_core::types::CrossState::Live) && cross.orders_total == 0,
            GraduateError::TooLate
        );
        require!(governed(&data), GraduateError::NotGoverned);
        drop(data);
        let c = &mut ctx.accounts.charter;
        c.cross = ctx.accounts.cross.key();
        c.creator = ctx.accounts.creator.key();
        c.quorum_bps = quorum_bps;
        c.window_secs = window_secs;
        c.min_volume = min_volume;
        c.volume_attester = volume_attester;
        c.rounds = 0;
        c.active = false;
        c.passed = false;
        c.bump = ctx.bumps.charter;
        emit!(CharterCreated {
            charter: c.key(),
            cross: c.cross,
            quorum_bps,
            window_secs,
            min_volume,
            volume_attester
        });
        Ok(())
    }

    /// Opens a voting round once the cross is finalized and its token exists. The creator only: a round that fails
    /// uses one of three attempts, so it is not left to anyone who might want to burn them.
    pub fn start_round(ctx: Context<StartRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.charter;
        require!(!c.passed, GraduateError::AlreadyPassed);
        require!(!c.active, GraduateError::RoundOpen);
        require!(c.rounds < MAX_ROUNDS, GraduateError::NoRoundsLeft);
        let data = ctx.accounts.cross.try_borrow_data()?;
        let cross = read_cross(&ctx.accounts.cross, &data)?;
        require!(
            matches!(cross.state, cross_core::types::CrossState::Finalized) && cross.base_bound,
            GraduateError::CrossNotFinalized
        );
        require_keys_eq!(
            cross.base_mint,
            ctx.accounts.base_mint.key(),
            GraduateError::WrongMint
        );
        let r = &mut ctx.accounts.round;
        r.cross = c.cross;
        r.index = c.rounds;
        r.base_mint = cross.base_mint;
        r.base_token_program = cross.base_token_program;
        r.opens_ts = now;
        r.closes_ts = now
            .checked_add(c.window_secs)
            .ok_or(GraduateError::Overflow)?;
        r.quorum_bps = c.quorum_bps;
        r.min_volume = c.min_volume;
        r.volume_attester = c.volume_attester;
        r.tallies = [0; VENUES];
        r.locked_total = 0;
        r.volume_quote = 0;
        r.volume_set = false;
        r.finalized = false;
        r.passed = false;
        r.winner = 0;
        r.bump = ctx.bumps.round;
        c.rounds += 1;
        c.active = true;
        emit!(RoundStarted {
            round: r.key(),
            cross: r.cross,
            index: r.index,
            closes_ts: r.closes_ts
        });
        Ok(())
    }

    /// Locks `amount` of the token for the whole window behind one venue. A voter can add to its stake, never change venue.
    pub fn cast_vote<'info>(
        ctx: Context<'info, CastVote<'info>>,
        venue: u8,
        amount: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &ctx.accounts.round;
        require!(
            !r.finalized && now >= r.opens_ts && now < r.closes_ts,
            GraduateError::NotVoting
        );
        require!(usize::from(venue) < VENUES, GraduateError::UnknownVenue);
        require!(amount > 0, GraduateError::NothingToDo);
        let v = &mut ctx.accounts.vote;
        if v.voter == Pubkey::default() {
            v.voter = ctx.accounts.voter.key();
            v.round = ctx.accounts.round.key();
            v.venue = venue;
            v.amount = 0;
            v.bump = ctx.bumps.vote;
        }
        require!(v.venue == venue, GraduateError::VenueLocked);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.voter_token.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                    authority: ctx.accounts.voter.to_account_info(),
                },
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.base_mint.decimals,
        )?;
        ctx.accounts.escrow.reload()?;
        let v = &mut ctx.accounts.vote;
        v.amount = v
            .amount
            .checked_add(amount)
            .ok_or(GraduateError::Overflow)?;
        let r = &mut ctx.accounts.round;
        r.tallies[usize::from(venue)] = r.tallies[usize::from(venue)]
            .checked_add(amount)
            .ok_or(GraduateError::Overflow)?;
        r.locked_total = r
            .locked_total
            .checked_add(amount)
            .ok_or(GraduateError::Overflow)?;
        emit!(VoteCast {
            round: ctx.accounts.round.key(),
            voter: ctx.accounts.voter.key(),
            venue,
            amount,
            locked_total: ctx.accounts.round.locked_total
        });
        Ok(())
    }

    /// The charter's volume attester states the organic volume (in quote atoms) as of now. The latest statement counts.
    pub fn post_volume(ctx: Context<PostVolume>, volume_quote: u64) -> Result<()> {
        let r = &mut ctx.accounts.round;
        require!(!r.finalized, GraduateError::NotVoting);
        require!(
            r.volume_attester == Some(ctx.accounts.attester.key()),
            GraduateError::Unauthorized
        );
        r.volume_quote = volume_quote;
        r.volume_set = true;
        emit!(VolumePosted {
            round: r.key(),
            volume_quote
        });
        Ok(())
    }

    /// Settles a round after its window. Permissionless. Passed or failed is decided by `decide` alone.
    pub fn finalize_round(ctx: Context<FinalizeRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.round;
        require!(!r.finalized, GraduateError::NotVoting);
        require!(now >= r.closes_ts, GraduateError::WindowOpen);
        let verdict = decide(
            r.locked_total,
            ctx.accounts.base_mint.supply,
            r.quorum_bps,
            &r.tallies,
            r.min_volume,
            r.volume_set.then_some(r.volume_quote),
        );
        r.finalized = true;
        let c = &mut ctx.accounts.charter;
        c.active = false;
        match verdict {
            Some(winner) => {
                r.passed = true;
                r.winner = winner;
                c.passed = true;
            }
            None => r.passed = false,
        }
        emit!(RoundFinalized {
            round: r.key(),
            passed: r.passed,
            winner: r.winner,
            locked_total: r.locked_total,
            supply: ctx.accounts.base_mint.supply
        });
        Ok(())
    }

    /// Publishes the outcome of a passed round, which is what `cross_settle` reads. Permissionless; once.
    pub fn publish_outcome(ctx: Context<PublishOutcome>) -> Result<()> {
        let r = &ctx.accounts.round;
        require!(r.finalized && r.passed, GraduateError::NotPassed);
        let o = &mut ctx.accounts.outcome;
        o.cross = r.cross;
        o.venue = r.winner;
        o.round = r.index;
        o.published_ts = Clock::get()?.unix_timestamp;
        o.bump = ctx.bumps.outcome;
        emit!(OutcomePublished {
            outcome: o.key(),
            cross: o.cross,
            venue: o.venue
        });
        Ok(())
    }

    /// Returns a voter's tokens once the window has closed.
    pub fn withdraw_vote<'info>(ctx: Context<'info, WithdrawVote<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let r = &ctx.accounts.round;
        require!(now >= r.closes_ts, GraduateError::WindowOpen);
        let amount = ctx.accounts.vote.amount;
        let cross = r.cross;
        let index = [r.index];
        let bump = [r.bump];
        let seeds: &[&[u8]] = &[ROUND_SEED, cross.as_ref(), &index, &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.voter_token.to_account_info(),
                    authority: ctx.accounts.round.to_account_info(),
                },
                &[seeds],
            )
            .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
            amount,
            ctx.accounts.base_mint.decimals,
        )?;
        emit!(VoteWithdrawn {
            round: ctx.accounts.round.key(),
            voter: ctx.accounts.voter.key(),
            amount
        });
        Ok(())
    }
}

/// The verdict on a round: the winning venue, or `None`. Quorum, then strict majority of what was locked, then volume.
pub fn decide(
    locked_total: u64,
    supply: u64,
    quorum_bps: u16,
    tallies: &[u64; VENUES],
    min_volume: u64,
    volume: Option<u64>,
) -> Option<u8> {
    if locked_total == 0 {
        return None;
    }
    if u128::from(locked_total) * BPS < u128::from(supply) * u128::from(quorum_bps) {
        return None;
    }
    let (winner, best) = tallies
        .iter()
        .enumerate()
        .max_by_key(|(i, t)| (**t, std::cmp::Reverse(*i)))?;
    // A strict majority of what was locked: a 50/50 split has no winner.
    if u128::from(*best) * 2 <= u128::from(locked_total) {
        return None;
    }
    if min_volume > 0 && volume.is_none_or(|v| v < min_volume) {
        return None;
    }
    u8::try_from(winner).ok()
}

fn read_cross(info: &UncheckedAccount, data: &[u8]) -> Result<cross_core::accounts::Cross> {
    require_keys_eq!(*info.owner, cross_core::ID, GraduateError::NotACross);
    cross_core::accounts::Cross::try_deserialize(&mut &data[..])
        .map_err(|_| error!(GraduateError::NotACross))
}

/// Whether the cross's rules carry `FLAG_GOVERNED_GRADUATION`.
pub fn governed(cross_data: &[u8]) -> bool {
    let Some(tail) = cross_data.get(CROSS_BODY..) else {
        return false;
    };
    if tail.first().copied() != Some(TAIL_VERSION) || tail.get(1).copied() != Some(1) {
        return false;
    }
    tail.get(TAIL_FLAGS..TAIL_FLAGS + 2)
        .and_then(|b| <[u8; 2]>::try_from(b).ok())
        .map(u16::from_le_bytes)
        .is_some_and(|f| f & FLAG_GOVERNED_GRADUATION != 0)
}

#[account]
#[derive(InitSpace)]
pub struct Charter {
    pub cross: Pubkey,
    pub creator: Pubkey,
    pub quorum_bps: u16,
    pub window_secs: i64,
    pub min_volume: u64,
    pub volume_attester: Option<Pubkey>,
    /// Rounds started so far.
    pub rounds: u8,
    /// A round is open or waiting to be finalized.
    pub active: bool,
    /// A round passed.
    pub passed: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub cross: Pubkey,
    pub index: u8,
    pub base_mint: Pubkey,
    pub base_token_program: Pubkey,
    pub opens_ts: i64,
    pub closes_ts: i64,
    pub quorum_bps: u16,
    pub min_volume: u64,
    pub volume_attester: Option<Pubkey>,
    pub tallies: [u64; VENUES],
    pub locked_total: u64,
    pub volume_quote: u64,
    pub volume_set: bool,
    pub finalized: bool,
    pub passed: bool,
    pub winner: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub voter: Pubkey,
    pub round: Pubkey,
    pub venue: u8,
    pub amount: u64,
    pub bump: u8,
}

/// What `cross_settle` reads: the venue a passed round chose for this cross.
#[account]
#[derive(InitSpace)]
pub struct Outcome {
    pub cross: Pubkey,
    pub venue: u8,
    pub round: u8,
    pub published_ts: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitCharter<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = 8 + Charter::INIT_SPACE, seeds = [CHARTER_SEED, cross.key().as_ref()], bump)]
    pub charter: Box<Account<'info, Charter>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartRound<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    #[account(mut, has_one = creator @ GraduateError::NotTheCreator, has_one = cross @ GraduateError::WrongCross, seeds = [CHARTER_SEED, cross.key().as_ref()], bump = charter.bump)]
    pub charter: Box<Account<'info, Charter>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + Round::INIT_SPACE, seeds = [ROUND_SEED, cross.key().as_ref(), &[charter.rounds]], bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer = creator, associated_token::mint = base_mint, associated_token::authority = round, associated_token::token_program = token_program)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(mut, has_one = base_mint @ GraduateError::WrongMint, seeds = [ROUND_SEED, round.cross.as_ref(), &[round.index]], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = base_mint, token::authority = voter, token::token_program = token_program)]
    pub voter_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = base_mint, associated_token::authority = round, associated_token::token_program = token_program)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = voter, space = 8 + VoteRecord::INIT_SPACE, seeds = [VOTE_SEED, round.key().as_ref(), voter.key().as_ref()], bump)]
    pub vote: Box<Account<'info, VoteRecord>>,
    #[account(address = round.base_token_program @ GraduateError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PostVolume<'info> {
    pub attester: Signer<'info>,
    #[account(mut, seeds = [ROUND_SEED, round.cross.as_ref(), &[round.index]], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

#[derive(Accounts)]
pub struct FinalizeRound<'info> {
    #[account(mut, has_one = base_mint @ GraduateError::WrongMint, seeds = [ROUND_SEED, round.cross.as_ref(), &[round.index]], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, constraint = charter.cross == round.cross @ GraduateError::WrongCross, seeds = [CHARTER_SEED, round.cross.as_ref()], bump = charter.bump)]
    pub charter: Box<Account<'info, Charter>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
}

#[derive(Accounts)]
pub struct PublishOutcome<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ROUND_SEED, round.cross.as_ref(), &[round.index]], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(init, payer = payer, space = 8 + Outcome::INIT_SPACE, seeds = [OUTCOME_SEED, round.cross.as_ref()], bump)]
    pub outcome: Box<Account<'info, Outcome>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawVote<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(has_one = base_mint @ GraduateError::WrongMint, seeds = [ROUND_SEED, round.cross.as_ref(), &[round.index]], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, close = voter, has_one = voter @ GraduateError::Unauthorized, constraint = vote.round == round.key() @ GraduateError::WrongCross, seeds = [VOTE_SEED, round.key().as_ref(), voter.key().as_ref()], bump = vote.bump)]
    pub vote: Box<Account<'info, VoteRecord>>,
    #[account(mut, associated_token::mint = base_mint, associated_token::authority = round, associated_token::token_program = token_program)]
    pub escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = base_mint, token::authority = voter, token::token_program = token_program)]
    pub voter_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = round.base_token_program @ GraduateError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct CharterCreated {
    pub charter: Pubkey,
    pub cross: Pubkey,
    pub quorum_bps: u16,
    pub window_secs: i64,
    pub min_volume: u64,
    pub volume_attester: Option<Pubkey>,
}
#[event]
pub struct RoundStarted {
    pub round: Pubkey,
    pub cross: Pubkey,
    pub index: u8,
    pub closes_ts: i64,
}
#[event]
pub struct VoteCast {
    pub round: Pubkey,
    pub voter: Pubkey,
    pub venue: u8,
    pub amount: u64,
    pub locked_total: u64,
}
#[event]
pub struct VolumePosted {
    pub round: Pubkey,
    pub volume_quote: u64,
}
#[event]
pub struct RoundFinalized {
    pub round: Pubkey,
    pub passed: bool,
    pub winner: u8,
    pub locked_total: u64,
    pub supply: u64,
}
#[event]
pub struct OutcomePublished {
    pub outcome: Pubkey,
    pub cross: Pubkey,
    pub venue: u8,
}
#[event]
pub struct VoteWithdrawn {
    pub round: Pubkey,
    pub voter: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum GraduateError {
    #[msg("A charter needs a quorum of at least 10%, a window of 3 to 30 days, and an attester when it asks for volume")]
    BadCharter,
    #[msg("Only the creator of the cross can do this")]
    NotTheCreator,
    #[msg("A charter must be created before the first order, while the cross is live")]
    TooLate,
    #[msg("The cross does not carry the governed-graduation rule")]
    NotGoverned,
    #[msg("A round already passed")]
    AlreadyPassed,
    #[msg("A round is open or waiting to be finalized")]
    RoundOpen,
    #[msg("All three rounds were used")]
    NoRoundsLeft,
    #[msg("The cross must be finalized and its token must exist")]
    CrossNotFinalized,
    #[msg("The round is not open for votes")]
    NotVoting,
    #[msg("There is no such venue")]
    UnknownVenue,
    #[msg("A voter cannot change venue within a round")]
    VenueLocked,
    #[msg("The voting window has not closed")]
    WindowOpen,
    #[msg("The round did not pass")]
    NotPassed,
    #[msg("Nothing to do")]
    NothingToDo,
    #[msg("The account is not a cross")]
    NotACross,
    #[msg("The account is not the cross or the token of this charter")]
    WrongCross,
    #[msg("The token is not the cross's token")]
    WrongMint,
    #[msg("Signer is not allowed to do this")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    #[test]
    fn a_strict_majority_of_a_quorum_wins() {
        // 1,000 supply, 20% quorum: 200 locked.
        assert_eq!(
            decide(200, 1_000, 2_000, &[101, 99, 0, 0], 0, None),
            Some(0)
        );
        // 100 of 200 is not a majority.
        assert_eq!(decide(200, 1_000, 2_000, &[100, 100, 0, 0], 0, None), None);
        assert_eq!(decide(200, 1_000, 2_000, &[100, 99, 1, 0], 0, None), None);
        // One atom under the quorum.
        assert_eq!(decide(199, 1_000, 2_000, &[199, 0, 0, 0], 0, None), None);
        assert_eq!(decide(200, 1_000, 2_000, &[0, 0, 200, 0], 0, None), Some(2));
        assert_eq!(
            decide(200, 1_000, 2_000, &[10, 20, 30, 140], 0, None),
            Some(3)
        );
        // Four ways to split 200: no strict majority.
        assert_eq!(decide(200, 1_000, 2_000, &[50, 50, 50, 50], 0, None), None);
        // Nothing locked never passes, even against a supply of zero.
        assert_eq!(decide(0, 0, 1_000, &[0, 0, 0, 0], 0, None), None);
    }

    #[test]
    fn volume_is_required_when_the_charter_asks_for_it() {
        let t = [150, 50, 0, 0];
        assert_eq!(decide(200, 1_000, 2_000, &t, 500, None), None);
        assert_eq!(decide(200, 1_000, 2_000, &t, 500, Some(499)), None);
        assert_eq!(decide(200, 1_000, 2_000, &t, 500, Some(500)), Some(0));
        // A charter that does not ask ignores any figure.
        assert_eq!(decide(200, 1_000, 2_000, &t, 0, None), Some(0));
    }

    #[test]
    fn no_overflow_in_the_quorum_or_the_majority() {
        let big = u64::MAX;
        assert_eq!(decide(big, big, 10_000, &[big, 0, 0, 0], 0, None), Some(0));
        assert_eq!(
            decide(big, big, 10_000, &[big / 2, big / 2, 1, 0], 0, None),
            None
        );
    }

    /// The rule flag this program reads must be where the real `cross_core` keeps it.
    #[test]
    fn flag_offset_matches_cross_core() {
        assert_eq!(CROSS_BODY, ::cross_core::ext::CROSS_BODY);
        assert_eq!(TAIL_VERSION, ::cross_core::ext::EXT_VERSION);
        assert_eq!(
            FLAG_GOVERNED_GRADUATION,
            ::cross_core::ext::FLAG_GOVERNED_GRADUATION
        );
        let encode = |flags: u16, rules_set: bool, version: u8| {
            let ext = ::cross_core::ext::CrossExt {
                version,
                rules_set,
                flags,
                ..Default::default()
            };
            let mut data = vec![0u8; CROSS_BODY];
            ext.serialize(&mut data).unwrap();
            data
        };
        assert!(governed(&encode(FLAG_GOVERNED_GRADUATION, true, 1)));
        assert!(governed(&encode(
            FLAG_GOVERNED_GRADUATION | ::cross_core::ext::FLAG_RESUMES_HALT,
            true,
            1
        )));
        assert!(!governed(&encode(
            ::cross_core::ext::FLAG_RESUMES_HALT,
            true,
            1
        )));
        assert!(!governed(&encode(FLAG_GOVERNED_GRADUATION, false, 1)));
        assert!(!governed(&encode(FLAG_GOVERNED_GRADUATION, true, 2)));
        assert!(!governed(&vec![0u8; CROSS_BODY]));
        assert!(!governed(&[]));
    }
}
