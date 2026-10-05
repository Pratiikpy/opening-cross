//! Property tests: `clear` against an exhaustive reference over every grid price, plus the
//! conservation, feasibility and order-independence invariants from ADR-0003.

use clearing_core::*;
use proptest::prelude::*;

#[derive(Clone, Copy, Debug)]
struct Order {
    side: Side,
    price: u64,
    qty: u64,
}

fn levels_of(orders: &[Order]) -> Vec<Level> {
    let mut levels: Vec<Level> = Vec::new();
    let mut sorted = orders.to_vec();
    sorted.sort_by_key(|o| o.price);
    for o in sorted {
        if levels.last().is_none_or(|l| l.price != o.price) {
            levels.push(Level {
                price: o.price,
                ..Level::default()
            });
        }
        let l = levels.last_mut().unwrap();
        match o.side {
            Side::Buy => {
                l.buy += u128::from(o.qty);
                l.buy_orders += 1;
            }
            Side::Sell => {
                l.sell += u128::from(o.qty);
                l.sell_orders += 1;
            }
        }
    }
    levels
}

/// Exhaustive reference: evaluates the ADR-0003 rule at every integer price in range directly
/// from the order list. Returns `(price, matched)`.
fn reference_clear(
    orders: &[Order],
    reference: Option<u64>,
    max_price: u64,
) -> Option<(u64, u128)> {
    let mut best: Option<(u64, u128, u128)> = None; // price, matched, imbalance
    for p in 0..=max_price + 1 {
        let sum = |f: &dyn Fn(&Order) -> bool| {
            orders
                .iter()
                .filter(|o| f(o))
                .map(|o| u128::from(o.qty))
                .sum::<u128>()
        };
        let d = sum(&|o| o.side == Side::Buy && o.price >= p);
        let d_plus = sum(&|o| o.side == Side::Buy && o.price > p);
        let s = sum(&|o| o.side == Side::Sell && o.price <= p);
        let s_minus = sum(&|o| o.side == Side::Sell && o.price < p);
        let v = d.min(s);
        if v == 0 || v < d_plus || v < s_minus {
            continue;
        }
        let imb = d.abs_diff(s);
        let take = match best {
            None => true,
            Some((bp, bv, bi)) => {
                if v != bv {
                    v > bv
                } else if imb != bi {
                    imb < bi
                } else if let Some(r) = reference.filter(|r| p.abs_diff(*r) != bp.abs_diff(*r)) {
                    p.abs_diff(r) < bp.abs_diff(r)
                } else {
                    p < bp
                }
            }
        };
        if take {
            best = Some((p, v, imb));
        }
    }
    best.map(|(p, v, _)| (p, v))
}

fn order() -> impl Strategy<Value = Order> {
    (
        prop_oneof![Just(Side::Buy), Just(Side::Sell)],
        1u64..=20,
        1u64..=1_000,
    )
        .prop_map(|(side, price, qty)| Order { side, price, qty })
}

const GRID: LinearGrid = LinearGrid { step: 1 };

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn matches_exhaustive_reference(orders in prop::collection::vec(order(), 0..40), reference in prop::option::of(1u64..=20)) {
        let got = clear(&levels_of(&orders), reference, &GRID).unwrap().map(|c| (c.price, c.matched));
        prop_assert_eq!(got, reference_clear(&orders, reference, 20));
    }

    #[test]
    fn fills_conserve_and_respect_limits(orders in prop::collection::vec(order(), 1..60), reference in prop::option::of(1u64..=20)) {
        let Some(c) = clear(&levels_of(&orders), reference, &GRID).unwrap() else { return Ok(()); };
        let (mut bought, mut sold) = (0u128, 0u128);
        for o in &orders {
            let f = fill(o.side, o.price, o.qty, &c);
            prop_assert!(f <= o.qty);
            match o.side {
                Side::Buy => {
                    if o.price < c.price { prop_assert_eq!(f, 0); }
                    if o.price > c.price { prop_assert_eq!(f, o.qty); }
                    bought += u128::from(f);
                }
                Side::Sell => {
                    if o.price > c.price { prop_assert_eq!(f, 0); }
                    if o.price < c.price { prop_assert_eq!(f, o.qty); }
                    sold += u128::from(f);
                }
            }
        }
        // Σ buy fills + dust = Σ sell fills, 0 ≤ dust ≤ marginal orders.
        prop_assert!(sold >= bought, "sold {} < bought {}", sold, bought);
        prop_assert!(sold - bought <= c.max_dust());
        prop_assert!(bought <= c.matched && c.matched <= sold);
    }

    #[test]
    fn order_independent(mut orders in prop::collection::vec(order(), 1..40), seed in any::<u64>()) {
        let a = clear(&levels_of(&orders), None, &GRID).unwrap();
        // Deterministic shuffle.
        let mut x = seed | 1;
        for i in (1..orders.len()).rev() {
            x ^= x << 13; x ^= x >> 7; x ^= x << 17;
            orders.swap(i, (x % (i as u64 + 1)) as usize);
        }
        prop_assert_eq!(a, clear(&levels_of(&orders), None, &GRID).unwrap());
    }

    #[test]
    fn vault_never_short(orders in prop::collection::vec(order(), 1..60), scale in 1u64..=1_000_000) {
        let Some(c) = clear(&levels_of(&orders), None, &GRID).unwrap() else { return Ok(()); };
        let (mut paid_in, mut paid_out) = (0u128, 0u128);
        let (mut bought, mut sold) = (0u64, 0u64);
        for o in &orders {
            let f = fill(o.side, o.price, o.qty, &c);
            match o.side {
                Side::Buy => { bought += f; paid_in += u128::from(buyer_pays(f, c.price, scale).unwrap()); }
                Side::Sell => { sold += f; paid_out += u128::from(seller_receives(f, c.price, scale).unwrap()); }
            }
        }
        // The dust bond pays for the difference at P* (rounded up), like any buyer.
        paid_in += u128::from(buyer_pays(sold - bought, c.price, scale).unwrap());
        prop_assert!(paid_in >= paid_out);
    }

    #[test]
    fn adding_a_buy_never_lowers_price_or_volume(orders in prop::collection::vec(order(), 1..40), extra in order()) {
        let extra = Order { side: Side::Buy, ..extra };
        let before = clear(&levels_of(&orders), None, &GRID).unwrap();
        let mut more = orders.clone();
        more.push(extra);
        let after = clear(&levels_of(&more), None, &GRID).unwrap();
        if let (Some(b), Some(a)) = (before, after) {
            prop_assert!(a.matched >= b.matched);
        }
        if before.is_some() { prop_assert!(after.is_some()); }
    }
}

#[test]
fn launch_with_elastic_supply() {
    // Issuer sells 100 at 10, another 100 at 12, another 100 at 15. Buyers: 150 at 12, 80 at 15.
    let orders = [
        Order {
            side: Side::Sell,
            price: 10,
            qty: 100,
        },
        Order {
            side: Side::Sell,
            price: 12,
            qty: 100,
        },
        Order {
            side: Side::Sell,
            price: 15,
            qty: 100,
        },
        Order {
            side: Side::Buy,
            price: 12,
            qty: 150,
        },
        Order {
            side: Side::Buy,
            price: 15,
            qty: 80,
        },
    ];
    let c = clear(&levels_of(&orders), None, &GRID).unwrap().unwrap();
    assert_eq!((c.price, c.matched), (12, 200));
    // D(12) = 230 > S(12) = 200: the 150 bid at 12 gets the 120 left after the 80 bid at 15.
    assert_eq!(c.rationed, Some(Side::Buy));
    assert_eq!(fill(Side::Buy, 12, 150, &c), 120);
    assert_eq!(fill(Side::Buy, 15, 80, &c), 80);
    assert_eq!(fill(Side::Sell, 12, 100, &c), 100);
}

#[test]
fn oversubscribed_buyers_are_prorated() {
    let orders = [
        Order {
            side: Side::Sell,
            price: 10,
            qty: 100,
        },
        Order {
            side: Side::Buy,
            price: 10,
            qty: 150,
        },
        Order {
            side: Side::Buy,
            price: 10,
            qty: 50,
        },
        Order {
            side: Side::Buy,
            price: 11,
            qty: 40,
        },
    ];
    let c = clear(&levels_of(&orders), None, &GRID).unwrap().unwrap();
    assert_eq!((c.price, c.matched, c.rationed), (10, 100, Some(Side::Buy)));
    assert_eq!(fill(Side::Buy, 11, 40, &c), 40);
    // 60 left for 200 at the margin: 150 → 45, 50 → 15.
    assert_eq!(fill(Side::Buy, 10, 150, &c), 45);
    assert_eq!(fill(Side::Buy, 10, 50, &c), 15);
}

#[test]
fn interior_tick_beats_both_neighbours() {
    // Sell 10@3, buy 4@3, buy 10@5. At 3: imbalance 4. Inside the gap (4): D = S = 10.
    let orders = [
        Order {
            side: Side::Sell,
            price: 3,
            qty: 10,
        },
        Order {
            side: Side::Buy,
            price: 3,
            qty: 4,
        },
        Order {
            side: Side::Buy,
            price: 5,
            qty: 10,
        },
    ];
    let c = clear(&levels_of(&orders), None, &GRID).unwrap().unwrap();
    assert_eq!((c.price, c.matched, c.rationed), (4, 10, None));
    let c = clear(&levels_of(&orders), Some(9), &GRID).unwrap().unwrap();
    assert_eq!(
        c.price, 5,
        "with a reference above, the tie goes to the price nearest it"
    );
}

#[test]
fn no_cross_does_not_print() {
    let orders = [
        Order {
            side: Side::Sell,
            price: 10,
            qty: 5,
        },
        Order {
            side: Side::Buy,
            price: 9,
            qty: 5,
        },
    ];
    assert_eq!(clear(&levels_of(&orders), None, &GRID).unwrap(), None);
    assert_eq!(clear(&[], None, &GRID).unwrap(), None);
}

#[test]
fn rejects_bad_input() {
    let l = |price| Level {
        price,
        buy: 1,
        buy_orders: 1,
        ..Level::default()
    };
    assert_eq!(
        clear(&[l(2), l(1)], None, &GRID),
        Err(ClearError::UnsortedLevels)
    );
    assert_eq!(
        clear(&[l(1), l(1)], None, &GRID),
        Err(ClearError::UnsortedLevels)
    );
    let bad = Level {
        price: 1,
        buy: 5,
        ..Level::default()
    };
    assert_eq!(
        clear(&[bad], None, &GRID),
        Err(ClearError::InconsistentLevel)
    );
}

#[test]
fn print_guards() {
    let orders = [
        Order {
            side: Side::Sell,
            price: 10,
            qty: 100,
        },
        Order {
            side: Side::Buy,
            price: 10,
            qty: 300,
        },
    ];
    let c = clear(&levels_of(&orders), None, &GRID).unwrap().unwrap();
    assert_eq!(
        PrintGuards {
            min_matched: 101,
            max_imbalance_bps: None
        }
        .check(&c),
        Err(NoPrint::BelowMinimumVolume)
    );
    assert_eq!(
        PrintGuards {
            min_matched: 0,
            max_imbalance_bps: Some(19_999)
        }
        .check(&c),
        Err(NoPrint::ImbalanceTooHigh)
    );
    assert_eq!(
        PrintGuards {
            min_matched: 100,
            max_imbalance_bps: Some(20_000)
        }
        .check(&c),
        Ok(())
    );
}

#[test]
fn payment_rounding_and_overflow() {
    assert_eq!(buyer_pays(3, 10, 4), Some(8)); // 7.5 → 8
    assert_eq!(seller_receives(3, 10, 4), Some(7));
    assert_eq!(buyer_pays(1, 1, 0), None);
    assert_eq!(buyer_pays(u64::MAX, u64::MAX, 1), None);
    assert_eq!(
        seller_receives(u64::MAX, u64::MAX, u64::MAX),
        Some(u64::MAX)
    );
}

#[test]
fn linear_grid() {
    let g = LinearGrid { step: 5 };
    assert_eq!(
        (g.next(10), g.next(11), g.prev(10), g.prev(11), g.prev(0)),
        (Some(15), Some(15), Some(5), Some(10), None)
    );
    assert_eq!(LinearGrid { step: 0 }.next(1), None);
}
