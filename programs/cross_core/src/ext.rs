//! The extension tail of a cross and of an order (ADR-0450).
//!
//! `Cross` and `Order` are unchanged. A cross created by this version of the program is allocated
//! `CROSS_SPACE` bytes: the `Cross` struct, then a `CrossExt` in the bytes after it. Anchor's
//! `Account<Cross>` reads and writes only the struct's own bytes, so the tail is invisible to it
//! and to every decoder generated from the IDL. A cross created by an earlier version has no tail
//! and reads as the default (every rule off). Orders work the same way with `OrderExt`.
use anchor_lang::prelude::*;

use crate::state::*;

/// Version of the tail layout. A different layout is a new version with a reader for the old one.
pub const EXT_VERSION: u8 = 1;

/// A print by this cross lifts the halt on its base mint (ADR-0455).
pub const FLAG_RESUMES_HALT: u16 = 1 << 1;
/// A print by this cross updates the base mint's lender price feed (ADR-0451).
pub const FLAG_FEEDS_LENDERS: u16 = 1 << 2;
/// The price grid follows the standard policy (ADR-0451): reserve at half the issuer's estimate,
/// ticks of at most one percent of it.
pub const FLAG_STANDARD_GRID: u16 = 1 << 3;
/// The base mint carries a Token-2022 scaled-UI-amount extension, and a change of its multiplier (a split, a
/// dividend) between the creation of the cross and its clear voids the print (ADR-0459, PRODUCT_FEATURES C5).
pub const FLAG_GUARD_SCALED_UI: u16 = 1 << 4;

/// Marks "no bucket": the order was placed before the ending period (or the cross has none).
pub const NO_BUCKET: u8 = 255;
/// Ending buckets a cross can have; their shards are numbered `AUX_END_BASE + bucket`.
pub const MAX_BUCKETS: u8 = 8;
/// Shard index of ending bucket 0; main shards are `0..32`.
pub const AUX_END_BASE: u8 = 32;
/// Shard index of extension shard 0.
pub const AUX_EXT_BASE: u8 = 40;
/// Extension shards a cross can have.
pub const MAX_EXT_SHARDS: u8 = 8;
/// Declared insiders a cross can name.
pub const MAX_INSIDERS: usize = 8;
/// The most of the protocol fee a referrer can be promised: 50%.
pub const MAX_REFERRAL_BPS: u16 = 5_000;
/// Order flag: the owner is a declared insider.
pub const ORDER_INSIDER: u8 = 1;

/// Rules that decide whether a cleared cross prints (ADR-0451). Zero switches a rule off.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct GuardRules {
    /// Minimum raise in quote atoms.
    pub min_raise_quote: u64,
    /// Hard cap on the base the sell side delivers (mint modes without sells).
    pub max_matched: u64,
    /// Declared fully diluted supply in base atoms; read from the base mint when zero and the
    /// mint is known at the clear.
    pub total_supply: u64,
    pub min_float_bps: u16,
    pub max_fdv_x100: u32,
    /// Anchor for the price-move guard; resolved at `set_rules` from the explicit anchor, the
    /// reference price or the grid estimate, in that order.
    pub anchor_price: u64,
    pub move_bps: u16,
    /// The issuer's estimate that the standard grid is built around.
    pub grid_estimate: u64,
    /// Halt state of the base mint; a halted or corporate-action mint does not print.
    pub halt_source: Option<Pubkey>,
    /// The multiplier of the base mint's scaled-UI-amount extension when the rules were set (`FLAG_GUARD_SCALED_UI`):
    /// the bits of the `f64`, compared for equality and never used in arithmetic.
    pub multiplier_bits: u64,
}

/// Several oracles for one reopen (PRODUCT_FEATURES C1, VM9, C3): the cross's own `OracleGuard` names the first
/// Pyth feed; these name up to two more. The reference price is the median of the fresh, fully verified prices, the
/// guard needs a quorum of them, and outside the calendar's sessions the divergence bound is wider.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct OracleSet {
    pub extra_feeds: [[u8; 32]; 2],
    pub extra_count: u8,
    /// How many of the `1 + extra_count` prices must be usable (1 when there are no extra feeds).
    pub quorum: u8,
    /// The most the usable prices may differ from one another, in basis points of the lowest (0 = no limit).
    pub max_spread_bps: u32,
    /// Added to the divergence bound while no session of the cross's calendar is open (0 = no widening).
    pub off_hours_widen_bps: u32,
}

/// The hard-to-game ending (ADR-0452). Zero switches a part off.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct EndingRules {
    /// Length of the ending period that closes the call. Orders placed in it are bucketed.
    pub ending_secs: u32,
    /// Equal sub-windows of the ending period, `1..=MAX_BUCKETS` when `ending_secs > 0`.
    pub buckets: u8,
    /// No cancellation from this many seconds before the ending period starts.
    pub cancel_cutoff_secs: u32,
    /// The last counted bucket is drawn after the call: orders in later buckets are refunded.
    pub random_end: bool,
    /// A failed clear may extend the call once by a random length in this range.
    pub extension_min_secs: u32,
    pub extension_max_secs: u32,
}

/// Draw bookkeeping (ADR-0452): which randomness is pending or settled, and what it decided.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct DrawState {
    /// 0 for the call as created, 1 once the extension has opened a second window.
    pub epoch: u8,
    /// Slot at which an unfinished draw began; 0 = none.
    pub pending_slot: u64,
    /// 1 = the draw that closes an epoch, 2 = the draw that sets the extension length.
    pub pending_purpose: u8,
    pub seed: [u8; 32],
    pub seed_epoch: u8,
    pub seed_ready: bool,
    /// Last counted ending bucket; `NO_BUCKET` until drawn (all buckets count).
    pub end_bucket: u8,
    /// A clear failed its guards and the extension is waiting for its draw.
    pub ext_pending: bool,
    pub extension_used: bool,
    /// Merged auxiliary shards: bit `i` = ending bucket `i`, bit `8 + j` = extension shard `j`.
    pub aux_merged: u64,
}

impl Default for DrawState {
    fn default() -> Self {
        Self {
            epoch: 0,
            pending_slot: 0,
            pending_purpose: 0,
            seed: [0; 32],
            seed_epoch: 0,
            seed_ready: false,
            end_bucket: NO_BUCKET,
            ext_pending: false,
            extension_used: false,
            aux_merged: 0,
        }
    }
}

/// Per-identity limits (ADR-0453). They need a gated cross: an identity is the wallet that holds
/// the cross's gate pass, and a cap without an identity is theatre.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct IdentityRules {
    /// Most quote an identity may have escrowed in buy orders at once (0 = no cap).
    pub cap_quote: u64,
    /// Most live orders an identity may have (0 = no limit; 1 = one application per identity).
    pub max_orders: u8,
}

/// How the volume at the margin is shared (ADR-0453).
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct AllocationRules {
    /// Shares of the marginal volume reserved for classes 1, 2 and 3, in basis points.
    pub reserve_bps: [u16; 3],
    /// Class 1 (identity-verified small orders): an order's escrow may not exceed this.
    pub small_cap_quote: u64,
    /// Class 1 lottery: base atoms per lot (0 = pro-rata within the class). Every class-1 order
    /// is then exactly one lot.
    pub lottery_unit: u64,
    /// Class 2 (locked orders): the shortest lock a buyer may choose.
    pub min_lock_secs: u32,
    /// Class 2: linear vesting after the lock, in seconds (0 = everything unlocks at once).
    pub lock_vest_secs: u32,
    /// Class 3 by early commitment: orders placed before this time qualify (0 = off).
    pub early_until_ts: i64,
    /// Class 3 by status: the gate mint whose pass qualifies a wallet (a holder or supporter
    /// credential).
    pub priority_gate: Option<Pubkey>,
    /// Class 1 vesting (identity-bound vesting): fills unlock after this cliff...
    pub class1_cliff_secs: u32,
    /// ...and then vest linearly over this many seconds.
    pub class1_vest_secs: u32,
}

/// Issuer neutrality (ADR-0454): declared insiders and the bond behind the declaration.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct NeutralityRules {
    pub insiders: [Pubkey; MAX_INSIDERS],
    pub insider_count: u8,
    /// Insider fills unlock after this cliff and vest over `insider_vest_secs`.
    pub insider_cliff_secs: u32,
    pub insider_vest_secs: u32,
    /// Quote the creator posts behind the declaration; slashed on an upheld challenge.
    pub bond_quote: u64,
    /// How long after the clear a challenge may be raised.
    pub challenge_secs: u32,
}

/// Bond bookkeeping.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct NeutralityState {
    pub bond_held: u64,
    pub slashed: u64,
    pub open_challenges: u16,
    /// Challenges filed so far; the next one's id.
    pub challenges: u32,
}

/// Figures recorded at the clear when allocation classes or insiders are in play.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct ClearingExt {
    /// Quantity of classes 1, 2 and 3 among the marginal buy orders.
    pub class_qty: [u64; 3],
    /// Class-1 orders at the marginal tick (lottery tickets).
    pub tickets: u32,
    /// Where the lottery window starts.
    pub rho: u32,
    pub cleared_ts: i64,
    /// Upper bound on declared insiders' allocation (left out of the minimum raise).
    pub insider_ub: u64,
}

/// A referral: the share of the protocol fee that goes to the referrer (PRODUCT_FEATURES W4, W6).
/// It comes out of the protocol's fee only; the integrator's fee and every bidder's price are untouched.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct ReferralRules {
    pub referrer: Pubkey,
    /// Basis points of the protocol fee, at most `MAX_REFERRAL_BPS`.
    pub share_bps: u16,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct CrossExt {
    /// 0 = no tail (a legacy cross, or one whose tail was never initialised).
    pub version: u8,
    pub rules_set: bool,
    /// Slot of the creating transaction; `set_rules` is only accepted in that slot.
    pub created_slot: u64,
    pub flags: u16,
    pub guards: GuardRules,
    pub ending: EndingRules,
    pub draw: DrawState,
    pub identity: IdentityRules,
    pub alloc: AllocationRules,
    pub neutrality: NeutralityRules,
    pub neutral_state: NeutralityState,
    pub clearing: ClearingExt,
    /// Referral: a share of the protocol fee paid to whoever brought the cross (ADR-0460).
    pub referral: ReferralRules,
    /// More oracles than one (ADR-0459).
    pub oracle_set: OracleSet,
}

impl CrossExt {
    pub fn has(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }

    /// Whether orders on this cross carry an `OrderExt`.
    pub fn order_tail(&self) -> bool {
        self.ending.ending_secs > 0
            || self.ending.extension_max_secs > 0
            || self.uses_class_book()
            || self.alloc.min_lock_secs > 0
            || self.alloc.class1_vest_secs > 0
            || self.alloc.class1_cliff_secs > 0
    }

    /// Whether orders are tallied by class and insider status in the class book.
    pub fn uses_class_book(&self) -> bool {
        self.alloc.reserve_bps.iter().any(|b| *b > 0)
            || self.alloc.lottery_unit > 0
            || self.neutrality.insider_count > 0
    }

    /// Whether the clear reads the base mint: for a halt state, for the supply, or for a scaled-UI multiplier.
    pub fn reads_mint_at_clear(&self) -> bool {
        self.guards.halt_source.is_some()
            || (self.guards.total_supply == 0
                && (self.guards.min_float_bps > 0 || self.guards.max_fdv_x100 > 0))
            || self.has(FLAG_GUARD_SCALED_UI)
    }

    pub fn uses_identity(&self) -> bool {
        self.identity.cap_quote > 0 || self.identity.max_orders > 0
    }

    /// Whether a draw must settle before the cross can clear.
    pub fn needs_draw(&self) -> bool {
        self.ending.random_end || self.alloc.lottery_unit > 0
    }

    pub fn policy(&self) -> clearing_core::AllocPolicy {
        clearing_core::AllocPolicy {
            reserve_bps: self.alloc.reserve_bps,
            lottery_unit: self.alloc.lottery_unit,
        }
    }

    pub fn is_insider(&self, owner: &Pubkey) -> bool {
        self.neutrality
            .insiders
            .iter()
            .take(usize::from(self.neutrality.insider_count))
            .any(|i| i == owner)
    }

    /// Last counted ending bucket: the drawn one, or the final bucket when nothing is drawn.
    pub fn last_bucket(&self) -> u8 {
        if self.draw.end_bucket == NO_BUCKET {
            self.ending.buckets.saturating_sub(1)
        } else {
            self.draw.end_bucket
        }
    }

    /// Start of the ending period of the first window.
    pub fn ending_start(&self, close_ts: i64) -> i64 {
        close_ts.saturating_sub(i64::from(self.ending.ending_secs))
    }

    /// Time from which an order can no longer be cancelled.
    pub fn cancel_deadline(&self, close_ts: i64) -> i64 {
        close_ts
            .saturating_sub(i64::from(self.ending.ending_secs))
            .saturating_sub(i64::from(self.ending.cancel_cutoff_secs))
    }

    /// Epoch and ending bucket an order placed at `now` belongs to.
    pub fn placement(&self, close_ts: i64, now: i64) -> (u8, u8) {
        if self.draw.epoch > 0 {
            return (self.draw.epoch, NO_BUCKET);
        }
        if self.ending.ending_secs == 0 {
            return (0, NO_BUCKET);
        }
        let start = self.ending_start(close_ts);
        if now < start {
            return (0, NO_BUCKET);
        }
        let into = u128::try_from(now.saturating_sub(start)).unwrap_or(0);
        let b = into
            .saturating_mul(u128::from(self.ending.buckets))
            .checked_div(u128::from(self.ending.ending_secs))
            .unwrap_or(0);
        let last = u128::from(self.ending.buckets.saturating_sub(1));
        (0, u8::try_from(b.min(last)).unwrap_or(0))
    }

    /// Extension shards in use: one per main shard, at most `MAX_EXT_SHARDS`.
    pub fn ext_shards(&self, main_shards: u8) -> u8 {
        main_shards.clamp(1, MAX_EXT_SHARDS)
    }

    /// Shard index an order with this placement writes to.
    pub fn shard_index(&self, c: &Cross, owner: &Pubkey, nonce: u64, epoch: u8, bucket: u8) -> u8 {
        if epoch > 0 {
            let n = self.ext_shards(c.shards);
            let h = crate::shard_of(owner, nonce, n);
            return AUX_EXT_BASE.saturating_add(u8::try_from(h).unwrap_or(0));
        }
        if bucket != NO_BUCKET {
            return AUX_END_BASE.saturating_add(bucket);
        }
        u8::try_from(crate::shard_of(owner, nonce, c.shards)).unwrap_or(0)
    }

    /// Whether `index` is a shard this cross can have.
    pub fn valid_shard_index(&self, c: &Cross, index: u8) -> bool {
        if index < c.shards {
            return true;
        }
        if (AUX_END_BASE..AUX_END_BASE.saturating_add(MAX_BUCKETS)).contains(&index) {
            return self.ending.ending_secs > 0 && index - AUX_END_BASE < self.ending.buckets;
        }
        if (AUX_EXT_BASE..AUX_EXT_BASE.saturating_add(MAX_EXT_SHARDS)).contains(&index) {
            return self.ending.extension_max_secs > 0
                && index - AUX_EXT_BASE < self.ext_shards(c.shards);
        }
        false
    }

    /// Auxiliary shards that must be merged before the cross can clear.
    pub fn required_aux(&self, main_shards: u8) -> u64 {
        let mut mask = 0u64;
        if self.ending.ending_secs > 0 {
            for b in 0..=self.last_bucket() {
                mask |= 1 << b;
            }
        }
        if self.draw.epoch > 0 {
            for j in 0..self.ext_shards(main_shards) {
                mask |= 1 << (8 + u32::from(j));
            }
        }
        mask
    }

    /// Bit of an auxiliary shard in `aux_merged`.
    pub fn aux_bit(index: u8) -> u64 {
        if index >= AUX_EXT_BASE {
            1 << (8 + u32::from(index - AUX_EXT_BASE))
        } else {
            1 << u32::from(index - AUX_END_BASE)
        }
    }

    /// Whether the order was placed in an ending bucket the draw left out.
    pub fn excludes(&self, o: &OrderExt) -> bool {
        self.ending.ending_secs > 0
            && o.epoch == 0
            && o.bucket != NO_BUCKET
            && o.bucket > self.last_bucket()
    }
}

/// Per-order extension: where in the call an order was placed and what it asked for.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct OrderExt {
    pub version: u8,
    pub epoch: u8,
    pub bucket: u8,
    /// Allocation class: 0 general, 1 identity-verified small, 2 locked, 3 priority.
    pub class: u8,
    pub flags: u8,
    /// Lock applied to the fill: unlocks after `lock_cliff` seconds and vests over `lock_vest`.
    pub lock_cliff: u32,
    pub lock_vest: u32,
    pub placed_ts: i64,
    /// Class-1 lottery ticket: the order's number among the class-1 orders at its tick.
    pub ticket: u32,
}

impl Default for OrderExt {
    fn default() -> Self {
        Self {
            version: 0,
            epoch: 0,
            bucket: NO_BUCKET,
            class: 0,
            flags: 0,
            lock_cliff: 0,
            lock_vest: 0,
            placed_ts: 0,
            ticket: 0,
        }
    }
}

impl OrderExt {
    pub fn is_insider(&self) -> bool {
        self.flags & ORDER_INSIDER != 0
    }

    /// Whether the fill of this order is locked.
    pub fn locked(&self) -> bool {
        self.lock_cliff > 0 || self.lock_vest > 0
    }
}

/// Bytes of the `Cross` struct including the account discriminator.
pub const CROSS_BODY: usize = 8 + Cross::INIT_SPACE;
/// Bytes reserved for the cross tail.
pub const EXT_SPACE: usize = CrossExt::INIT_SPACE;
/// Account size of a new cross.
pub const CROSS_SPACE: usize = CROSS_BODY + EXT_SPACE;
/// Bytes of the `Order` struct including the account discriminator.
pub const ORDER_BODY: usize = 8 + Order::INIT_SPACE;
/// Bytes reserved for an order tail.
pub const ORDER_EXT_SPACE: usize = OrderExt::INIT_SPACE;

/// Reads the tail of a cross. A short account, an uninitialised tail and a cross whose rules were
/// never set all read as the default, which has every rule off. Only `set_rules` and the code
/// that creates the cross need the unset tail: they use [`read_raw`].
pub fn read(info: &AccountInfo) -> Result<CrossExt> {
    let ext = read_raw(info)?;
    Ok(if ext.rules_set {
        ext
    } else {
        CrossExt::default()
    })
}

/// Reads the tail of a cross exactly as stored (version 1, rules possibly unset).
pub fn read_raw(info: &AccountInfo) -> Result<CrossExt> {
    let data = info.try_borrow_data()?;
    let Some(tail) = data.get(CROSS_BODY..) else {
        return Ok(CrossExt::default());
    };
    if tail.first().copied() != Some(EXT_VERSION) {
        return Ok(CrossExt::default());
    }
    let mut slice = tail;
    CrossExt::deserialize(&mut slice).map_err(|_| error!(crate::CrossError::InvalidParams))
}

/// Writes the tail. Fails on an account created without room for it, so a legacy cross can never
/// be given a rule it was not created with.
pub fn write(info: &AccountInfo, ext: &CrossExt) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    require!(data.len() >= CROSS_SPACE, crate::CrossError::LegacyCross);
    let tail = &mut data[CROSS_BODY..CROSS_SPACE];
    tail.fill(0);
    let mut cursor: &mut [u8] = tail;
    ext.serialize(&mut cursor)
        .map_err(|_| error!(crate::CrossError::InvalidParams))
}

/// Reads an order's extension: the default (epoch 0, no bucket) when the account has none.
pub fn read_order(info: &AccountInfo) -> Result<OrderExt> {
    let data = info.try_borrow_data()?;
    let Some(tail) = data.get(ORDER_BODY..) else {
        return Ok(OrderExt::default());
    };
    if tail.first().copied() != Some(EXT_VERSION) {
        return Ok(OrderExt::default());
    }
    let mut slice = tail;
    OrderExt::deserialize(&mut slice).map_err(|_| error!(crate::CrossError::InvalidParams))
}

/// Writes an order's extension into the room reserved after the order struct.
pub fn write_order(info: &AccountInfo, ext: &OrderExt) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let end = ORDER_BODY + ORDER_EXT_SPACE;
    require!(data.len() >= end, crate::CrossError::LegacyCross);
    let tail = &mut data[ORDER_BODY..end];
    tail.fill(0);
    let mut cursor: &mut [u8] = tail;
    ext.serialize(&mut cursor)
        .map_err(|_| error!(crate::CrossError::InvalidParams))
}

/// The cross's extension as stored, emitted by `log_ext` so that indexers and clients that do not
/// decode the tail themselves can read it from a transaction.
#[event]
pub struct CrossExtSnapshot {
    pub cross: Pubkey,
    pub ext: CrossExt,
}

#[derive(Accounts)]
pub struct LogExt<'info> {
    pub cross: Box<Account<'info, Cross>>,
}

/// Emits the cross's extension tail. Permissionless; changes nothing.
pub fn log_ext(ctx: Context<LogExt>) -> Result<()> {
    emit!(CrossExtSnapshot {
        cross: ctx.accounts.cross.key(),
        ext: read(&ctx.accounts.cross.to_account_info())?
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules_with_ending(ending_secs: u32, buckets: u8) -> CrossExt {
        CrossExt {
            rules_set: true,
            ending: EndingRules {
                ending_secs,
                buckets,
                ..EndingRules::default()
            },
            ..CrossExt::default()
        }
    }

    #[test]
    fn the_tail_has_room_after_the_cross_and_fits_a_serialized_extension() {
        // A cross is allocated the struct and the tail; the tail is large enough for the largest extension.
        assert_eq!(CROSS_SPACE, CROSS_BODY + EXT_SPACE);
        let mut x = CrossExt {
            version: EXT_VERSION,
            rules_set: true,
            ..CrossExt::default()
        };
        x.guards.halt_source = Some(Pubkey::new_unique());
        x.neutrality.insider_count = u8::try_from(MAX_INSIDERS).unwrap();
        x.neutrality.insiders = [Pubkey::new_unique(); MAX_INSIDERS];
        let mut bytes = Vec::new();
        x.serialize(&mut bytes).unwrap();
        assert!(bytes.len() <= EXT_SPACE, "{} > {}", bytes.len(), EXT_SPACE);
        // The all-zero default reads back as "version 0": no rules.
        assert_eq!(CrossExt::default().version, 0);
    }

    #[test]
    fn placement_maps_the_clock_to_a_bucket_in_order_and_never_past_the_last() {
        let x = rules_with_ending(80, 4);
        let close = 1_000;
        assert_eq!(x.placement(close, 919), (0, NO_BUCKET));
        assert_eq!(x.placement(close, 920), (0, 0));
        assert_eq!(x.placement(close, 939), (0, 0));
        assert_eq!(x.placement(close, 940), (0, 1));
        assert_eq!(x.placement(close, 999), (0, 3));
        // A late order is not placed past the last bucket.
        assert_eq!(x.placement(close, 5_000), (0, 3));
        // A cross without an ending period has no buckets, and an extension window has none either.
        assert_eq!(CrossExt::default().placement(close, 999), (0, NO_BUCKET));
        let mut y = rules_with_ending(80, 4);
        y.draw.epoch = 1;
        assert_eq!(y.placement(close, 999), (1, NO_BUCKET));
    }

    #[test]
    fn buckets_are_monotone_in_time() {
        let x = rules_with_ending(997, 7);
        let mut last = 0u8;
        for t in 0..1_200i64 {
            let (_, b) = x.placement(1_100, 1_100 - 997 + t);
            if b != NO_BUCKET {
                assert!(b >= last && b < 7);
                last = b;
            }
        }
    }

    #[test]
    fn every_order_lands_in_a_shard_the_cross_can_have_and_aux_bits_are_distinct() {
        let x = CrossExt {
            rules_set: true,
            ending: EndingRules {
                ending_secs: 80,
                buckets: 8,
                extension_min_secs: 10,
                extension_max_secs: 20,
                ..EndingRules::default()
            },
            ..CrossExt::default()
        };
        let mut seen = std::collections::BTreeSet::new();
        for b in 0..MAX_BUCKETS {
            assert!(seen.insert(CrossExt::aux_bit(AUX_END_BASE + b)));
        }
        for j in 0..MAX_EXT_SHARDS {
            assert!(seen.insert(CrossExt::aux_bit(AUX_EXT_BASE + j)));
        }
        assert_eq!(
            seen.len(),
            usize::from(MAX_BUCKETS) + usize::from(MAX_EXT_SHARDS)
        );
        // Before an extension only the ending buckets must be merged; in an extension window its shards too.
        assert_eq!(x.required_aux(4), 0xFF);
        let mut y = x;
        y.draw.epoch = 1;
        assert_eq!(y.required_aux(4), 0xFF | (0xF << 8));
        // A drawn end leaves out the buckets after it.
        y.draw.epoch = 0;
        y.draw.end_bucket = 2;
        assert_eq!(y.required_aux(4), 0b111);
    }

    #[test]
    fn cancel_deadline_is_before_the_ending_period_and_never_after_the_close() {
        let mut x = rules_with_ending(80, 4);
        x.ending.cancel_cutoff_secs = 10;
        assert_eq!(x.cancel_deadline(1_000), 910);
        assert_eq!(CrossExt::default().cancel_deadline(1_000), 1_000);
    }
}
