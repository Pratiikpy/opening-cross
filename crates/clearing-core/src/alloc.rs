//! Allocation classes at the margin (ADR-0104).
//!
//! The clearing price and the matched volume are decided by [`crate::clear`] exactly as in
//! ADR-0003. This module only decides *which* of the marginal buy orders receive the volume `R`
//! that is left over when demand at the clearing price exceeds supply. With no policy the answer
//! is pro-rata: `floor(q · R / Q)`. With a policy, a cross reserves shares of `R` for classes of
//! orders and spills what a class cannot use back to everyone:
//!
//! 1. class 1 (identity-verified small orders) receives `reserve_bps[0]` of `R`, by lottery in
//!    whole lots when `lottery_unit > 0` (one ticket per order, every order exactly one lot) and
//!    pro-rata otherwise;
//! 2. classes 2 (locked) and 3 (priority) each receive `min(Q_c, R · reserve_bps / 10_000)`,
//!    pro-rata within the class;
//! 3. what remains, `R'`, is shared pro-rata by everyone's remaining quantity `Q'`, class 0
//!    included, so a reserve a class cannot fill goes to the others and the volume is never
//!    stranded.
//!
//! Every fill is a pure function of the order, its class and ticket, the clearing summary and the
//! per-cross marginal figures, so `claim` stays O(1). Fills round down, so the sum of fills never
//! exceeds `R`; the proof is in ADR-0104.
use crate::{mul_div_floor, Clearing, Side};

/// Basis points in a whole.
const BPS: u128 = 10_000;

/// A cross's allocation policy. All zero is plain pro-rata.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AllocPolicy {
    /// Shares of the marginal volume reserved for classes 1, 2 and 3, in basis points. The sum
    /// may not exceed 10,000.
    pub reserve_bps: [u16; 3],
    /// Base atoms per lottery lot for class 1; 0 = no lottery (pro-rata within the class).
    pub lottery_unit: u64,
}

impl AllocPolicy {
    pub fn is_valid(&self) -> bool {
        self.reserve_bps.iter().map(|b| u32::from(*b)).sum::<u32>() <= 10_000
    }
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// What the program records about the marginal tick at the clear.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Marginal {
    /// Quantity of classes 1, 2 and 3 among the marginal buy orders (`Q_1..Q_3`).
    pub qty: [u128; 3],
    /// Class-1 orders at the marginal tick (lottery tickets), numbered `0..tickets`.
    pub tickets: u32,
    /// Where the lottery window starts, in `0..tickets`.
    pub rho: u32,
}

/// The pools derived from the summary and the policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pools {
    /// Volume reserved for classes 1, 2 and 3.
    pub reserved: [u128; 3],
    /// Winning lottery tickets (0 without a lottery).
    pub winners: u32,
    /// Volume left for everyone after the reserves (`R'`) and the quantity it is shared over (`Q'`).
    pub residual: u128,
    pub residual_base: u128,
}

/// Pools for a cross whose buys are rationed, or `None` when the marginal buys are not rationed.
pub fn pools(c: &Clearing, p: &AllocPolicy, m: &Marginal) -> Option<Pools> {
    if c.rationed != Some(Side::Buy) || c.marginal_quantity == 0 {
        return None;
    }
    let r = c.marginal_remaining;
    let share = |i: usize| mul_div_floor(r, u128::from(p.reserve_bps[i]), BPS);
    let (reserved1, winners) = if p.lottery_unit > 0 {
        let lots = share(0)
            .checked_div(u128::from(p.lottery_unit))
            .unwrap_or(0);
        let w = lots.min(u128::from(m.tickets));
        (
            w.saturating_mul(u128::from(p.lottery_unit)),
            u32::try_from(w).unwrap_or(u32::MAX),
        )
    } else {
        (m.qty[0].min(share(0)), 0)
    };
    let reserved2 = m.qty[1].min(share(1));
    let reserved3 = m.qty[2].min(share(2));
    let used = reserved1
        .saturating_add(reserved2)
        .saturating_add(reserved3);
    Some(Pools {
        reserved: [reserved1, reserved2, reserved3],
        winners,
        residual: r.saturating_sub(used),
        residual_base: c.marginal_quantity.saturating_sub(used),
    })
}

/// `true` when lottery ticket `ticket` is inside the winning window.
pub fn wins(ticket: u32, m: &Marginal, winners: u32) -> bool {
    if m.tickets == 0 {
        return false;
    }
    // (ticket − rho) mod tickets, without overflow.
    let n = u64::from(m.tickets);
    let offset = u64::from(ticket)
        .checked_rem(n)
        .zip(u64::from(m.rho).checked_rem(n))
        .and_then(|(t, r)| t.checked_add(n)?.checked_sub(r)?.checked_rem(n));
    offset.is_some_and(|o| o < u64::from(winners))
}

/// Fill (base atoms) for one order under a policy. For anything but a rationed marginal buy it is
/// exactly [`crate::fill`].
#[allow(clippy::too_many_arguments)]
pub fn fill_with_policy(
    side: Side,
    limit_price: u64,
    quantity: u64,
    class: u8,
    ticket: u32,
    c: &Clearing,
    p: &AllocPolicy,
    m: &Marginal,
) -> u64 {
    let marginal_buy = side == Side::Buy && limit_price == c.price && c.rationed == Some(Side::Buy);
    if !marginal_buy || p.is_default() {
        return crate::fill(side, limit_price, quantity, c);
    }
    let Some(pl) = pools(c, p, m) else {
        return crate::fill(side, limit_price, quantity, c);
    };
    let q = u128::from(quantity);
    let reserved = match class {
        1 if p.lottery_unit > 0 => {
            if wins(ticket, m, pl.winners) {
                u128::from(p.lottery_unit).min(q)
            } else {
                0
            }
        }
        1..=3 => {
            let i = usize::from(class.saturating_sub(1));
            mul_div_floor(q, pl.reserved[i], m.qty[i])
        }
        _ => 0,
    };
    let remaining = q.saturating_sub(reserved);
    let residual = if pl.residual_base == 0 {
        0
    } else {
        mul_div_floor(remaining, pl.residual, pl.residual_base)
    };
    u64::try_from(reserved.saturating_add(residual).min(q)).unwrap_or(quantity)
}

/// Upper bound on what orders that hold class 0 (declared insiders) are allocated, given their
/// quantity strictly better than the clearing price and at it. Used to leave their volume out of
/// the minimum raise (ADR-0106). It is an upper bound because the per-order fills round down.
pub fn class0_fill_upper_bound(
    better_qty: u128,
    marginal_qty: u128,
    c: &Clearing,
    p: &AllocPolicy,
    m: &Marginal,
) -> u128 {
    let share = match pools(c, p, m) {
        Some(pl) if !p.is_default() => (pl.residual, pl.residual_base),
        _ if c.rationed == Some(Side::Buy) => (c.marginal_remaining, c.marginal_quantity),
        _ => return better_qty.saturating_add(marginal_qty),
    };
    let (num, den) = share;
    let part = if den == 0 {
        0
    } else {
        // ceil(marginal · num / den)
        let floor = mul_div_floor(marginal_qty, num, den);
        let exact = floor.saturating_mul(den) == marginal_qty.saturating_mul(num);
        if exact {
            floor
        } else {
            floor.saturating_add(1)
        }
    };
    better_qty.saturating_add(part.min(marginal_qty))
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    fn clearing(price: u64, q: u128, r: u128) -> Clearing {
        Clearing {
            price,
            matched: r,
            demand: q,
            supply: r,
            rationed: Some(Side::Buy),
            marginal_quantity: q,
            marginal_remaining: r,
            marginal_orders: 4,
        }
    }

    #[test]
    fn no_policy_is_the_pro_rata_of_adr_0003() {
        let c = clearing(10, 100, 60);
        let p = AllocPolicy::default();
        let m = Marginal::default();
        for q in [1u64, 7, 33, 100] {
            assert_eq!(
                fill_with_policy(Side::Buy, 10, q, 0, 0, &c, &p, &m),
                crate::fill(Side::Buy, 10, q, &c)
            );
        }
    }

    #[test]
    fn a_reserve_the_class_cannot_fill_spills_to_everyone() {
        // 100 marginal, 60 available. Class 2 holds 10 of it and reserves 50% (30): it fills in
        // full (10) and the other 20 of its reserve goes back to the pool.
        let c = clearing(10, 100, 60);
        let p = AllocPolicy {
            reserve_bps: [0, 5_000, 0],
            lottery_unit: 0,
        };
        let m = Marginal {
            qty: [0, 10, 0],
            tickets: 0,
            rho: 0,
        };
        let pl = pools(&c, &p, &m).unwrap();
        assert_eq!(pl.reserved, [0, 10, 0]);
        assert_eq!((pl.residual, pl.residual_base), (50, 90));
        // Class 2 order of 10: reserved 10, nothing left to take from the pool.
        assert_eq!(fill_with_policy(Side::Buy, 10, 10, 2, 0, &c, &p, &m), 10);
        // A class-0 order of 90: floor(90 · 50 / 90) = 50.
        assert_eq!(fill_with_policy(Side::Buy, 10, 90, 0, 0, &c, &p, &m), 50);
    }

    #[test]
    fn the_lottery_pays_exactly_the_lots_and_each_ticket_has_equal_odds() {
        // 10 tickets of one lot (5 atoms) each; class 1 reserves 20% of R = 100 → 4 lots.
        let c = clearing(10, 200, 100);
        let p = AllocPolicy {
            reserve_bps: [2_000, 0, 0],
            lottery_unit: 5,
        };
        let m = Marginal {
            qty: [50, 0, 0],
            tickets: 10,
            rho: 8,
        };
        let pl = pools(&c, &p, &m).unwrap();
        assert_eq!((pl.winners, pl.reserved[0]), (4, 20));
        let mut winners = [false; 10];
        for (t, w) in winners.iter_mut().enumerate() {
            *w = wins(u32::try_from(t).unwrap(), &m, pl.winners);
        }
        assert_eq!(
            winners,
            [true, true, false, false, false, false, false, false, true, true]
        );
        // Every ticket wins in 4 of the 10 possible windows.
        let mut hits = [0u32; 10];
        for rho in 0..10 {
            let mm = Marginal { rho, ..m };
            for t in 0..10 {
                if wins(t, &mm, 4) {
                    hits[t as usize] += 1;
                }
            }
        }
        assert_eq!(hits, [4; 10]);
    }

    #[test]
    fn fills_never_exceed_the_marginal_volume() {
        let c = clearing(10, 1_000, 400);
        let p = AllocPolicy {
            reserve_bps: [1_000, 2_000, 1_500],
            lottery_unit: 0,
        };
        // 3 orders per class, awkward sizes, so that every floor drops something.
        let orders: [(u8, u64); 12] = [
            (0, 101),
            (0, 57),
            (0, 13),
            (1, 41),
            (1, 7),
            (1, 29),
            (2, 83),
            (2, 17),
            (2, 3),
            (3, 61),
            (3, 19),
            (3, 23),
        ];
        let sum: u64 = orders.iter().map(|o| o.1).sum();
        let mut qty = [0u128; 3];
        for (cl, q) in orders {
            if cl > 0 {
                qty[usize::from(cl - 1)] += u128::from(q);
            }
        }
        let c = Clearing {
            marginal_quantity: u128::from(sum),
            demand: u128::from(sum),
            ..c
        };
        let m = Marginal {
            qty,
            tickets: 0,
            rho: 0,
        };
        let total: u128 = orders
            .iter()
            .map(|(cl, q)| u128::from(fill_with_policy(Side::Buy, 10, *q, *cl, 0, &c, &p, &m)))
            .sum();
        assert!(total <= c.marginal_remaining, "{total}");
        assert!(c.marginal_remaining - total <= 2 * 12);
    }
}
