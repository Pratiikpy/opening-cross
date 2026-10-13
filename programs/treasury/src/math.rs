//! Pure arithmetic for the treasury extension. No account access, so every rule here has unit and
//! property tests that run on the host. Everything is checked; every rounding direction is stated.

/// Fixed-point scale of the distribution accumulator (quote atoms per staked coin atom).
pub const PREC: u128 = 1_000_000_000;
pub const BPS: u128 = 10_000;

/// `floor(a * b / d)` with a full-width intermediate. `None` when `d == 0` or the quotient does not
/// fit in `u128`. Double-and-add over the bits of `b`, so no 256-bit type is needed; `d` must be at
/// most `2^127` so that doubling a remainder cannot overflow.
pub fn mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    if d == 0 || d > (1u128 << 127) {
        return None;
    }
    let (qa, ra) = (a / d, a % d);
    let mut q: u128 = 0;
    let mut r: u128 = 0;
    let mut started = false;
    for i in (0..128).rev() {
        if started {
            // x = 2x
            let r2 = r.checked_mul(2)?;
            q = q.checked_mul(2)?;
            if r2 >= d {
                r = r2 - d;
                q = q.checked_add(1)?;
            } else {
                r = r2;
            }
        }
        if (b >> i) & 1 == 1 {
            started = true;
            // x += a
            q = q.checked_add(qa)?;
            let r2 = r.checked_add(ra)?;
            if r2 >= d {
                r = r2 - d;
                q = q.checked_add(1)?;
            } else {
                r = r2;
            }
        }
    }
    Some(q)
}

/// `ceil(a * b / d)`.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Option<u128> {
    let q = mul_div(a, b, d)?;
    if mulmod_is_zero(a, b, d)? {
        Some(q)
    } else {
        q.checked_add(1)
    }
}

/// Whether `a * b` is a multiple of `d`.
fn mulmod_is_zero(a: u128, b: u128, d: u128) -> Option<bool> {
    if d == 0 || d > (1u128 << 127) {
        return None;
    }
    let mut r: u128 = 0;
    let ra = a % d;
    let mut started = false;
    for i in (0..128).rev() {
        if started {
            let r2 = r.checked_mul(2)?;
            r = if r2 >= d { r2 - d } else { r2 };
        }
        if (b >> i) & 1 == 1 {
            started = true;
            let r2 = r.checked_add(ra)?;
            r = if r2 >= d { r2 - d } else { r2 };
        }
    }
    Some(r == 0)
}

/// Quote paid for burning `amount` coins at the current NAV: `floor(vault * amount / supply)`.
/// Rounds down, so `(vault - p) / (supply - amount) >= vault / supply`: redeeming never lowers the
/// value of the coins that remain.
pub fn nav_payout(vault: u64, amount: u64, supply: u64) -> Option<u64> {
    if supply == 0 || amount > supply {
        return None;
    }
    u64::try_from(mul_div(
        u128::from(vault),
        u128::from(amount),
        u128::from(supply),
    )?)
    .ok()
}

/// The accumulator increment for distributing `amount` over `total_staked`: rounds down.
pub fn acc_delta(amount: u64, total_staked: u64) -> Option<u128> {
    if total_staked == 0 {
        return None;
    }
    mul_div(u128::from(amount), PREC, u128::from(total_staked))
}

/// A position's scaled reward entitlement: `floor(staked * acc / PREC)`.
pub fn scaled(staked: u64, acc: u128) -> Option<u128> {
    mul_div(u128::from(staked), acc, PREC)
}

/// Pending reward since the position's debt was last set.
pub fn pending_since(staked: u64, acc: u128, debt: u128) -> Option<u64> {
    u64::try_from(scaled(staked, acc)?.checked_sub(debt)?).ok()
}

/// How much of a stream of `amount` quote atoms that last advanced at `last` and ends at `end` is released by `now`:
/// all of it at or after `end`, otherwise `floor(amount * (now - last) / (end - last))`.
pub fn stream_release(amount: u64, last: i64, end: i64, now: i64) -> Option<u64> {
    if now >= end {
        return Some(amount);
    }
    let elapsed = now.checked_sub(last)?;
    let window = end.checked_sub(last)?;
    if elapsed <= 0 {
        return Some(0);
    }
    u64::try_from(mul_div(
        u128::from(amount),
        u128::try_from(elapsed).ok()?,
        u128::try_from(window).ok()?,
    )?)
    .ok()
}

/// Whether a tally passes: quorum of the circulating supply took part and yes strictly exceeds
/// `threshold_bps` of the yes+no votes.
pub fn proposal_passes(
    yes: u64,
    no: u64,
    supply: u64,
    quorum_bps: u16,
    threshold_bps: u16,
) -> bool {
    let total = u128::from(yes) + u128::from(no);
    if total == 0 || supply == 0 {
        return false;
    }
    let quorum = total * BPS >= u128::from(quorum_bps) * u128::from(supply);
    let majority = u128::from(yes) * BPS > u128::from(threshold_bps) * total;
    quorum && majority
}

/// The largest single spend a proposal may authorise: `floor(vault * max_bps / 10000)`.
pub fn proposal_cap(vault: u64, max_bps: u16) -> Option<u64> {
    u64::try_from(mul_div(u128::from(vault), u128::from(max_bps), BPS)?).ok()
}

/// Share of a round's attested revenue owed to holders, rounded up in the holders' favour.
pub fn round_due(revenue: u64, share_bps: u16) -> Option<u64> {
    u64::try_from(mul_div_ceil(
        u128::from(revenue),
        u128::from(share_bps),
        BPS,
    )?)
    .ok()
}

/// Start of round `r`: `start + r * len`.
pub fn round_start(start: i64, len: i64, r: u64) -> Option<i64> {
    let off = i64::try_from(r).ok()?.checked_mul(len)?;
    start.checked_add(off)
}

/// `floor(total * bps / 10000)` for milestone payouts.
pub fn bps_of(total: u64, bps: u16) -> Option<u64> {
    u64::try_from(mul_div(u128::from(total), u128::from(bps), BPS)?).ok()
}

/// Rolls the NAV rate-limit window forward whole periods. Returns the new window start.
pub fn roll_window(period_start: i64, period_secs: i64, now: i64) -> Option<i64> {
    let elapsed = now.checked_sub(period_start)?;
    if elapsed < period_secs {
        return Some(period_start);
    }
    let periods = elapsed.checked_div(period_secs)?;
    period_start.checked_add(periods.checked_mul(period_secs)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn mul_div_matches_u128_where_it_fits() {
        assert_eq!(mul_div(10, 10, 3), Some(33));
        assert_eq!(mul_div(0, 5, 3), Some(0));
        assert_eq!(mul_div(5, 0, 3), Some(0));
        assert_eq!(mul_div(5, 5, 0), None);
        assert_eq!(mul_div(u128::MAX, 1, 1), Some(u128::MAX));
        assert_eq!(mul_div(u128::MAX, u128::MAX, 1), None);
        // A product wider than 128 bits that still divides back down.
        assert_eq!(mul_div(u128::MAX, 1 << 64, 1 << 64), Some(u128::MAX));
    }

    #[test]
    fn mul_div_ceil_rounds_up_only_when_inexact() {
        assert_eq!(mul_div_ceil(10, 10, 5), Some(20));
        assert_eq!(mul_div_ceil(10, 10, 3), Some(34));
        assert_eq!(mul_div_ceil(1, 1, 10_000), Some(1));
        assert_eq!(mul_div_ceil(0, 1, 10_000), Some(0));
    }

    #[test]
    fn passes_needs_quorum_and_strict_majority() {
        assert!(proposal_passes(51, 49, 200, 5_000, 5_000));
        assert!(!proposal_passes(50, 50, 200, 5_000, 5_000)); // tie is not a majority
        assert!(!proposal_passes(40, 0, 200, 5_000, 5_000)); // 20% turnout is below quorum
        assert!(!proposal_passes(0, 0, 200, 0, 5_000));
        assert!(!proposal_passes(1, 0, 0, 0, 5_000));
    }

    #[test]
    fn round_due_rounds_up() {
        assert_eq!(round_due(1_000_000, 1_000), Some(100_000));
        assert_eq!(round_due(1, 1_000), Some(1));
        assert_eq!(round_due(0, 1_000), Some(0));
    }

    #[test]
    fn stream_releases_pro_rata_in_time() {
        assert_eq!(stream_release(1_000, 0, 100, 0), Some(0));
        assert_eq!(stream_release(1_000, 0, 100, 25), Some(250));
        assert_eq!(stream_release(1_000, 25, 100, 50), Some(333)); // a third of what is left, rounded down
        assert_eq!(stream_release(1_000, 0, 100, 100), Some(1_000));
        assert_eq!(stream_release(1_000, 0, 100, 5_000), Some(1_000));
    }

    #[test]
    fn window_rolls_whole_periods() {
        assert_eq!(roll_window(100, 10, 105), Some(100));
        assert_eq!(roll_window(100, 10, 110), Some(110));
        assert_eq!(roll_window(100, 10, 139), Some(130));
    }

    proptest! {
        #[test]
        fn mul_div_agrees_with_wide_reference(a in any::<u64>(), b in any::<u64>(), d in 1u64..) {
            let exact = (u128::from(a) * u128::from(b)) / u128::from(d);
            prop_assert_eq!(mul_div(u128::from(a), u128::from(b), u128::from(d)), Some(exact));
        }

        #[test]
        fn mul_div_ceil_is_floor_or_floor_plus_one(a in any::<u64>(), b in any::<u64>(), d in 1u64..) {
            let prod = u128::from(a) * u128::from(b);
            let floor = prod / u128::from(d);
            let want = if prod % u128::from(d) == 0 { floor } else { floor + 1 };
            prop_assert_eq!(mul_div_ceil(u128::from(a), u128::from(b), u128::from(d)), Some(want));
        }

        /// Redeeming at NAV never lowers the value of the coins that remain, and never pays more
        /// than the vault holds.
        #[test]
        fn nav_redemption_never_dilutes(vault in 0u64..u64::MAX / 2, supply in 1u64.., frac in 0u64..=1_000_000) {
            let amount = ((u128::from(supply) * u128::from(frac)) / 1_000_000) as u64;
            if amount == 0 { return Ok(()); }
            let p = nav_payout(vault, amount, supply).unwrap();
            prop_assert!(p <= vault);
            if amount < supply {
                // (vault - p) / (supply - amount) >= vault / supply  <=>  (vault - p) * supply >= vault * (supply - amount)
                let lhs = u128::from(vault - p) * u128::from(supply);
                let rhs = u128::from(vault) * u128::from(supply - amount);
                prop_assert!(lhs >= rhs);
            }
        }

        /// Total pending claims never exceed what was deposited, whatever the staking order.
        #[test]
        fn distributions_never_overpay(
            stakes in proptest::collection::vec(1u64..1_000_000_000_000, 1..6),
            deposits in proptest::collection::vec(1u64..1_000_000_000_000, 1..6),
        ) {
            let total: u64 = stakes.iter().sum();
            let mut acc: u128 = 0;
            let mut deposited: u128 = 0;
            for d in &deposits {
                acc += acc_delta(*d, total).unwrap();
                deposited += u128::from(*d);
            }
            let claims: u128 = stakes.iter().map(|s| u128::from(pending_since(*s, acc, 0).unwrap())).sum();
            prop_assert!(claims <= deposited);
        }

        /// However often the stream is advanced, it releases at most the amount, never decreases, and has
        /// released everything by its end.
        #[test]
        fn stream_releases_are_bounded_and_complete(
            amount in 0u64..u64::MAX / 2,
            window in 1i64..10_000_000,
            cuts in proptest::collection::vec(0i64..10_000_000, 0..8),
        ) {
            let (mut last, end) = (1_000i64, 1_000i64 + window);
            let mut left = amount;
            let mut times: Vec<i64> = cuts.iter().map(|c| 1_000 + (c % window)).collect();
            times.sort_unstable();
            times.push(end);
            let mut released = 0u128;
            for t in times {
                let r = stream_release(left, last, end, t).unwrap();
                prop_assert!(r <= left);
                left -= r;
                released += u128::from(r);
                last = last.max(t.min(end));
            }
            prop_assert_eq!(left, 0);
            prop_assert_eq!(released, u128::from(amount));
        }

        #[test]
        fn pending_is_monotone_in_acc(s in 1u64..1u64 << 40, a1 in 0u128..1u128 << 90, extra in 0u128..1u128 << 40) {
            let d = scaled(s, a1).unwrap();
            let p2 = pending_since(s, a1 + extra, d).unwrap();
            let p0 = pending_since(s, a1, d).unwrap();
            prop_assert_eq!(p0, 0);
            prop_assert!(u128::from(p2) <= (u128::from(s) * extra) / PREC + 1);
        }
    }
}
