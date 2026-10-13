//! Differential and invariant fuzzing of the clearing rule (ADR-0003).
//!
//! Every input is a price grid, an optional reference price and a list of orders. The target
//! asserts that `clear` agrees with an exhaustive evaluation of the rule at every grid price,
//! and that the fills it implies respect the invariants the program relies on: one uniform
//! price, no order filled beyond its limit or quantity, volume conserved up to the documented
//! rounding dust, the buyer never paying less than the seller receives, and independence of
//! the order in which orders arrive.
#![no_main]

use arbitrary::Arbitrary;
use clearing_core::{buyer_pays, clear, fill, seller_receives, Clearing, Level, LinearGrid, OffsetGrid, Side, TickGrid};
use libfuzzer_sys::fuzz_target;

#[derive(Arbitrary, Debug)]
struct RawOrder {
    buy: bool,
    price_index: u8,
    quantity: u64,
    /// Right shift applied to `quantity`, so that small and enormous quantities both occur.
    shift: u8,
}

#[derive(Arbitrary, Debug)]
struct Input {
    linear: bool,
    min: u32,
    tick: u32,
    ticks: u8,
    reference_index: Option<u8>,
    orders: Vec<RawOrder>,
}

#[derive(Clone, Copy, Debug)]
struct Order {
    side: Side,
    price: u64,
    qty: u64,
}

fn levels_of(orders: &[Order]) -> Vec<Level> {
    let mut sorted = orders.to_vec();
    sorted.sort_by_key(|o| o.price);
    let mut levels: Vec<Level> = Vec::new();
    for o in sorted {
        if levels.last().is_none_or(|l| l.price != o.price) {
            levels.push(Level { price: o.price, ..Level::default() });
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

/// The ADR-0003 rule evaluated directly from the order list at every candidate price.
fn reference_clear(orders: &[Order], reference: Option<u64>, candidates: &[u64]) -> Option<(u64, u128)> {
    let mut best: Option<(u64, u128, u128)> = None;
    for &p in candidates {
        let sum = |f: &dyn Fn(&Order) -> bool| orders.iter().filter(|o| f(o)).map(|o| u128::from(o.qty)).sum::<u128>();
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

fn check(orders: &[Order], reference: Option<u64>, grid: &impl TickGrid, candidates: &[u64]) -> Option<Clearing> {
    let got = clear(&levels_of(orders), reference, grid).expect("levels are sorted and consistent by construction");
    assert_eq!(
        got.map(|c| (c.price, c.matched)),
        reference_clear(orders, reference, candidates),
        "clear disagrees with the exhaustive reference: orders {orders:?} reference {reference:?}"
    );
    let c = got?;

    let (mut bought, mut sold) = (0u128, 0u128);
    for o in orders {
        let f = fill(o.side, o.price, o.qty, &c);
        assert!(f <= o.qty, "filled {f} of {}: {o:?} {c:?}", o.qty);
        match o.side {
            Side::Buy => {
                if f > 0 {
                    assert!(o.price >= c.price, "buy filled above its limit: {o:?} {c:?}");
                }
                if o.price < c.price {
                    assert_eq!(f, 0);
                }
                if o.price > c.price {
                    assert_eq!(f, o.qty, "a buy strictly above P* must fill completely: {o:?} {c:?}");
                }
                bought += u128::from(f);
            }
            Side::Sell => {
                if f > 0 {
                    assert!(o.price <= c.price, "sell filled below its limit: {o:?} {c:?}");
                }
                if o.price > c.price {
                    assert_eq!(f, 0);
                }
                if o.price < c.price {
                    assert_eq!(f, o.qty, "a sell strictly below P* must fill completely: {o:?} {c:?}");
                }
                sold += u128::from(f);
            }
        }
        if f > 0 {
            if let (Some(pay), Some(recv)) = (buyer_pays(f, c.price, 1_000_000), seller_receives(f, c.price, 1_000_000)) {
                assert!(pay >= recv, "a buyer pays {pay} for what a seller receives {recv}");
            }
        }
    }
    assert!(sold >= bought, "sold {sold} < bought {bought}: {c:?}");
    assert!(sold - bought <= c.max_dust(), "dust {} above bound {}: {c:?}", sold - bought, c.max_dust());
    assert!(bought <= c.matched && c.matched <= sold, "volume not conserved: bought {bought} matched {} sold {sold}", c.matched);
    Some(c)
}

fuzz_target!(|input: Input| {
    let ticks = u64::from(input.ticks % 48) + 2;
    let step = u64::from(input.tick.max(1));
    let min = if input.linear { 0 } else { u64::from(input.min) };
    let price_at = |i: u8| min + (u64::from(i) % ticks) * step;
    let orders: Vec<Order> = input
        .orders
        .iter()
        .take(48)
        .filter_map(|r| {
            let qty = r.quantity >> (r.shift % 64);
            (qty > 0).then_some(Order { side: if r.buy { Side::Buy } else { Side::Sell }, price: price_at(r.price_index), qty })
        })
        .collect();
    let reference = input.reference_index.map(price_at);
    // Every grid price; the linear grid also includes the price one step above the last order.
    let candidates: Vec<u64> = (0..=ticks).map(|i| min + i * step).collect();

    let (first, again) = if input.linear {
        let grid = LinearGrid { step };
        let mut reversed = orders.clone();
        reversed.reverse();
        (check(&orders, reference, &grid, &candidates), clear(&levels_of(&reversed), reference, &grid))
    } else {
        let grid = OffsetGrid { min, tick: step, ticks: ticks as u16 };
        let mut reversed = orders.clone();
        reversed.reverse();
        (check(&orders, reference, &grid, &candidates[..ticks as usize]), clear(&levels_of(&reversed), reference, &grid))
    };

    // The result is a function of the book, not of the order in which orders arrived.
    assert_eq!(first, again.expect("sorted"), "arrival order changed the clearing");
});
