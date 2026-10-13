//! Writes the Opening Cross conformance vectors for the rules added after v1
//! (`opening-cross/conformance/v2`) to stdout.
//!
//! v1 covers the clearing rule of ADR-0003. v2 covers what ADR-0101 and ADR-0104 to ADR-0106 add on
//! top of it, each as the program applies it: a supply cap (the hard cap on a raise), the raise,
//! float, valuation and price-move guards, allocation classes with reserved shares and spill-over,
//! the class-1 lottery, and the exclusion of declared insiders from the minimum raise. Every
//! expected value is produced by this crate, the code that runs on chain, following the path of
//! `cross_core::clear` and `cross_core::claim`. CI regenerates the file and fails on any
//! difference; the independent TypeScript implementation must reproduce every case.
//!
//!   cargo run -p clearing-core --example conformance_vectors_v2 > packages/verifier/conformance/v2.json
use clearing_core::{
    check_all, class0_fill_upper_bound, clear_with, fill_with_policy, AllocPolicy, Clearing, Level,
    Marginal, OffsetGrid, PrintFailure, PrintGuards, RaiseGuards, Side,
};
use std::collections::BTreeMap;
use std::fmt::Write;

use Side::{Buy as B, Sell as S};

#[derive(Clone, Copy)]
struct Odr {
    side: Side,
    price: u64,
    qty: u64,
    class: u8,
    insider: bool,
}

#[derive(Clone)]
struct Case {
    name: String,
    min: u64,
    tick: u64,
    ticks: u16,
    reference: Option<u64>,
    min_matched: u64,
    max_imbalance_bps: Option<u32>,
    supply_cap: Option<u64>,
    min_raise_quote: u64,
    price_scale: u64,
    total_supply: u64,
    min_float_bps: u32,
    max_fdv_x100: u64,
    anchor_price: u64,
    move_bps: u32,
    policy: AllocPolicy,
    rho: u32,
    orders: Vec<Odr>,
}

fn base(name: &str, orders: &[Odr]) -> Case {
    Case {
        name: name.into(),
        min: 100,
        tick: 10,
        ticks: 20,
        reference: None,
        min_matched: 0,
        max_imbalance_bps: None,
        supply_cap: None,
        min_raise_quote: 0,
        price_scale: 1,
        total_supply: 0,
        min_float_bps: 0,
        max_fdv_x100: 0,
        anchor_price: 0,
        move_bps: 0,
        policy: AllocPolicy::default(),
        rho: 0,
        orders: orders.to_vec(),
    }
}

fn o(side: Side, price: u64, qty: u64) -> Odr {
    Odr {
        side,
        price,
        qty,
        class: 0,
        insider: false,
    }
}
fn oc(price: u64, qty: u64, class: u8) -> Odr {
    Odr {
        side: B,
        price,
        qty,
        class,
        insider: false,
    }
}
fn oi(price: u64, qty: u64) -> Odr {
    Odr {
        side: B,
        price,
        qty,
        class: 0,
        insider: true,
    }
}

fn curated() -> Vec<Case> {
    let mut v = Vec::new();

    // ---- supply cap
    let schedule = [o(S, 100, 50), o(S, 150, 50), o(S, 200, 100)];
    let demand = [o(B, 250, 60), o(B, 180, 60), o(B, 130, 60)];
    let orders: Vec<Odr> = schedule.iter().chain(demand.iter()).copied().collect();
    v.push(base(
        "no cap: the schedule sells what demand takes",
        &orders,
    ));
    let mut c = base("a cap below demand raises the clearing price", &orders);
    c.supply_cap = Some(80);
    v.push(c);
    let mut c = base("a cap above demand changes nothing", &orders);
    c.supply_cap = Some(10_000);
    v.push(c);
    let mut c = base("a cap exactly equal to matched volume", &orders);
    c.supply_cap = Some(100);
    v.push(c);
    let mut c = base("a cap of one atom", &orders);
    c.supply_cap = Some(1);
    v.push(c);
    let mut c = base(
        "a cap with a reference price",
        &[o(S, 100, 100), o(B, 250, 30), o(B, 200, 30), o(B, 150, 30)],
    );
    c.supply_cap = Some(60);
    c.reference = Some(150);
    v.push(c);

    // ---- raise guards
    let book = [o(S, 100, 100), o(B, 200, 100)];
    let mut c = base("minimum raise met exactly", &book);
    c.min_raise_quote = 10_000;
    v.push(c);
    let mut c = base("minimum raise missed by one atom of quote", &book);
    c.min_raise_quote = 10_001;
    v.push(c);
    let mut c = base("minimum raise uses the price scale", &book);
    c.price_scale = 1_000;
    c.min_raise_quote = 10;
    v.push(c);
    let mut c = base("minimum raise floors the notional", &book);
    c.price_scale = 1_000;
    c.min_raise_quote = 11;
    v.push(c);
    let mut c = base("float exactly at the minimum", &book);
    c.total_supply = 1_000;
    c.min_float_bps = 1_000;
    v.push(c);
    let mut c = base("float one basis point short", &book);
    c.total_supply = 1_000;
    c.min_float_bps = 1_001;
    v.push(c);
    let mut c = base("valuation exactly at the maximum", &book);
    c.total_supply = 1_000;
    c.max_fdv_x100 = 1_000;
    v.push(c);
    let mut c = base("valuation just above the maximum", &book);
    c.total_supply = 1_000;
    c.max_fdv_x100 = 999;
    v.push(c);
    let mut c = base(
        "float and valuation are off when the supply is unknown",
        &book,
    );
    c.min_float_bps = 10_000;
    c.max_fdv_x100 = 100;
    v.push(c);
    let mut c = base("price move inside the bound", &book);
    c.anchor_price = 100;
    c.move_bps = 2_000;
    v.push(c);
    let mut c = base(
        "price move exactly at the bound",
        &[o(S, 100, 100), o(B, 120, 100)],
    );
    c.anchor_price = 100;
    c.move_bps = 2_000;
    v.push(c);
    let mut c = base(
        "price move beyond the bound upward",
        &[o(S, 100, 100), o(B, 130, 100)],
    );
    c.anchor_price = 100;
    c.move_bps = 2_000;
    c.reference = Some(130);
    v.push(c);
    let mut c = base(
        "price move beyond the bound downward",
        &[o(S, 100, 100), o(B, 200, 100), o(B, 150, 100)],
    );
    c.anchor_price = 200;
    c.move_bps = 2_000;
    v.push(c);
    let mut c = base("the volume guard is checked before the raise guard", &book);
    c.min_matched = 101;
    c.min_raise_quote = 1_000_000;
    v.push(c);

    // ---- allocation classes: reserved shares with spill-over
    let supply = o(S, 100, 100);
    let mut c = base(
        "no policy: pro rata at the margin",
        &[supply, oc(100, 60, 0), oc(100, 60, 0), oc(100, 80, 0)],
    );
    c.policy = AllocPolicy::default();
    v.push(c);
    let mut c = base(
        "locked class reserve fills its class first",
        &[
            supply,
            oc(100, 60, 2),
            oc(100, 40, 2),
            oc(100, 100, 0),
            oc(100, 100, 0),
        ],
    );
    c.policy = AllocPolicy {
        reserve_bps: [0, 5_000, 0],
        lottery_unit: 0,
    };
    v.push(c);
    let mut c = base(
        "a reserve the class cannot fill spills to everyone",
        &[supply, oc(100, 10, 2), oc(100, 90, 0), oc(100, 90, 0)],
    );
    c.policy = AllocPolicy {
        reserve_bps: [0, 6_000, 0],
        lottery_unit: 0,
    };
    v.push(c);
    let mut c = base(
        "three classes with awkward sizes",
        &[
            supply,
            oc(100, 41, 1),
            oc(100, 7, 1),
            oc(100, 83, 2),
            oc(100, 17, 2),
            oc(100, 61, 3),
            oc(100, 19, 3),
            oc(100, 101, 0),
            oc(100, 57, 0),
        ],
    );
    c.policy = AllocPolicy {
        reserve_bps: [1_000, 2_000, 1_500],
        lottery_unit: 0,
    };
    v.push(c);
    let mut c = base(
        "better-priced orders fill in full whatever their class",
        &[
            supply,
            oc(150, 30, 0),
            oc(100, 50, 2),
            oc(100, 50, 0),
            oc(100, 50, 2),
        ],
    );
    c.policy = AllocPolicy {
        reserve_bps: [0, 5_000, 0],
        lottery_unit: 0,
    };
    v.push(c);
    let mut c = base(
        "no rationing: classes change nothing",
        &[supply, oc(100, 30, 2), oc(100, 30, 0)],
    );
    c.policy = AllocPolicy {
        reserve_bps: [0, 5_000, 0],
        lottery_unit: 0,
    };
    v.push(c);

    // ---- the class-1 lottery
    let lot = |price: u64| oc(price, 5, 1);
    let mut tickets: Vec<Odr> = vec![supply];
    for _ in 0..10 {
        tickets.push(lot(100));
    }
    tickets.push(oc(100, 150, 0));
    for rho in [0, 3, 8, 9] {
        let mut c = base(
            &format!("lottery: ten tickets, window starts at {rho}"),
            &tickets,
        );
        c.policy = AllocPolicy {
            reserve_bps: [4_000, 0, 0],
            lottery_unit: 5,
        };
        c.rho = rho;
        v.push(c);
    }
    let mut c = base("lottery: more lots than tickets, everyone wins", &tickets);
    c.policy = AllocPolicy {
        reserve_bps: [10_000, 0, 0],
        lottery_unit: 5,
    };
    c.rho = 4;
    v.push(c);
    let mut c = base(
        "lottery: tickets at a better price always fill",
        &[supply, lot(150), lot(100), lot(100), oc(100, 120, 0)],
    );
    c.policy = AllocPolicy {
        reserve_bps: [2_500, 0, 0],
        lottery_unit: 5,
    };
    c.rho = 1;
    v.push(c);

    // ---- class 1 without a lottery
    let mut c = base(
        "class 1 pro rata inside its reserve",
        &[supply, oc(100, 40, 1), oc(100, 20, 1), oc(100, 150, 0)],
    );
    c.policy = AllocPolicy {
        reserve_bps: [3_000, 0, 0],
        lottery_unit: 0,
    };
    v.push(c);

    // ---- insiders left out of the minimum raise
    let mut c = base(
        "insiders: their allocation does not count toward the minimum volume",
        &[supply, oi(100, 50), oc(100, 60, 0)],
    );
    c.min_matched = 100;
    v.push(c);
    let mut c = base(
        "insiders: the minimum volume is met without them",
        &[supply, oi(100, 20), oc(100, 100, 0), oc(150, 30, 0)],
    );
    c.min_matched = 100;
    v.push(c);
    let mut c = base(
        "insiders: better-priced insider orders are excluded in full",
        &[supply, oi(150, 40), oc(100, 150, 0)],
    );
    c.min_raise_quote = 7_000;
    v.push(c);
    let mut c = base(
        "insiders: the exclusion follows the class pools at the margin",
        &[supply, oi(100, 40), oc(100, 40, 2), oc(100, 120, 0)],
    );
    c.policy = AllocPolicy {
        reserve_bps: [0, 5_000, 0],
        lottery_unit: 0,
    };
    c.min_raise_quote = 5_500;
    v.push(c);
    v
}

/// SplitMix64: a fixed, dependency-free generator, so the vectors are reproducible anywhere.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn random(count: usize) -> Vec<Case> {
    let mut r = Rng(0x0C05_5C05_5C05_0002);
    (0..count)
        .map(|i| {
            let ticks = 2 + r.below(30) as u16;
            let tick = 1 + r.below(500);
            let min = r.below(100_000);
            let price = |r: &mut Rng| min + r.below(u64::from(ticks)) * tick;
            let mut orders = Vec::new();
            // The issuer's schedule: a few sell levels.
            for _ in 0..(1 + r.below(4)) {
                orders.push(o(S, price(&mut r), 1 + r.below(400)));
            }
            let lottery = r.below(3) == 0;
            let unit = 1 + r.below(20);
            let insiders = r.below(3) == 0;
            for _ in 0..r.below(30) {
                let class = match r.below(8) {
                    0 | 1 => 1,
                    2 => 2,
                    3 => 3,
                    _ => 0,
                };
                let qty = if class == 1 && lottery {
                    unit
                } else {
                    1 + r.below(300)
                };
                let mut ord = oc(price(&mut r), qty, class);
                if class == 0 && insiders && r.below(4) == 0 {
                    ord.insider = true;
                }
                orders.push(ord);
            }
            let mut c = base(&format!("random #{i}"), &orders);
            c.min = min;
            c.tick = tick;
            c.ticks = ticks;
            if r.below(3) == 0 {
                c.reference = Some(price(&mut r));
            }
            if r.below(4) == 0 {
                c.supply_cap = Some(1 + r.below(600));
            }
            if r.below(3) == 0 {
                c.policy = AllocPolicy {
                    reserve_bps: [
                        r.below(4_000) as u16,
                        r.below(3_000) as u16,
                        r.below(3_000) as u16,
                    ],
                    lottery_unit: if lottery { unit } else { 0 },
                };
                if lottery && c.policy.reserve_bps[0] == 0 {
                    c.policy.reserve_bps[0] = 1_000;
                }
            } else if lottery {
                // Without a policy a class-1 lot is just an order; keep the quantity.
            }
            if r.below(4) == 0 {
                c.min_matched = r.below(300);
            }
            if r.below(4) == 0 {
                c.max_imbalance_bps = Some(r.below(30_000) as u32);
            }
            if r.below(4) == 0 {
                c.price_scale = 1 + r.below(1_000);
                c.min_raise_quote = r.below(400_000);
            }
            if r.below(4) == 0 {
                c.total_supply = 1 + r.below(5_000);
                c.min_float_bps = r.below(3_000) as u32;
                c.max_fdv_x100 = if r.below(2) == 0 {
                    0
                } else {
                    100 + r.below(3_000)
                };
            }
            if r.below(5) == 0 {
                c.anchor_price = min + 1 + r.below(u64::from(ticks) * tick);
                c.move_bps = 100 + r.below(8_000) as u32;
            }
            c.rho = r.below(1 << 31) as u32; // reduced modulo the ticket count when rendered
            c
        })
        .collect()
}

fn side(s: Side) -> &'static str {
    match s {
        B => "buy",
        S => "sell",
    }
}

fn reason(f: PrintFailure) -> &'static str {
    match f {
        PrintFailure::BelowMinimumVolume => "BelowMinimumVolume",
        PrintFailure::ImbalanceTooHigh => "ImbalanceTooHigh",
        PrintFailure::BelowMinimumRaise => "BelowMinimumRaise",
        PrintFailure::FloatTooLow => "FloatTooLow",
        PrintFailure::FdvTooHigh => "FdvTooHigh",
        PrintFailure::PriceMoved => "PriceMoved",
    }
}

fn render(c: &Case) -> String {
    let mut levels: BTreeMap<u64, Level> = BTreeMap::new();
    for ord in &c.orders {
        let l = levels.entry(ord.price).or_insert(Level {
            price: ord.price,
            ..Level::default()
        });
        match ord.side {
            B => {
                l.buy += u128::from(ord.qty);
                l.buy_orders += 1;
            }
            S => {
                l.sell += u128::from(ord.qty);
                l.sell_orders += 1;
            }
        }
    }
    let levels: Vec<Level> = levels.into_values().collect();
    let grid = OffsetGrid {
        min: c.min,
        tick: c.tick,
        ticks: c.ticks,
    };
    let cap = c.supply_cap.map(u128::from);
    let result = clear_with(&levels, c.reference, &grid, cap).expect("well formed");

    let mut o = String::new();
    write!(
        o,
        "{{\"name\":\"{}\",\"grid\":{{\"min\":\"{}\",\"tick\":\"{}\",\"ticks\":{}}},",
        c.name, c.min, c.tick, c.ticks
    )
    .unwrap();
    write!(
        o,
        "\"reference\":{},",
        c.reference.map_or("null".into(), |r| format!("\"{r}\""))
    )
    .unwrap();
    write!(
        o,
        "\"guards\":{{\"minMatched\":\"{}\",\"maxImbalanceBps\":{}}},",
        c.min_matched,
        c.max_imbalance_bps.map_or("null".into(), |b| b.to_string())
    )
    .unwrap();

    // The marginal figures the program records, and the lottery start reduced as it reduces it.
    let marginal_for = |cl: &Clearing| -> Marginal {
        let mut m = Marginal::default();
        for ord in c
            .orders
            .iter()
            .filter(|x| x.side == B && x.price == cl.price)
        {
            if (1..=3).contains(&ord.class) {
                m.qty[usize::from(ord.class - 1)] += u128::from(ord.qty);
            }
            if ord.class == 1 {
                m.tickets += 1;
            }
        }
        m.rho = if c.policy.lottery_unit > 0 && m.tickets > 0 {
            c.rho % m.tickets
        } else {
            0
        };
        m
    };
    let rho_out = result.as_ref().map_or(0, |cl| marginal_for(cl).rho);
    write!(
        o,
        "\"rules\":{{\"supplyCap\":{},\"minRaiseQuote\":\"{}\",\"priceScale\":\"{}\",\"totalSupply\":\"{}\",\"minFloatBps\":{},\"maxFdvX100\":\"{}\",\"anchorPrice\":\"{}\",\"moveBps\":{},\"reserveBps\":[{},{},{}],\"lotteryUnit\":\"{}\",\"rho\":{}}},",
        c.supply_cap.map_or("null".into(), |x| format!("\"{x}\"")),
        c.min_raise_quote,
        c.price_scale,
        c.total_supply,
        c.min_float_bps,
        c.max_fdv_x100,
        c.anchor_price,
        c.move_bps,
        c.policy.reserve_bps[0],
        c.policy.reserve_bps[1],
        c.policy.reserve_bps[2],
        c.policy.lottery_unit,
        rho_out
    )
    .unwrap();
    o.push_str("\"orders\":[");
    for (i, ord) in c.orders.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        write!(
            o,
            "{{\"side\":\"{}\",\"price\":\"{}\",\"quantity\":\"{}\",\"class\":{},\"insider\":{}}}",
            side(ord.side),
            ord.price,
            ord.qty,
            ord.class,
            ord.insider
        )
        .unwrap();
    }
    o.push_str("],\"expect\":");

    match result {
        None => o.push_str("{\"printed\":false,\"noPrintReason\":\"NoCross\"}"),
        Some(cl) => {
            let m = marginal_for(&cl);
            // Declared insiders: quantity strictly better than the clearing price, and at it.
            let better: u128 = c
                .orders
                .iter()
                .filter(|x| x.side == B && x.insider && x.price > cl.price)
                .map(|x| u128::from(x.qty))
                .sum();
            let at: u128 = c
                .orders
                .iter()
                .filter(|x| x.side == B && x.insider && x.price == cl.price)
                .map(|x| u128::from(x.qty))
                .sum();
            let ub = if c.orders.iter().any(|x| x.insider) {
                class0_fill_upper_bound(better, at, &cl, &c.policy, &m)
            } else {
                0
            };
            let counted = cl.matched.saturating_sub(ub);
            let guards = PrintGuards {
                min_matched: u128::from(c.min_matched),
                max_imbalance_bps: c.max_imbalance_bps,
            };
            let raise = RaiseGuards {
                min_raise_quote: u128::from(c.min_raise_quote),
                price_scale: c.price_scale,
                total_supply: u128::from(c.total_supply),
                min_float_bps: c.min_float_bps,
                max_fdv_x100: c.max_fdv_x100,
                anchor_price: c.anchor_price,
                move_bps: c.move_bps,
            };
            match check_all(&guards, &raise, &cl, counted) {
                Err(f) => write!(
                    o,
                    "{{\"printed\":false,\"noPrintReason\":\"{}\",\"wouldClearAt\":\"{}\"}}",
                    reason(f),
                    cl.price
                )
                .unwrap(),
                Ok(()) => {
                    let rationed = cl.rationed.map_or("none", side);
                    write!(
                        o,
                        "{{\"printed\":true,\"price\":\"{}\",\"matched\":\"{}\",\"rationed\":\"{rationed}\",\"insiderUpperBound\":\"{}\",\"fills\":[",
                        cl.price, cl.matched, ub
                    )
                    .unwrap();
                    // Tickets: class-1 orders at a tick are numbered in the order they appear.
                    let mut next: BTreeMap<u64, u32> = BTreeMap::new();
                    for (i, ord) in c.orders.iter().enumerate() {
                        let ticket = if ord.side == B && ord.class == 1 {
                            let t = next.entry(ord.price).or_insert(0);
                            let v = *t;
                            *t += 1;
                            v
                        } else {
                            0
                        };
                        if i > 0 {
                            o.push(',');
                        }
                        write!(
                            o,
                            "\"{}\"",
                            fill_with_policy(
                                ord.side, ord.price, ord.qty, ord.class, ticket, &cl, &c.policy, &m
                            )
                        )
                        .unwrap();
                    }
                    o.push_str("]}");
                }
            }
        }
    }
    o.push('}');
    o
}

fn main() {
    let cases: Vec<Case> = curated().into_iter().chain(random(400)).collect();
    println!("{{");
    println!("  \"schema\": \"opening-cross/conformance/v2\",");
    println!("  \"rule\": \"docs/adr/0101-print-guards-and-supply-cap.md, docs/adr/0104-allocation-classes.md, docs/adr/0106-issuer-neutrality.md\",");
    println!("  \"generator\": \"cargo run -p clearing-core --example conformance_vectors_v2\",");
    println!("  \"units\": \"prices are grid prices in quote atoms per priceScale; quantities and fills in base atoms; all integers are decimal strings; class-1 tickets are numbered per price in order of appearance\",");
    println!("  \"cases\": [");
    for (i, c) in cases.iter().enumerate() {
        println!(
            "    {}{}",
            render(c),
            if i + 1 < cases.len() { "," } else { "" }
        );
    }
    println!("  ]");
    println!("}}");
}
