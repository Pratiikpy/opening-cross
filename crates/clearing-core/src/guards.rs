//! Print guards beyond the volume and imbalance checks of [`crate::PrintGuards`] (ADR-0101).
//!
//! Every guard here is a pure function of the clearing summary and published parameters, so the
//! program, the independent verifier and any third-party implementation reach the same verdict.
//! Guards that depend on outside state (an oracle, a halt flag, a mint's pause extension) are not
//! here: they are evaluated by the program from accounts and cannot be recomputed from the book.
use crate::{mul_div_floor, Clearing, NoPrint, PrintGuards};

/// Raise, float, valuation and price-move guards. A zero value switches a guard off.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RaiseGuards {
    /// Minimum raise in quote atoms: `floor(counted · P* / price_scale)` must reach it.
    pub min_raise_quote: u128,
    pub price_scale: u64,
    /// Declared fully diluted supply in base atoms (0 = unknown, the two guards below are off).
    pub total_supply: u128,
    /// Public float: `counted / total_supply` must reach this many basis points.
    pub min_float_bps: u32,
    /// FDV-to-raise ratio times 100: `total_supply / counted ≤ max_fdv_x100 / 100`.
    pub max_fdv_x100: u64,
    /// Anchor for the move guard: the issuer's estimate or the reopen reference (0 = off).
    pub anchor_price: u64,
    /// `|P* − anchor| / anchor` may not exceed this many basis points (0 = off).
    pub move_bps: u32,
}

/// Why a cleared cross is suppressed, across every pure guard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrintFailure {
    BelowMinimumVolume,
    ImbalanceTooHigh,
    BelowMinimumRaise,
    FloatTooLow,
    FdvTooHigh,
    PriceMoved,
}

impl From<NoPrint> for PrintFailure {
    fn from(e: NoPrint) -> Self {
        match e {
            NoPrint::BelowMinimumVolume => PrintFailure::BelowMinimumVolume,
            NoPrint::ImbalanceTooHigh => PrintFailure::ImbalanceTooHigh,
        }
    }
}

impl RaiseGuards {
    /// `counted` is the matched volume that counts toward the minimum raise and the float: the
    /// matched volume less what declared insiders were allocated (ADR-0106).
    pub fn check(&self, c: &Clearing, counted: u128) -> Result<(), PrintFailure> {
        if self.min_raise_quote > 0 {
            let raised = mul_div_floor(counted, u128::from(c.price), u128::from(self.price_scale));
            if raised < self.min_raise_quote {
                return Err(PrintFailure::BelowMinimumRaise);
            }
        }
        if self.total_supply > 0 {
            if self.min_float_bps > 0
                && counted.saturating_mul(10_000)
                    < u128::from(self.min_float_bps).saturating_mul(self.total_supply)
            {
                return Err(PrintFailure::FloatTooLow);
            }
            if self.max_fdv_x100 > 0
                && self.total_supply.saturating_mul(100)
                    > u128::from(self.max_fdv_x100).saturating_mul(counted)
            {
                return Err(PrintFailure::FdvTooHigh);
            }
        }
        if self.move_bps > 0 && self.anchor_price > 0 {
            let moved = u128::from(c.price.abs_diff(self.anchor_price)).saturating_mul(10_000);
            if moved > u128::from(self.move_bps).saturating_mul(u128::from(self.anchor_price)) {
                return Err(PrintFailure::PriceMoved);
            }
        }
        Ok(())
    }
}

/// All pure guards in their fixed order: minimum volume, imbalance, minimum raise, float,
/// valuation, price move. The minimum volume counts only `counted` (insiders excluded); the
/// imbalance is the book's own.
pub fn check_all(
    base: &PrintGuards,
    raise: &RaiseGuards,
    c: &Clearing,
    counted: u128,
) -> Result<(), PrintFailure> {
    if counted < base.min_matched {
        return Err(PrintFailure::BelowMinimumVolume);
    }
    if let Some(max) = base.max_imbalance_bps {
        let lhs = c.imbalance().saturating_mul(10_000);
        let rhs = u128::from(max).saturating_mul(c.matched);
        if lhs > rhs {
            return Err(PrintFailure::ImbalanceTooHigh);
        }
    }
    raise.check(c, counted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clearing(price: u64, matched: u128) -> Clearing {
        Clearing {
            price,
            matched,
            demand: matched,
            supply: matched,
            rationed: None,
            marginal_quantity: 0,
            marginal_remaining: 0,
            marginal_orders: 0,
        }
    }

    #[test]
    fn min_raise_uses_the_floor_of_the_notional() {
        let g = RaiseGuards {
            min_raise_quote: 1_500_000,
            price_scale: 1_000_000,
            ..RaiseGuards::default()
        };
        // 1_000_000 base at 1.5 → exactly 1_500_000.
        assert_eq!(g.check(&clearing(1_500_000, 1_000_000), 1_000_000), Ok(()));
        // One atom short: floor(999_999 · 1.5) = 1_499_998.
        assert_eq!(
            g.check(&clearing(1_500_000, 1_000_000), 999_999),
            Err(PrintFailure::BelowMinimumRaise)
        );
    }

    #[test]
    fn float_and_valuation_are_two_views_of_one_ratio() {
        let g = RaiseGuards {
            price_scale: 1,
            total_supply: 1_000,
            min_float_bps: 1_000, // at least 10%
            max_fdv_x100: 1_000,  // FDV at most 10× the raise
            ..RaiseGuards::default()
        };
        assert_eq!(g.check(&clearing(1, 100), 100), Ok(()));
        assert_eq!(
            g.check(&clearing(1, 99), 99),
            Err(PrintFailure::FloatTooLow)
        );
        let fdv_only = RaiseGuards {
            min_float_bps: 0,
            ..g
        };
        assert_eq!(fdv_only.check(&clearing(1, 100), 100), Ok(()));
        assert_eq!(
            fdv_only.check(&clearing(1, 99), 99),
            Err(PrintFailure::FdvTooHigh)
        );
        // An unknown supply switches both off.
        let unknown = RaiseGuards {
            total_supply: 0,
            ..g
        };
        assert_eq!(unknown.check(&clearing(1, 1), 1), Ok(()));
    }

    #[test]
    fn price_move_is_symmetric_and_exact_at_the_bound() {
        let g = RaiseGuards {
            price_scale: 1,
            anchor_price: 1_000,
            move_bps: 2_000,
            ..RaiseGuards::default()
        };
        assert_eq!(g.check(&clearing(1_200, 5), 5), Ok(()));
        assert_eq!(g.check(&clearing(800, 5), 5), Ok(()));
        assert_eq!(
            g.check(&clearing(1_201, 5), 5),
            Err(PrintFailure::PriceMoved)
        );
        assert_eq!(g.check(&clearing(799, 5), 5), Err(PrintFailure::PriceMoved));
    }

    #[test]
    fn check_all_orders_the_guards() {
        let base = PrintGuards {
            min_matched: 10,
            max_imbalance_bps: Some(0),
        };
        let raise = RaiseGuards {
            min_raise_quote: 1_000_000,
            price_scale: 1,
            ..RaiseGuards::default()
        };
        let mut c = clearing(1, 5);
        // Volume is checked before everything else, on the counted figure.
        assert_eq!(
            check_all(&base, &raise, &c, 5),
            Err(PrintFailure::BelowMinimumVolume)
        );
        c.matched = 20;
        c.supply = 20;
        c.demand = 25;
        assert_eq!(
            check_all(&base, &raise, &c, 20),
            Err(PrintFailure::ImbalanceTooHigh)
        );
        c.demand = 20;
        assert_eq!(
            check_all(&base, &raise, &c, 20),
            Err(PrintFailure::BelowMinimumRaise)
        );
        // Insiders excluded: the book matched 20 but only 8 count.
        assert_eq!(
            check_all(&base, &RaiseGuards::default(), &c, 8),
            Err(PrintFailure::BelowMinimumVolume)
        );
    }
}
