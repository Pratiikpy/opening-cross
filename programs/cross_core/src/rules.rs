//! `set_rules`: the rules of a cross, fixed in the slot it is created (ADR-0450 to ADR-0454).
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};

use crate::{
    ext::{
        self, AllocationRules, CrossExt, EndingRules, GuardRules, IdentityRules, NeutralityRules,
        NeutralityState, OracleSet, ReferralRules,
    },
    feed, halt, lock,
    state::*,
    CrossError,
};

/// Flags a creator may set.
const SETTABLE_FLAGS: u16 = ext::FLAG_RESUMES_HALT
    | ext::FLAG_FEEDS_LENDERS
    | ext::FLAG_STANDARD_GRID
    | ext::FLAG_GUARD_SCALED_UI;

/// The widest the off-hours widening of the oracle band can be: 50%.
const MAX_WIDEN_BPS: u32 = 5_000;

/// The longest extension a cross can ask for: 7 days.
const MAX_EXTENSION_SECS: u32 = 7 * 24 * 60 * 60;

/// The largest move the price-move guard accepts: 500%.
const MAX_MOVE_BPS: u16 = 50_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct RulesInput {
    pub flags: u16,
    pub guards: GuardRules,
    pub ending: EndingRules,
    pub identity: IdentityRules,
    pub alloc: AllocationRules,
    pub neutrality: NeutralityRules,
    pub referral: ReferralRules,
    pub oracle_set: OracleSet,
}

/// Declared insiders as `set_rules` takes them: only the ones named, where the stored form is padded to
/// `MAX_INSIDERS`. A transaction holding `create_cross` and `set_rules` together must fit in 1,232 bytes, and the
/// padding alone is 256 of them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct NeutralityInput {
    pub insiders: Vec<Pubkey>,
    pub insider_cliff_secs: u32,
    pub insider_vest_secs: u32,
    pub bond_quote: u64,
    pub challenge_secs: u32,
}

/// The extra oracle feeds as `set_rules` takes them: only the ones named (see [`NeutralityInput`]).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct OracleSetInput {
    pub extra_feeds: Vec<[u8; 32]>,
    pub quorum: u8,
    pub max_spread_bps: u32,
    pub off_hours_widen_bps: u32,
}

/// The argument of `set_rules`: the same rules as [`RulesInput`] with the two padded lists sent unpadded, so that
/// the instruction and `create_cross` fit one transaction. [`CompactRules::into_input`] pads them and every check
/// runs on the padded form, as for a series.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct CompactRules {
    pub flags: u16,
    pub guards: GuardRules,
    pub ending: EndingRules,
    pub identity: IdentityRules,
    pub alloc: AllocationRules,
    pub neutrality: NeutralityInput,
    pub referral: ReferralRules,
    pub oracle_set: OracleSetInput,
}

impl CompactRules {
    pub fn into_input(self) -> Result<RulesInput> {
        let n = self.neutrality;
        require!(
            n.insiders.len() <= ext::MAX_INSIDERS,
            CrossError::InvalidParams
        );
        let mut insiders = [Pubkey::default(); ext::MAX_INSIDERS];
        insiders[..n.insiders.len()].copy_from_slice(&n.insiders);
        let o = self.oracle_set;
        require!(o.extra_feeds.len() <= 2, CrossError::InvalidParams);
        let mut extra_feeds = [[0u8; 32]; 2];
        extra_feeds[..o.extra_feeds.len()].copy_from_slice(&o.extra_feeds);
        Ok(RulesInput {
            flags: self.flags,
            guards: self.guards,
            ending: self.ending,
            identity: self.identity,
            alloc: self.alloc,
            neutrality: NeutralityRules {
                insiders,
                insider_count: u8::try_from(n.insiders.len()).map_err(|_| CrossError::Overflow)?,
                insider_cliff_secs: n.insider_cliff_secs,
                insider_vest_secs: n.insider_vest_secs,
                bond_quote: n.bond_quote,
                challenge_secs: n.challenge_secs,
            },
            referral: self.referral,
            oracle_set: OracleSet {
                extra_feeds,
                extra_count: u8::try_from(o.extra_feeds.len()).map_err(|_| CrossError::Overflow)?,
                quorum: o.quorum,
                max_spread_bps: o.max_spread_bps,
                off_hours_widen_bps: o.off_hours_widen_bps,
            },
        })
    }
}

#[derive(Accounts)]
pub struct SetRules<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut)]
    pub cross: Box<Account<'info, Cross>>,
}

pub fn set_rules<'info>(ctx: Context<'info, SetRules<'info>>, input: CompactRules) -> Result<()> {
    let input = input.into_input()?;
    require_keys_eq!(
        ctx.accounts.cross.creator,
        ctx.accounts.creator.key(),
        CrossError::Unauthorized
    );
    apply(
        &ctx.accounts.cross,
        input,
        ctx.remaining_accounts,
        Some(&ctx.accounts.creator.to_account_info()),
    )
}

/// Validates `input` against the cross and stores it in the tail. `bond_signer` signs for the insider
/// bond; a caller that cannot sign (a series spawning a cross) passes `None` and the rules may not
/// ask for a bond.
pub fn apply<'info>(
    c: &Account<'info, Cross>,
    input: RulesInput,
    remaining_accounts: &'info [AccountInfo<'info>],
    bond_signer: Option<&AccountInfo<'info>>,
) -> Result<()> {
    require!(
        c.state == CrossState::Live && c.orders_total == 0,
        CrossError::RulesLocked
    );
    let info = c.to_account_info();
    let mut x = ext::read_raw(&info)?;
    require!(x.version != 0, CrossError::LegacyCross);
    require!(
        !x.rules_set && Clock::get()?.slot == x.created_slot,
        CrossError::RulesLocked
    );
    let mut g = input.guards;
    let flags = input.flags;
    require!(flags & !SETTABLE_FLAGS == 0, CrossError::InvalidParams);
    let deferred = c.supply_mode == SupplyMode::DeferredMint;
    let mut remaining = remaining_accounts.iter();

    if g.max_matched > 0 {
        require!(c.supply_mode.mints(), CrossError::InvalidParams);
    }
    if flags & (ext::FLAG_RESUMES_HALT | ext::FLAG_FEEDS_LENDERS) != 0 || g.halt_source.is_some() {
        require!(!deferred, CrossError::InvalidParams);
    }
    if let Some(h) = g.halt_source {
        let (pda, _) =
            Pubkey::find_program_address(&[halt::HALT_SEED, c.base_mint.as_ref()], &crate::ID);
        require_keys_eq!(h, pda, CrossError::HaltMismatch);
    }
    if flags & ext::FLAG_RESUMES_HALT != 0 {
        // A print lifts the halt, so only the parties the halt state names may run such a cross: otherwise
        // anyone could lift a halt with a wash cross of their own (ADR-0455).
        let source = g.halt_source.ok_or(CrossError::InvalidParams)?;
        let acc = remaining.next().ok_or(CrossError::HaltMismatch)?;
        require_keys_eq!(acc.key(), source, CrossError::HaltMismatch);
        let h = halt::load(acc, &c.base_mint)?;
        require!(
            c.creator == h.authority || h.venue_signer == Some(c.creator),
            CrossError::Unauthorized
        );
    }
    if flags & ext::FLAG_FEEDS_LENDERS != 0 {
        let feed_account = remaining.next().ok_or(CrossError::FeedMismatch)?;
        let f = feed::load(feed_account, &c.base_mint, &c.quote_mint)?;
        require!(f.is_publisher(&c.creator), CrossError::Unauthorized);
    }

    // Raise, float and valuation rules.
    require!(g.min_float_bps <= 10_000, CrossError::InvalidParams);
    require!(
        g.max_fdv_x100 == 0 || g.max_fdv_x100 >= 100,
        CrossError::InvalidParams
    );
    if g.min_float_bps > 0 || g.max_fdv_x100 > 0 {
        // The supply is declared, or read from the base mint at the clear (not possible for a
        // mint that does not exist yet).
        require!(g.total_supply > 0 || !deferred, CrossError::InvalidParams);
    }

    // Standard grid: reserve at half the estimate, ticks of at most one percent of it.
    if flags & ext::FLAG_STANDARD_GRID != 0 {
        require!(g.grid_estimate > 0, CrossError::InvalidParams);
        let reserve_ok = c
            .min_price
            .checked_mul(2)
            .is_some_and(|twice| twice >= g.grid_estimate);
        let tick_ok = c
            .tick
            .checked_mul(100)
            .is_some_and(|hundred| hundred <= g.grid_estimate);
        let top = c.max_price().ok_or(CrossError::Overflow)?;
        require!(
            reserve_ok && tick_ok && g.grid_estimate <= top,
            CrossError::GridPolicy
        );
    }

    // Price-move guard: the anchor is the explicit anchor, else the reopen reference, else the
    // grid estimate.
    if g.move_bps > 0 {
        require!(g.move_bps <= MAX_MOVE_BPS, CrossError::InvalidParams);
        let anchor = if g.anchor_price > 0 {
            g.anchor_price
        } else if let Some(r) = c.reference_price {
            r
        } else {
            g.grid_estimate
        };
        require!(anchor > 0, CrossError::InvalidParams);
        g.anchor_price = anchor;
    } else {
        g.anchor_price = 0;
    }

    // The ending (ADR-0452).
    let e = input.ending;
    if e.ending_secs > 0 {
        let call = c.close_ts.saturating_sub(c.open_ts);
        require!(
            (1..=ext::MAX_BUCKETS).contains(&e.buckets)
                && e.ending_secs >= u32::from(e.buckets)
                && i64::from(e.ending_secs) < call,
            CrossError::InvalidParams
        );
        require!(!e.random_end || e.buckets >= 2, CrossError::InvalidParams);
    } else {
        require!(e.buckets == 0 && !e.random_end, CrossError::InvalidParams);
    }
    if e.extension_max_secs > 0 {
        require!(
            e.extension_min_secs > 0
                && e.extension_min_secs <= e.extension_max_secs
                && e.extension_max_secs <= MAX_EXTENSION_SECS,
            CrossError::InvalidParams
        );
    } else {
        require!(e.extension_min_secs == 0, CrossError::InvalidParams);
    }

    // Identity limits (ADR-0453): an identity is a gate-pass holder.
    let id = input.identity;
    if id.cap_quote > 0 || id.max_orders > 0 {
        require!(c.gate_mint.is_some(), CrossError::InvalidParams);
    }

    // Allocation classes (ADR-0453) are for launches: the unsold remainder is the issuer's, so
    // the rounding dust needs no bond.
    let a = input.alloc;
    let shares: u32 = a.reserve_bps.iter().map(|b| u32::from(*b)).sum();
    require!(shares <= 10_000, CrossError::InvalidParams);
    let classes = shares > 0 || a.lottery_unit > 0;
    if classes {
        require!(c.supply_mode.mints(), CrossError::InvalidParams);
    }
    require!(
        (a.reserve_bps[0] == 0 || a.small_cap_quote > 0)
            && (a.small_cap_quote == 0 || c.gate_mint.is_some())
            && (a.reserve_bps[1] == 0 || a.min_lock_secs > 0)
            && (a.reserve_bps[2] == 0 || a.early_until_ts > 0 || a.priority_gate.is_some())
            && (a.lottery_unit == 0 || (a.small_cap_quote > 0 && a.reserve_bps[0] > 0)),
        CrossError::InvalidParams
    );
    require!(
        a.early_until_ts == 0 || (a.early_until_ts > c.open_ts && a.early_until_ts < c.close_ts),
        CrossError::InvalidParams
    );
    require!(
        a.min_lock_secs <= lock::MAX_LOCK_SECS
            && a.lock_vest_secs <= lock::MAX_LOCK_SECS
            && a.class1_cliff_secs <= lock::MAX_LOCK_SECS
            && a.class1_vest_secs <= lock::MAX_LOCK_SECS,
        CrossError::InvalidParams
    );
    // Class-1 vesting needs a class 1.
    require!(
        (a.class1_cliff_secs == 0 && a.class1_vest_secs == 0) || a.small_cap_quote > 0,
        CrossError::InvalidParams
    );
    // A locked fill is paid out of the lock vault by a plain token transfer, which a transfer hook (the mint a
    // deferred-mint continuation creates) would refuse for want of its extra accounts: no locks there (ADR-0454).
    let locks = a.min_lock_secs > 0
        || a.class1_cliff_secs > 0
        || a.class1_vest_secs > 0
        || input.neutrality.insider_cliff_secs > 0
        || input.neutrality.insider_vest_secs > 0;
    require!(!(locks && deferred), CrossError::InvalidParams);

    // Issuer neutrality (ADR-0454).
    let mut n = input.neutrality;
    let count = usize::from(n.insider_count);
    require!(count <= ext::MAX_INSIDERS, CrossError::InvalidParams);
    for (i, ins) in n.insiders.iter().enumerate() {
        if i < count {
            require!(
                *ins != Pubkey::default() && !n.insiders[..i].contains(ins),
                CrossError::InvalidParams
            );
        } else {
            require!(*ins == Pubkey::default(), CrossError::InvalidParams);
        }
    }
    require!(
        n.insider_cliff_secs <= lock::MAX_LOCK_SECS && n.insider_vest_secs <= lock::MAX_LOCK_SECS,
        CrossError::InvalidParams
    );
    if n.bond_quote > 0 {
        let signer = bond_signer.ok_or(CrossError::InvalidParams)?;
        require!(
            (crate::neutral::MIN_CHALLENGE_SECS..=crate::neutral::MAX_CHALLENGE_SECS)
                .contains(&n.challenge_secs),
            CrossError::InvalidParams
        );
        // The bond is posted now, from the creator, into the cross's quote vault.
        let creator_quote = remaining.next().ok_or(CrossError::TokenAccountMissing)?;
        let vault = remaining.next().ok_or(CrossError::WrongVault)?;
        let quote_mint = remaining.next().ok_or(CrossError::WrongMint)?;
        let program = remaining.next().ok_or(CrossError::WrongMint)?;
        let (vault_pda, _) =
            Pubkey::find_program_address(&[QUOTE_VAULT_SEED, c.key().as_ref()], &crate::ID);
        require_keys_eq!(vault.key(), vault_pda, CrossError::WrongVault);
        require_keys_eq!(quote_mint.key(), c.quote_mint, CrossError::WrongMint);
        require_keys_eq!(program.key(), c.quote_token_program, CrossError::WrongMint);
        token_interface::transfer_checked(
            CpiContext::new(
                program.key(),
                TransferChecked {
                    from: creator_quote.clone(),
                    mint: quote_mint.clone(),
                    to: vault.clone(),
                    authority: signer.clone(),
                },
            ),
            n.bond_quote,
            c.quote_decimals,
        )?;
    } else {
        require!(n.challenge_secs == 0, CrossError::InvalidParams);
    }
    n.insider_count = u8::try_from(count).map_err(|_| CrossError::Overflow)?;

    // A scaled-UI-amount mint: remember its multiplier now; a change before the clear voids the print (ADR-0459).
    if flags & ext::FLAG_GUARD_SCALED_UI != 0 {
        require!(!deferred, CrossError::InvalidParams);
        let mint = remaining.next().ok_or(CrossError::WrongMint)?;
        require_keys_eq!(mint.key(), c.base_mint, CrossError::WrongMint);
        let now = Clock::get()?.unix_timestamp;
        g.multiplier_bits = halt::scaled_ui_multiplier(&mint.try_borrow_data()?, now)
            .ok_or(CrossError::InvalidParams)?;
    } else {
        g.multiplier_bits = 0;
    }

    // More than one oracle (ADR-0459): the cross's own guard names the first feed, these add up to two.
    let os = input.oracle_set;
    let extras = usize::from(os.extra_count);
    if os == OracleSet::default() {
        // nothing to check
    } else {
        let primary = c.oracle.ok_or(CrossError::InvalidParams)?;
        require!(extras <= 2, CrossError::InvalidParams);
        let sources = extras.checked_add(1).ok_or(CrossError::Overflow)?;
        require!(
            usize::from(os.quorum) >= 1 && usize::from(os.quorum) <= sources,
            CrossError::InvalidParams
        );
        for (i, f) in os.extra_feeds.iter().enumerate() {
            if i < extras {
                require!(
                    *f != [0u8; 32] && *f != primary.feed_id && !os.extra_feeds[..i].contains(f),
                    CrossError::InvalidParams
                );
            } else {
                require!(*f == [0u8; 32], CrossError::InvalidParams);
            }
        }
        require!(
            os.off_hours_widen_bps <= MAX_WIDEN_BPS,
            CrossError::InvalidParams
        );
        require!(
            extras > 0 || (os.max_spread_bps == 0 && os.quorum == 1),
            CrossError::InvalidParams
        );
        if os.off_hours_widen_bps > 0 {
            require!(c.calendar.is_some(), CrossError::InvalidParams);
        }
        // A cross on a calendar may only use feeds that calendar approves (create_cross checks the first).
        if extras > 0 && c.calendar.is_some() {
            let acc = remaining.next().ok_or(CrossError::CalendarMismatch)?;
            require_keys_eq!(
                acc.key(),
                c.calendar.ok_or(CrossError::CalendarMismatch)?,
                CrossError::CalendarMismatch
            );
            require_keys_eq!(*acc.owner, cross_calendar::ID, CrossError::CalendarMismatch);
            let cal = cross_calendar::Calendar::try_deserialize(&mut &acc.try_borrow_data()?[..])?;
            for f in os.extra_feeds.iter().take(extras) {
                require!(cal.approves_feed(f), CrossError::FeedNotApproved);
            }
        }
    }

    // Referral (ADR-0460): a share of the protocol fee, never more than half of it.
    let referral = input.referral;
    if referral.share_bps > 0 {
        require!(
            referral.share_bps <= ext::MAX_REFERRAL_BPS && referral.referrer != Pubkey::default(),
            CrossError::InvalidParams
        );
    } else {
        require!(
            referral.referrer == Pubkey::default(),
            CrossError::InvalidParams
        );
    }
    x = CrossExt {
        rules_set: true,
        referral,
        oracle_set: os,
        flags,
        guards: g,
        ending: e,
        identity: id,
        alloc: a,
        neutrality: n,
        neutral_state: NeutralityState {
            bond_held: n.bond_quote,
            ..NeutralityState::default()
        },
        ..x
    };
    ext::write(&info, &x)?;
    emit!(RulesSet {
        cross: c.key(),
        flags,
        guards: g,
        ending: e,
        identity: id,
        alloc: a,
        insiders: n.insider_count,
        bond_quote: n.bond_quote
    });
    Ok(())
}

#[event]
pub struct RulesSet {
    pub cross: Pubkey,
    pub flags: u16,
    pub guards: GuardRules,
    pub ending: EndingRules,
    pub identity: IdentityRules,
    pub alloc: AllocationRules,
    pub insiders: u8,
    pub bond_quote: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpadded_lists_are_padded_and_counted() {
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut input = CompactRules::default();
        input.neutrality.insiders = vec![a, b];
        input.oracle_set.extra_feeds = vec![[7u8; 32]];
        input.oracle_set.quorum = 1;
        let r = input.into_input().unwrap();
        assert_eq!(r.neutrality.insider_count, 2);
        assert_eq!(&r.neutrality.insiders[..2], &[a, b]);
        assert!(r.neutrality.insiders[2..]
            .iter()
            .all(|k| *k == Pubkey::default()));
        assert_eq!(r.oracle_set.extra_count, 1);
        assert_eq!(r.oracle_set.extra_feeds, [[7u8; 32], [0u8; 32]]);
    }

    #[test]
    fn empty_lists_equal_the_default_rules() {
        let r = CompactRules::default().into_input().unwrap();
        assert_eq!(r.neutrality, NeutralityRules::default());
        assert_eq!(r.oracle_set, OracleSet::default());
    }

    #[test]
    fn too_long_lists_are_refused() {
        let mut input = CompactRules::default();
        input.neutrality.insiders = vec![Pubkey::new_unique(); ext::MAX_INSIDERS + 1];
        assert!(input.into_input().is_err());
        let mut input = CompactRules::default();
        input.oracle_set.extra_feeds = vec![[1u8; 32]; 3];
        assert!(input.into_input().is_err());
    }
}
