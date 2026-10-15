//! The Opening Cross clearing rule with the v2 rules, as a WebAssembly module (ADR-0970, PRODUCT_FEATURES V-E).
//!
//! `clearing-wasm` (the v1 module) exposes the base rule and the volume and imbalance guards. This module exposes everything a cross
//! applies on chain: a hard supply cap, the minimum-raise, float, valuation and price-move guards, allocation classes with reserved
//! shares and the class-1 lottery, and the exclusion of declared insiders from the minimum raise (ADR-0101, ADR-0104, ADR-0106). It
//! is `clearing-core`, the crate the program runs, behind a C interface: nothing here is a second implementation of the rule. It
//! follows the path of `cross_core::clear` and `claim` exactly as `crates/clearing-core/examples/conformance_vectors_v2.rs` does,
//! and the TypeScript test reproduces all of that file's vectors through this module.
//!
//! All integers are little-endian. `alloc(len) -> ptr` and `dealloc(ptr, len)` hand out and take back linear memory.
//!
//! `preview_v2(min, tick, ticks, has_reference, reference, min_matched, max_imbalance_bps, rules, orders, n, out) -> code`
//!
//! * `rules` points at [`RULES_SIZE`] bytes: `supply_cap_present u32 @0`, `supply_cap u64 @8`, `min_raise_quote u64 @16`,
//!   `price_scale u64 @24`, `total_supply u64 @32`, `min_float_bps u32 @40`, `max_fdv_x100 u64 @48`, `anchor_price u64 @56`,
//!   `move_bps u32 @64`, `reserve_bps` for classes 1, 2 and 3 as three `u16` at `@68`, `@70`, `@72`, `lottery_unit u64 @80`,
//!   `rho u32 @88`.
//! * `orders` is `n` records of [`ORDER_SIZE`] bytes: `side u8 @0` (0 buy, 1 sell), `class u8 @1` (0 to 3; buys only),
//!   `insider u8 @2` (0 or 1; buys only), `price u64 @8`, `quantity u64 @16`.
//! * `out` is `OUT_HEADER + 8n` bytes: a 192-byte header, then one `u64` fill per order in input order. Header: `printed u32 @0`,
//!   `reason u32 @4` (see `REASON_*`), `price u64 @8` (the clearing price, also when a guard suppressed the print), `matched u128 @16`,
//!   `demand u128 @32`, `supply u128 @48`, `rationed u32 @64` (0 none, 1 buy, 2 sell), `marginal_orders u32 @68`,
//!   `marginal_quantity u128 @72`, `marginal_remaining u128 @88`, `insider_upper_bound u128 @104`, `lottery_tickets u32 @120`,
//!   `lottery_rho u32 @124` (the start of the winning window after reduction modulo the tickets, as the program records it).
//!
//! The price fields are written for a book that cleared even when a guard stopped the print, so a caller can say where the cross
//! would have cleared. `printed` is 1 only when every guard passed; fills are zero when it is 0.
use clearing_core::{
    check_all, class0_fill_upper_bound, clear_with, fill_with_policy, AllocPolicy, Clearing, Level, Marginal, OffsetGrid,
    PrintFailure, PrintGuards, RaiseGuards, Side,
};

pub const OUT_HEADER: usize = 192;
pub const ORDER_SIZE: usize = 32;
pub const RULES_SIZE: usize = 96;

pub const OK: u32 = 0;
pub const ERR_BAD_GRID: u32 = 1;
pub const ERR_OFF_GRID: u32 = 2;
pub const ERR_BAD_ORDER: u32 = 3;
pub const ERR_BAD_REFERENCE: u32 = 4;
pub const ERR_BAD_RULES: u32 = 5;

pub const REASON_NONE: u32 = 0;
pub const REASON_NO_CROSS: u32 = 1;
pub const REASON_BELOW_MINIMUM_VOLUME: u32 = 2;
pub const REASON_IMBALANCE_TOO_HIGH: u32 = 3;
pub const REASON_BELOW_MINIMUM_RAISE: u32 = 4;
pub const REASON_FLOAT_TOO_LOW: u32 = 5;
pub const REASON_FDV_TOO_HIGH: u32 = 6;
pub const REASON_PRICE_MOVED: u32 = 7;

/// The v2 rules of a cross.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    pub supply_cap: Option<u64>,
    pub raise: RaiseGuards,
    pub policy: AllocPolicy,
    /// The lottery start as given; reduced modulo the ticket count when applied, as the program does.
    pub rho: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub side: Side,
    pub class: u8,
    pub insider: bool,
    pub price: u64,
    pub quantity: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub clearing: Option<Clearing>,
    pub reason: u32,
    pub printed: bool,
    pub insider_upper_bound: u128,
    pub tickets: u32,
    pub rho: u32,
    pub fills: Vec<u64>,
}

fn reason_of(f: PrintFailure) -> u32 {
    match f {
        PrintFailure::BelowMinimumVolume => REASON_BELOW_MINIMUM_VOLUME,
        PrintFailure::ImbalanceTooHigh => REASON_IMBALANCE_TOO_HIGH,
        PrintFailure::BelowMinimumRaise => REASON_BELOW_MINIMUM_RAISE,
        PrintFailure::FloatTooLow => REASON_FLOAT_TOO_LOW,
        PrintFailure::FdvTooHigh => REASON_FDV_TOO_HIGH,
        PrintFailure::PriceMoved => REASON_PRICE_MOVED,
    }
}

/// Clears `orders` on the grid under the v2 rules. Errors are the `ERR_*` codes.
pub fn preview_v2(
    grid: OffsetGrid,
    reference: Option<u64>,
    guards: PrintGuards,
    rules: &Rules,
    orders: &[Order],
) -> Result<Preview, u32> {
    if grid.tick == 0 || grid.ticks == 0 {
        return Err(ERR_BAD_GRID);
    }
    // A zero price scale would divide the raise by zero, and an allocation policy that reserves more than the whole is not a policy.
    if rules.raise.price_scale == 0 || !rules.policy.is_valid() {
        return Err(ERR_BAD_RULES);
    }
    let ticks = usize::from(grid.ticks);
    let index_of = |price: u64| -> Option<usize> {
        let off = price.checked_sub(grid.min)?;
        if off % grid.tick != 0 {
            return None;
        }
        let i = usize::try_from(off / grid.tick).ok()?;
        (i < ticks).then_some(i)
    };
    if let Some(r) = reference {
        index_of(r).ok_or(ERR_BAD_REFERENCE)?;
    }
    let mut levels = vec![Level::default(); ticks];
    for o in orders {
        // Classes and insider flags belong to buys: the allocation classes divide the marginal buy volume, and insiders are bidders.
        if o.quantity == 0 || o.class > 3 || (o.side == Side::Sell && (o.class != 0 || o.insider)) {
            return Err(ERR_BAD_ORDER);
        }
        let i = index_of(o.price).ok_or(ERR_OFF_GRID)?;
        let l = &mut levels[i];
        l.price = o.price;
        match o.side {
            Side::Buy => {
                l.buy = l.buy.saturating_add(u128::from(o.quantity));
                l.buy_orders = l.buy_orders.saturating_add(1);
            }
            Side::Sell => {
                l.sell = l.sell.saturating_add(u128::from(o.quantity));
                l.sell_orders = l.sell_orders.saturating_add(1);
            }
        }
    }
    // The program hands `clear` only the levels that hold orders, in ascending price.
    let dense: Vec<Level> = levels.into_iter().filter(|l| l.buy_orders > 0 || l.sell_orders > 0).collect();
    let none = |reason| Preview { clearing: None, reason, printed: false, insider_upper_bound: 0, tickets: 0, rho: 0, fills: vec![0; orders.len()] };
    let cap = rules.supply_cap.map(u128::from);
    let Some(c) = clear_with(&dense, reference, &grid, cap).map_err(|_| ERR_BAD_ORDER)? else {
        return Ok(none(REASON_NO_CROSS));
    };

    // The marginal figures the program records at the clearing price, and the lottery start reduced as it reduces it.
    let mut m = Marginal::default();
    for o in orders.iter().filter(|o| o.side == Side::Buy && o.price == c.price) {
        if (1..=3).contains(&o.class) {
            let slot = &mut m.qty[usize::from(o.class) - 1];
            *slot = slot.saturating_add(u128::from(o.quantity));
        }
        if o.class == 1 {
            m.tickets = m.tickets.saturating_add(1);
        }
    }
    m.rho = if rules.policy.lottery_unit > 0 && m.tickets > 0 { rules.rho % m.tickets } else { 0 };

    // Declared insiders: buy quantity strictly better than the clearing price, and at it. Their volume is left out of the minimum raise.
    let (mut better, mut at) = (0u128, 0u128);
    let mut any_insider = false;
    for o in orders.iter().filter(|o| o.side == Side::Buy && o.insider) {
        any_insider = true;
        if o.price > c.price {
            better = better.saturating_add(u128::from(o.quantity));
        } else if o.price == c.price {
            at = at.saturating_add(u128::from(o.quantity));
        }
    }
    let ub = if any_insider { class0_fill_upper_bound(better, at, &c, &rules.policy, &m) } else { 0 };
    let counted = c.matched.saturating_sub(ub);

    if let Err(f) = check_all(&guards, &rules.raise, &c, counted) {
        return Ok(Preview { clearing: Some(c), reason: reason_of(f), printed: false, insider_upper_bound: ub, tickets: m.tickets, rho: m.rho, fills: vec![0; orders.len()] });
    }
    // Class-1 tickets are numbered per price in the order the orders appear.
    let mut next: Vec<(u64, u32)> = Vec::new();
    let fills = orders
        .iter()
        .map(|o| {
            let ticket = if o.side == Side::Buy && o.class == 1 {
                match next.iter_mut().find(|(p, _)| *p == o.price) {
                    Some((_, t)) => {
                        let v = *t;
                        *t = t.saturating_add(1);
                        v
                    }
                    None => {
                        next.push((o.price, 1));
                        0
                    }
                }
            } else {
                0
            };
            fill_with_policy(o.side, o.price, o.quantity, o.class, ticket, &c, &rules.policy, &m)
        })
        .collect();
    Ok(Preview { clearing: Some(c), reason: REASON_NONE, printed: true, insider_upper_bound: ub, tickets: m.tickets, rho: m.rho, fills })
}

fn put_u128(out: &mut [u8], at: usize, v: u128) {
    out[at..at + 16].copy_from_slice(&v.to_le_bytes());
}

/// Writes a preview into the output layout described in the module documentation.
pub fn encode_preview(p: &Preview, out: &mut [u8]) {
    out[..OUT_HEADER].fill(0);
    out[0..4].copy_from_slice(&u32::from(p.printed).to_le_bytes());
    out[4..8].copy_from_slice(&p.reason.to_le_bytes());
    if let Some(c) = p.clearing {
        out[8..16].copy_from_slice(&c.price.to_le_bytes());
        put_u128(out, 16, c.matched);
        put_u128(out, 32, c.demand);
        put_u128(out, 48, c.supply);
        let rationed: u32 = match c.rationed {
            None => 0,
            Some(Side::Buy) => 1,
            Some(Side::Sell) => 2,
        };
        out[64..68].copy_from_slice(&rationed.to_le_bytes());
        out[68..72].copy_from_slice(&c.marginal_orders.to_le_bytes());
        put_u128(out, 72, c.marginal_quantity);
        put_u128(out, 88, c.marginal_remaining);
    }
    put_u128(out, 104, p.insider_upper_bound);
    out[120..124].copy_from_slice(&p.tickets.to_le_bytes());
    out[124..128].copy_from_slice(&p.rho.to_le_bytes());
    for (i, f) in p.fills.iter().enumerate() {
        let at = OUT_HEADER + i * 8;
        out[at..at + 8].copy_from_slice(&f.to_le_bytes());
    }
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(a)
}

pub fn decode_rules(b: &[u8]) -> Option<Rules> {
    if b.len() != RULES_SIZE {
        return None;
    }
    let reserve = |at: usize| u16::from_le_bytes([b[at], b[at + 1]]);
    Some(Rules {
        supply_cap: (u32_at(b, 0) != 0).then(|| u64_at(b, 8)),
        raise: RaiseGuards {
            min_raise_quote: u128::from(u64_at(b, 16)),
            price_scale: u64_at(b, 24),
            total_supply: u128::from(u64_at(b, 32)),
            min_float_bps: u32_at(b, 40),
            max_fdv_x100: u64_at(b, 48),
            anchor_price: u64_at(b, 56),
            move_bps: u32_at(b, 64),
        },
        policy: AllocPolicy { reserve_bps: [reserve(68), reserve(70), reserve(72)], lottery_unit: u64_at(b, 80) },
        rho: u32_at(b, 88),
    })
}

pub fn decode_orders(bytes: &[u8]) -> Option<Vec<Order>> {
    if !bytes.len().is_multiple_of(ORDER_SIZE) {
        return None;
    }
    bytes
        .chunks_exact(ORDER_SIZE)
        .map(|r| {
            let side = match r[0] {
                0 => Side::Buy,
                1 => Side::Sell,
                _ => return None,
            };
            if r[2] > 1 {
                return None;
            }
            Some(Order { side, class: r[1], insider: r[2] == 1, price: u64_at(r, 8), quantity: u64_at(r, 16) })
        })
        .collect()
}

// ------------------------------------------------------------------------------------------------ the C interface

/// Hands out `len` bytes of linear memory. The caller owns them until it returns them with `dealloc`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = vec![0u8; len.max(1)];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Takes back memory from `alloc`.
///
/// # Safety
/// `ptr` and `len` must be exactly what `alloc` returned and was asked for, and not used again.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, len.max(1), len.max(1)));
}

/// Clears a book under the v2 rules. `max_imbalance_bps` of `u32::MAX` disables the imbalance guard. Returns `OK` or an `ERR_*` code;
/// on `OK` the output buffer holds the result.
///
/// # Safety
/// `rules` must point at `RULES_SIZE` readable bytes, `orders` at `n * ORDER_SIZE` readable bytes and `out` at `OUT_HEADER + 8 * n`
/// writable bytes.
#[export_name = "preview_v2"]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn preview_v2_c(
    min: u64,
    tick: u64,
    ticks: u32,
    has_reference: u32,
    reference: u64,
    min_matched: u64,
    max_imbalance_bps: u32,
    rules: *const u8,
    orders: *const u8,
    n: u32,
    out: *mut u8,
) -> u32 {
    let Ok(ticks) = u16::try_from(ticks) else {
        return ERR_BAD_GRID;
    };
    let n = n as usize;
    let Some(rules) = decode_rules(std::slice::from_raw_parts(rules, RULES_SIZE)) else {
        return ERR_BAD_RULES;
    };
    let Some(orders) = decode_orders(std::slice::from_raw_parts(orders, n * ORDER_SIZE)) else {
        return ERR_BAD_ORDER;
    };
    let guards = PrintGuards { min_matched: u128::from(min_matched), max_imbalance_bps: (max_imbalance_bps != u32::MAX).then_some(max_imbalance_bps) };
    let reference = (has_reference != 0).then_some(reference);
    match preview_v2(OffsetGrid { min, tick, ticks }, reference, guards, &rules, &orders) {
        Ok(p) => {
            encode_preview(&p, std::slice::from_raw_parts_mut(out, OUT_HEADER + 8 * n));
            OK
        }
        Err(code) => code,
    }
}

/// Quote atoms a buyer pays for `filled` base atoms at `price`, rounded up; `u64::MAX` when it does not fit.
#[no_mangle]
pub extern "C" fn buyer_pays(filled: u64, price: u64, scale: u64) -> u64 {
    clearing_core::buyer_pays(filled, price, scale).unwrap_or(u64::MAX)
}

/// Quote atoms a seller receives for `filled` base atoms at `price`, rounded down; `u64::MAX` when it does not fit.
#[no_mangle]
pub extern "C" fn seller_receives(filled: u64, price: u64, scale: u64) -> u64 {
    clearing_core::seller_receives(filled, price, scale).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> OffsetGrid {
        OffsetGrid { min: 100, tick: 10, ticks: 20 }
    }
    fn o(side: Side, price: u64, quantity: u64) -> Order {
        Order { side, class: 0, insider: false, price, quantity }
    }
    fn rules() -> Rules {
        Rules { raise: RaiseGuards { price_scale: 1, ..RaiseGuards::default() }, ..Rules::default() }
    }

    #[test]
    fn a_supply_cap_limits_what_the_sell_side_delivers() {
        let book = [o(Side::Sell, 100, 50), o(Side::Sell, 150, 50), o(Side::Sell, 200, 100), o(Side::Buy, 250, 60), o(Side::Buy, 180, 60), o(Side::Buy, 130, 60)];
        let open = preview_v2(grid(), None, PrintGuards::default(), &rules(), &book).unwrap();
        let capped = preview_v2(grid(), None, PrintGuards::default(), &Rules { supply_cap: Some(80), ..rules() }, &book).unwrap();
        assert!(open.printed && capped.printed);
        assert_eq!(open.clearing.unwrap().matched, 100);
        assert_eq!(capped.clearing.unwrap().matched, 80);
        assert_eq!(capped.fills.iter().take(3).sum::<u64>(), 100); // the schedule's own sells still fill; the cap rations the buys
        assert!(capped.fills.iter().skip(3).sum::<u64>() <= 80);
    }

    #[test]
    fn a_guard_that_fails_still_reports_where_the_cross_would_have_cleared() {
        let book = [o(Side::Sell, 100, 100), o(Side::Buy, 200, 100)];
        let r = Rules { raise: RaiseGuards { min_raise_quote: 10_001, price_scale: 1, ..RaiseGuards::default() }, ..Rules::default() };
        let p = preview_v2(grid(), None, PrintGuards::default(), &r, &book).unwrap();
        assert!(!p.printed);
        assert_eq!(p.reason, REASON_BELOW_MINIMUM_RAISE);
        assert_eq!(p.clearing.unwrap().price, 100);
        assert_eq!(p.fills, vec![0, 0]);
    }

    #[test]
    fn refuses_what_the_rule_cannot_apply() {
        let book = [o(Side::Sell, 100, 10), o(Side::Buy, 100, 10)];
        let g = PrintGuards::default();
        assert_eq!(preview_v2(grid(), None, g, &Rules { raise: RaiseGuards::default(), ..Rules::default() }, &book), Err(ERR_BAD_RULES));
        let over = Rules { policy: AllocPolicy { reserve_bps: [6_000, 5_000, 0], lottery_unit: 0 }, ..rules() };
        assert_eq!(preview_v2(grid(), None, g, &over, &book), Err(ERR_BAD_RULES));
        let sell_class = Order { class: 2, ..o(Side::Sell, 100, 10) };
        assert_eq!(preview_v2(grid(), None, g, &rules(), &[sell_class]), Err(ERR_BAD_ORDER));
        let class4 = Order { class: 4, ..o(Side::Buy, 100, 10) };
        assert_eq!(preview_v2(grid(), None, g, &rules(), &[class4]), Err(ERR_BAD_ORDER));
        assert_eq!(preview_v2(grid(), None, g, &rules(), &[o(Side::Buy, 105, 10)]), Err(ERR_OFF_GRID));
        assert_eq!(preview_v2(grid(), Some(105), g, &rules(), &book), Err(ERR_BAD_REFERENCE));
        assert_eq!(preview_v2(OffsetGrid { min: 100, tick: 0, ticks: 20 }, None, g, &rules(), &book), Err(ERR_BAD_GRID));
        assert_eq!(preview_v2(grid(), None, g, &rules(), &[o(Side::Buy, 100, 0)]), Err(ERR_BAD_ORDER));
    }

    #[test]
    fn the_record_layouts_round_trip() {
        let mut b = [0u8; RULES_SIZE];
        b[0..4].copy_from_slice(&1u32.to_le_bytes());
        b[8..16].copy_from_slice(&77u64.to_le_bytes());
        b[24..32].copy_from_slice(&5u64.to_le_bytes());
        b[68..70].copy_from_slice(&1_948u16.to_le_bytes());
        b[72..74].copy_from_slice(&2_863u16.to_le_bytes());
        b[80..88].copy_from_slice(&9u64.to_le_bytes());
        b[88..92].copy_from_slice(&41u32.to_le_bytes());
        let r = decode_rules(&b).unwrap();
        assert_eq!((r.supply_cap, r.raise.price_scale, r.policy.reserve_bps, r.policy.lottery_unit, r.rho), (Some(77), 5, [1_948, 0, 2_863], 9, 41));
        assert!(decode_rules(&b[..RULES_SIZE - 1]).is_none());
        assert!(decode_orders(&[0u8; ORDER_SIZE - 1]).is_none());
        let mut bad = [0u8; ORDER_SIZE];
        bad[2] = 2;
        assert!(decode_orders(&bad).is_none());
    }
}
