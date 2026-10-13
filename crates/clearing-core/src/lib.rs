//! Uniform-price call-auction clearing for Opening Cross.
//!
//! The rule is specified in `docs/adr/0003-clearing-rule.md`. In short: among prices where
//! every strictly better order fits, pick maximum matched volume, then minimum imbalance,
//! then closest to the reference price (if any), then the lowest price. Orders exactly at the
//! clearing price on the side with excess quantity are rationed pro-rata (buys round down,
//! sells round up). Every order's fill is a pure function of the order and the [`Clearing`]
//! summary, so it can be computed at claim time without seeing other orders.
//!
//! The crate is `no_std`, allocation-free and uses only integer arithmetic so the same code
//! runs on chain, in WASM and in the off-chain verifier.
#![no_std]
#![forbid(unsafe_code)]
#![deny(clippy::arithmetic_side_effects)]

pub mod alloc;
pub mod guards;
pub use alloc::{
    class0_fill_upper_bound, fill_with_policy, pools, wins, AllocPolicy, Marginal, Pools,
};
pub use guards::{check_all, PrintFailure, RaiseGuards};

/// The cross's price grid. Prices passed to [`clear`] and the reference price lie on it.
pub trait TickGrid {
    /// The next grid price strictly above `price`, if any.
    fn next(&self, price: u64) -> Option<u64>;
    /// The previous grid price strictly below `price`, if any.
    fn prev(&self, price: u64) -> Option<u64>;
}

/// Evenly spaced grid: every multiple of `step`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinearGrid {
    pub step: u64,
}

impl TickGrid for LinearGrid {
    fn next(&self, price: u64) -> Option<u64> {
        if self.step == 0 {
            return None;
        }
        price
            .checked_div(self.step)?
            .checked_add(1)?
            .checked_mul(self.step)
    }
    fn prev(&self, price: u64) -> Option<u64> {
        if self.step == 0 || price == 0 {
            return None;
        }
        price
            .checked_sub(1)?
            .checked_div(self.step)?
            .checked_mul(self.step)
    }
}

/// A cross's price grid: `ticks` prices starting at `min`, `tick` apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OffsetGrid {
    pub min: u64,
    pub tick: u64,
    pub ticks: u16,
}

impl TickGrid for OffsetGrid {
    fn next(&self, price: u64) -> Option<u64> {
        if price < self.min {
            return Some(self.min);
        }
        let i = (price.checked_sub(self.min)?)
            .checked_div(self.tick)?
            .checked_add(1)?;
        (i < u64::from(self.ticks))
            .then(|| self.min.checked_add(i.checked_mul(self.tick)?))
            .flatten()
    }

    fn prev(&self, price: u64) -> Option<u64> {
        if price <= self.min {
            return None;
        }
        let offset = price.checked_sub(self.min)?;
        let i = offset.checked_sub(1)?.checked_div(self.tick)?;
        let i = i.min(u64::from(self.ticks).checked_sub(1)?);
        self.min.checked_add(i.checked_mul(self.tick)?)
    }
}

/// Order side.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Buy,
    Sell,
}

/// Aggregate quantity resting at exactly one limit price.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Level {
    pub price: u64,
    /// Total buy quantity (base atoms) with this limit price.
    pub buy: u128,
    /// Total sell quantity (base atoms) with this limit price.
    pub sell: u128,
    /// Number of buy orders with this limit price.
    pub buy_orders: u32,
    /// Number of sell orders with this limit price.
    pub sell_orders: u32,
}

/// Result of a cross that prints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clearing {
    /// The single clearing price `P*`.
    pub price: u64,
    /// Matched volume `V = min(D(P*), S(P*))` in base atoms (before rounding dust).
    pub matched: u128,
    /// Buy quantity with limit ≥ `P*`.
    pub demand: u128,
    /// Sell quantity with limit ≤ `P*`.
    pub supply: u128,
    /// Side whose marginal orders are rationed, if any.
    pub rationed: Option<Side>,
    /// Quantity of the rationed side resting exactly at `P*` (`Q`).
    pub marginal_quantity: u128,
    /// Volume left for the rationed side's marginal orders after strictly better orders (`R`).
    pub marginal_remaining: u128,
    /// Number of rationed marginal orders; bounds the rounding dust in atoms.
    pub marginal_orders: u32,
}

impl Clearing {
    /// `|D − S|` at the clearing price.
    pub fn imbalance(&self) -> u128 {
        self.demand.abs_diff(self.supply)
    }

    /// Upper bound on `|Σ buy fills − Σ sell fills|` caused by pro-rata rounding.
    pub fn max_dust(&self) -> u128 {
        u128::from(self.marginal_orders)
    }
}

/// Errors in the input to [`clear`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClearError {
    /// Levels must be sorted by strictly ascending price.
    UnsortedLevels,
    /// A level reported quantity without orders, or orders without quantity.
    InconsistentLevel,
}

/// Matched-volume statistics at one candidate price.
#[derive(Clone, Copy, Debug)]
struct Point {
    price: u64,
    demand: u128,        // D(p)
    demand_better: u128, // D⁺(p)
    supply: u128,        // S(p)
    supply_better: u128, // S⁻(p)
}

impl Point {
    /// Applies the supply cap to both supply figures.
    fn capped(mut self, cap: Option<u128>) -> Self {
        if let Some(c) = cap {
            self.supply = self.supply.min(c);
            self.supply_better = self.supply_better.min(c);
        }
        self
    }
    fn matched(&self) -> u128 {
        self.demand.min(self.supply)
    }
    fn feasible(&self) -> bool {
        let v = self.matched();
        v > 0 && v >= self.demand_better && v >= self.supply_better
    }
}

/// Evaluates `D`, `D⁺`, `S`, `S⁻` at an arbitrary price with one pass over the levels. A supply
/// cap limits both supply figures: the issuer never sells more than the cap (ADR-0101).
fn point_at(levels: &[Level], price: u64, cap: Option<u128>) -> Point {
    let mut p = Point {
        price,
        demand: 0,
        demand_better: 0,
        supply: 0,
        supply_better: 0,
    };
    for l in levels {
        if l.price >= price {
            p.demand = p.demand.saturating_add(l.buy);
        }
        if l.price > price {
            p.demand_better = p.demand_better.saturating_add(l.buy);
        }
        if l.price <= price {
            p.supply = p.supply.saturating_add(l.sell);
        }
        if l.price < price {
            p.supply_better = p.supply_better.saturating_add(l.sell);
        }
    }
    p.capped(cap)
}

/// `true` if `a` is preferred to `b` under ADR-0003 (both assumed feasible).
fn better(a: &Point, b: &Point, reference: Option<u64>) -> bool {
    let (va, vb) = (a.matched(), b.matched());
    if va != vb {
        return va > vb;
    }
    let (ia, ib) = (a.demand.abs_diff(a.supply), b.demand.abs_diff(b.supply));
    if ia != ib {
        return ia < ib;
    }
    if let Some(r) = reference {
        let (da, db) = (a.price.abs_diff(r), b.price.abs_diff(r));
        if da != db {
            return da < db;
        }
    }
    a.price < b.price
}

/// Clears a cross from per-price aggregates.
///
/// `levels` must be sorted by strictly ascending price. `reference` is the reopen reference
/// price (pre-halt or oracle); pass `None` for launches. `grid` is the cross's price grid;
/// level prices and the reference price must lie on it. Returns `Ok(None)` when no price
/// matches any volume, in which case the cross does not print.
pub fn clear(
    levels: &[Level],
    reference: Option<u64>,
    grid: &impl TickGrid,
) -> Result<Option<Clearing>, ClearError> {
    clear_with(levels, reference, grid, None)
}

/// [`clear`] with an optional supply cap: the most base the sell side will deliver, however many
/// sell levels the schedule offers (ADR-0101, hard cap). With a cap the rule is unchanged except
/// that `S(p)` and `S⁻(p)` are `min(·, cap)`, so the price rises until demand fits the cap. `None`
/// is exactly [`clear`].
pub fn clear_with(
    levels: &[Level],
    reference: Option<u64>,
    grid: &impl TickGrid,
    supply_cap: Option<u128>,
) -> Result<Option<Clearing>, ClearError> {
    let cap = supply_cap;
    let mut prev: Option<u64> = None;
    for l in levels {
        if prev.is_some_and(|p| l.price <= p) {
            return Err(ClearError::UnsortedLevels);
        }
        if (l.buy == 0) != (l.buy_orders == 0) || (l.sell == 0) != (l.sell_orders == 0) {
            return Err(ClearError::InconsistentLevel);
        }
        prev = Some(l.price);
    }

    let total_buy = levels.iter().fold(0u128, |a, l| a.saturating_add(l.buy));

    // Single ascending pass computing each level's point in O(L).
    let mut best: Option<Point> = None;
    let mut supply_below: u128 = 0; // S⁻ at the current level
    let mut demand_below: u128 = 0; // buys strictly below the current level
    for (i, l) in levels.iter().enumerate() {
        let demand = total_buy.saturating_sub(demand_below);
        let p = Point {
            price: l.price,
            demand,
            demand_better: demand.saturating_sub(l.buy),
            supply: supply_below.saturating_add(l.sell),
            supply_better: supply_below,
        }
        .capped(cap);
        if p.feasible() && best.as_ref().is_none_or(|b| better(&p, b, reference)) {
            best = Some(p);
        }
        supply_below = supply_below.saturating_add(l.sell);
        demand_below = demand_below.saturating_add(l.buy);

        // Between this level and the next, D and S are constant, so within that gap only the
        // grid price nearest the reference (or the lowest one, without a reference) can win.
        let next_level = levels.get(i.saturating_add(1)).map(|n| n.price);
        let interior = match (reference, next_level) {
            (Some(r), Some(n)) if r >= n => grid.prev(n),
            (Some(r), _) if r > l.price && next_level.is_none_or(|n| r < n) => None, // evaluated below
            _ => grid.next(l.price),
        };
        if let Some(t) = interior {
            let below_next = next_level.is_none_or(|n| t < n);
            if t > l.price && below_next {
                let d = total_buy.saturating_sub(demand_below);
                let q = Point {
                    price: t,
                    demand: d,
                    demand_better: d,
                    supply: supply_below,
                    supply_better: supply_below,
                }
                .capped(cap);
                if q.feasible() && best.as_ref().is_none_or(|b| better(&q, b, reference)) {
                    best = Some(q);
                }
            }
        }
    }
    if let Some(r) = reference {
        if levels.binary_search_by_key(&r, |l| l.price).is_err() {
            let p = point_at(levels, r, cap);
            if p.feasible() && best.as_ref().is_none_or(|b| better(&p, b, reference)) {
                best = Some(p);
            }
        }
    }

    let Some(p) = best else { return Ok(None) };
    let matched = p.matched();
    let at = levels
        .binary_search_by_key(&p.price, |l| l.price)
        .ok()
        .and_then(|i| levels.get(i))
        .copied()
        .unwrap_or_default();

    let (rationed, marginal_quantity, marginal_remaining, marginal_orders) = if p.demand > p.supply
    {
        (
            Some(Side::Buy),
            at.buy,
            matched.saturating_sub(p.demand_better),
            at.buy_orders,
        )
    } else if p.supply > p.demand {
        (
            Some(Side::Sell),
            at.sell,
            matched.saturating_sub(p.supply_better),
            at.sell_orders,
        )
    } else {
        (None, 0, 0, 0)
    };

    Ok(Some(Clearing {
        price: p.price,
        matched,
        demand: p.demand,
        supply: p.supply,
        rationed,
        marginal_quantity,
        marginal_remaining,
        marginal_orders,
    }))
}

/// Fill (base atoms) for one order under `clearing`. Never exceeds `quantity`.
pub fn fill(side: Side, limit_price: u64, quantity: u64, clearing: &Clearing) -> u64 {
    let p = clearing.price;
    let crosses = match side {
        Side::Buy => limit_price >= p,
        Side::Sell => limit_price <= p,
    };
    if !crosses {
        return 0;
    }
    let marginal = limit_price == p && clearing.rationed == Some(side);
    if !marginal || clearing.marginal_quantity == 0 {
        return quantity;
    }
    let q = u128::from(quantity);
    let (r, d) = (clearing.marginal_remaining, clearing.marginal_quantity);
    let filled = match side {
        Side::Buy => mul_div_floor(q, r, d),
        Side::Sell => mul_div_ceil(q, r, d),
    };
    // R ≤ Q, so the result never exceeds `quantity`; `min` keeps that true even for
    // inconsistent summaries, which the caller is responsible for never producing.
    u64::try_from(filled.min(q)).unwrap_or(quantity)
}

/// Quote atoms a buyer pays for `filled` base atoms: `ceil(filled · price / price_scale)`.
pub fn buyer_pays(filled: u64, price: u64, price_scale: u64) -> Option<u64> {
    if price_scale == 0 {
        return None;
    }
    u64::try_from(mul_div_ceil(
        u128::from(filled),
        u128::from(price),
        u128::from(price_scale),
    ))
    .ok()
}

/// Quote atoms a seller receives for `filled` base atoms: `floor(filled · price / price_scale)`.
pub fn seller_receives(filled: u64, price: u64, price_scale: u64) -> Option<u64> {
    if price_scale == 0 {
        return None;
    }
    u64::try_from(mul_div_floor(
        u128::from(filled),
        u128::from(price),
        u128::from(price_scale),
    ))
    .ok()
}

/// Conditions under which a cross that cleared must still not print.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PrintGuards {
    /// Minimum matched volume in base atoms.
    pub min_matched: u128,
    /// Maximum `|D − S| / V` in basis points; `None` disables the check.
    pub max_imbalance_bps: Option<u32>,
}

/// Why a cleared cross was suppressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoPrint {
    BelowMinimumVolume,
    ImbalanceTooHigh,
}

impl PrintGuards {
    pub fn check(&self, c: &Clearing) -> Result<(), NoPrint> {
        if c.matched < self.min_matched {
            return Err(NoPrint::BelowMinimumVolume);
        }
        if let Some(max) = self.max_imbalance_bps {
            // imbalance · 10_000 > max · matched, without division.
            let lhs = c.imbalance().saturating_mul(10_000);
            let rhs = u128::from(max).saturating_mul(c.matched);
            if lhs > rhs {
                return Err(NoPrint::ImbalanceTooHigh);
            }
        }
        Ok(())
    }
}

/// `floor(a · b / d)` for `d > 0` with a 256-bit intermediate, saturating at `u128::MAX`.
fn mul_div_floor(a: u128, b: u128, d: u128) -> u128 {
    let (q, _) = mul_div(a, b, d);
    q
}

/// `ceil(a · b / d)` for `d > 0`, saturating at `u128::MAX`.
fn mul_div_ceil(a: u128, b: u128, d: u128) -> u128 {
    let (q, rem) = mul_div(a, b, d);
    if rem {
        q.saturating_add(1)
    } else {
        q
    }
}

/// Returns `(floor(a·b/d), remainder != 0)`. Uses 64-bit limbs so intermediate products of two
/// u128 values never overflow. `d == 0` yields `(0, false)`.
#[allow(clippy::arithmetic_side_effects)] // every operation below is on values proven in range
fn mul_div(a: u128, b: u128, d: u128) -> (u128, bool) {
    if d == 0 {
        return (0, false);
    }
    if let Some(prod) = a.checked_mul(b) {
        return (prod / d, prod % d != 0);
    }
    // 256-bit product as (hi, lo).
    let (a1, a0) = (a >> 64, a & u128::from(u64::MAX));
    let (b1, b0) = (b >> 64, b & u128::from(u64::MAX));
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 64) + (p01 & u128::from(u64::MAX)) + (p10 & u128::from(u64::MAX));
    let lo = (p00 & u128::from(u64::MAX)) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    if hi >= d {
        return (u128::MAX, true); // quotient does not fit; saturate
    }
    // Long division of (hi, lo) by d, one bit at a time. hi < d keeps the remainder < d.
    let mut rem = hi;
    let mut quot: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        quot <<= 1;
        if carry == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            quot |= 1;
        }
    }
    (quot, rem != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_wide() {
        let a = u128::MAX / 3;
        assert_eq!(
            mul_div(a, 6, 9),
            (a / 9 * 6 + (a % 9) * 6 / 9, (a % 9) * 6 % 9 != 0)
        );
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), (u128::MAX, false));
        assert_eq!(mul_div(1 << 100, 1 << 100, 1 << 120), (1 << 80, false));
        assert_eq!(mul_div(7, 3, 2), (10, true));
    }
}
