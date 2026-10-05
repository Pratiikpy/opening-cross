//! Writes the Opening Cross conformance vectors (`opening-cross/conformance/v1`) to stdout.
//!
//! Every expected value is produced by this crate — the code that runs on chain — following the
//! exact path of `cross_core::clear`: orders aggregate into per-price levels, `clear` runs on the
//! cross's `OffsetGrid`, then the print guards apply; fills come from `fill`. The output is
//! committed at `packages/verifier/conformance/v1.json`; CI regenerates it and fails on any
//! difference, and the independent TypeScript implementation must reproduce every case.
//!
//!   cargo run -p clearing-core --example conformance_vectors > packages/verifier/conformance/v1.json
use clearing_core::{clear, fill, Level, NoPrint, OffsetGrid, PrintGuards, Side};
use std::collections::BTreeMap;
use std::fmt::Write;

struct Case {
    name: String,
    min: u64,
    tick: u64,
    ticks: u16,
    reference: Option<u64>,
    min_matched: u64,
    max_imbalance_bps: Option<u32>,
    orders: Vec<(Side, u64, u64)>,
}

fn case(
    name: &str,
    grid: (u64, u64, u16),
    reference: Option<u64>,
    orders: &[(Side, u64, u64)],
) -> Case {
    Case {
        name: name.into(),
        min: grid.0,
        tick: grid.1,
        ticks: grid.2,
        reference,
        min_matched: 0,
        max_imbalance_bps: None,
        orders: orders.to_vec(),
    }
}

use Side::{Buy as B, Sell as S};

fn curated() -> Vec<Case> {
    let g = (100, 10, 20); // prices 100..=290
    let mut v = vec![
        case("empty book does not print", g, None, &[]),
        case(
            "one-sided book does not print",
            g,
            None,
            &[(B, 200, 5), (B, 150, 5)],
        ),
        case(
            "bid below ask does not print",
            g,
            None,
            &[(B, 140, 5), (S, 150, 5)],
        ),
        case(
            "single match at equal limits",
            g,
            None,
            &[(B, 150, 5), (S, 150, 5)],
        ),
        case(
            "wide spread clears at the lowest price of the max-volume range",
            g,
            None,
            &[(B, 200, 5), (S, 120, 5)],
        ),
        case(
            "wide spread with a reference clears nearest the reference",
            g,
            Some(170),
            &[(B, 200, 5), (S, 120, 5)],
        ),
        case(
            "reference below the range clears at the range's low end",
            g,
            Some(100),
            &[(B, 200, 5), (S, 120, 5)],
        ),
        case(
            "reference above the range clears at the range's high end",
            g,
            Some(290),
            &[(B, 200, 5), (S, 120, 5)],
        ),
        case(
            "maximum volume beats minimum imbalance",
            g,
            None,
            &[(B, 200, 10), (B, 150, 10), (S, 140, 15), (S, 190, 5)],
        ),
        case(
            "minimum imbalance breaks a volume tie",
            g,
            None,
            &[(B, 160, 5), (B, 150, 2), (S, 150, 5), (S, 160, 1)],
        ),
        case(
            "excess demand rations marginal buys pro rata, rounding down",
            g,
            None,
            &[(B, 160, 3), (B, 160, 4), (B, 200, 2), (S, 150, 6)],
        ),
        case(
            "excess supply rations marginal sells pro rata, rounding up",
            g,
            None,
            &[(S, 150, 3), (S, 150, 4), (S, 120, 2), (B, 160, 6)],
        ),
        case(
            "interior gap ticks are candidate prices",
            g,
            None,
            &[(B, 250, 5), (S, 110, 5), (B, 120, 1)],
        ),
        case(
            "strictly better orders always fill in full",
            g,
            None,
            &[(B, 290, 4), (B, 200, 10), (S, 100, 4), (S, 200, 10)],
        ),
        case(
            "grid edges: buy at max, sell at min",
            g,
            None,
            &[(B, 290, 7), (S, 100, 7)],
        ),
        case(
            "rounding down can leave 1-atom marginal buys unfilled (dust covered by the bond)",
            g,
            None,
            &[
                (B, 150, 1),
                (B, 150, 1),
                (B, 150, 1),
                (B, 150, 1),
                (B, 150, 1),
                (S, 150, 3),
            ],
        ),
        case(
            "quantities near u64::MAX aggregate without overflow",
            g,
            None,
            &[(B, 200, u64::MAX), (B, 200, u64::MAX), (S, 150, u64::MAX)],
        ),
        case(
            "level totals at the u64 limit the on-chain book can hold",
            g,
            None,
            &[
                (B, 200, u64::MAX / 2),
                (B, 200, u64::MAX / 2),
                (S, 150, u64::MAX / 3),
            ],
        ),
        case(
            "full 256-tick grid with orders at both ends",
            (1_000_000, 1, 256),
            Some(1_000_128),
            &[
                (B, 1_000_255, 9),
                (S, 1_000_000, 4),
                (B, 1_000_128, 3),
                (S, 1_000_200, 5),
            ],
        ),
        case(
            "uneven ratio rounding with prime quantities",
            g,
            None,
            &[(B, 170, 7), (B, 170, 11), (B, 170, 13), (S, 160, 17)],
        ),
    ];
    let mut c = case(
        "below the minimum volume does not print",
        g,
        None,
        &[(B, 150, 5), (S, 150, 5)],
    );
    c.min_matched = 6;
    v.push(c);
    let mut c = case(
        "exactly the minimum volume prints",
        g,
        None,
        &[(B, 150, 5), (S, 150, 5)],
    );
    c.min_matched = 5;
    v.push(c);
    let mut c = case(
        "imbalance above the bound does not print",
        g,
        None,
        &[(B, 150, 10), (S, 150, 4)],
    );
    c.max_imbalance_bps = Some(14_999); // imbalance 6 / matched 4 = 15000 bps
    v.push(c);
    let mut c = case(
        "imbalance exactly at the bound prints",
        g,
        None,
        &[(B, 150, 10), (S, 150, 4)],
    );
    c.max_imbalance_bps = Some(15_000);
    v.push(c);
    let fine = (1_000_000, 1, 2000);
    v.push(case(
        "fine grid with a large book",
        fine,
        Some(1_000_900),
        &[
            (B, 1_001_999, 50),
            (B, 1_000_500, 70),
            (S, 1_000_000, 40),
            (S, 1_000_700, 60),
            (B, 1_000_900, 33),
            (S, 1_000_900, 21),
        ],
    ));
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
    let mut r = Rng(0x0C05_5C05_5C05_5C05);
    (0..count)
        .map(|i| {
            let ticks = 1 + r.below(40) as u16;
            let tick = 1 + r.below(1000);
            let min = r.below(1_000_000);
            let n = r.below(30) as usize;
            let mut orders = Vec::with_capacity(n);
            for _ in 0..n {
                let side = if r.below(2) == 0 { B } else { S };
                let price = min + r.below(u64::from(ticks)) * tick;
                let q = if r.below(10) == 0 {
                    1 + r.below(u64::MAX / 64)
                } else {
                    1 + r.below(1_000)
                };
                orders.push((side, price, q));
            }
            let reference = (r.below(2) == 0).then(|| min + r.below(u64::from(ticks)) * tick);
            let mut c = case(
                &format!("random #{i}"),
                (min, tick, ticks),
                reference,
                &orders,
            );
            if r.below(4) == 0 {
                c.min_matched = r.below(2_000);
            }
            if r.below(4) == 0 {
                c.max_imbalance_bps = Some(r.below(20_000) as u32);
            }
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

fn render(c: &Case) -> String {
    let mut levels: BTreeMap<u64, Level> = BTreeMap::new();
    for &(s, p, q) in &c.orders {
        let l = levels.entry(p).or_insert(Level {
            price: p,
            ..Level::default()
        });
        match s {
            B => {
                l.buy += u128::from(q);
                l.buy_orders += 1;
            }
            S => {
                l.sell += u128::from(q);
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
    let result = clear(&levels, c.reference, &grid).expect("aggregated levels are well formed");
    let guards = PrintGuards {
        min_matched: u128::from(c.min_matched),
        max_imbalance_bps: c.max_imbalance_bps,
    };

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
    o.push_str("\"orders\":[");
    for (i, &(s, p, q)) in c.orders.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        write!(
            o,
            "{{\"side\":\"{}\",\"price\":\"{p}\",\"quantity\":\"{q}\"}}",
            side(s)
        )
        .unwrap();
    }
    o.push_str("],\"expect\":");
    match result {
        None => o.push_str("{\"printed\":false,\"noPrintReason\":\"NoCross\"}"),
        Some(cl) => {
            match guards.check(&cl) {
                Err(e) => {
                    let reason = match e {
                        NoPrint::BelowMinimumVolume => "BelowMinimumVolume",
                        NoPrint::ImbalanceTooHigh => "ImbalanceTooHigh",
                    };
                    write!(o, "{{\"printed\":false,\"noPrintReason\":\"{reason}\",\"wouldClearAt\":\"{}\"}}", cl.price).unwrap();
                }
                Ok(()) => {
                    let rationed = cl.rationed.map_or("none", side);
                    write!(o, "{{\"printed\":true,\"price\":\"{}\",\"matched\":\"{}\",\"rationed\":\"{rationed}\",\"fills\":[", cl.price, cl.matched).unwrap();
                    for (i, &(s, p, q)) in c.orders.iter().enumerate() {
                        if i > 0 {
                            o.push(',');
                        }
                        write!(o, "\"{}\"", fill(s, p, q, &cl)).unwrap();
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
    let cases: Vec<Case> = curated().into_iter().chain(random(500)).collect();
    println!("{{");
    println!("  \"schema\": \"opening-cross/conformance/v1\",");
    println!("  \"rule\": \"docs/adr/0003-clearing-rule.md\",");
    println!("  \"generator\": \"cargo run -p clearing-core --example conformance_vectors\",");
    println!("  \"units\": \"prices are grid prices in quote atoms per priceScale; quantities and fills in base atoms; all integers are decimal strings\",");
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
