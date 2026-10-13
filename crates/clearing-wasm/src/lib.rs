//! The Opening Cross clearing rule as a WebAssembly module (ADR-0300, PRODUCT_FEATURES V-E).
//!
//! This is `clearing-core`, the crate the program runs on chain, behind a C interface with no dependency on any binding
//! generator: a browser, Node and Python (through any WASM runtime) all call the same compiled rule. Nothing here is a
//! second implementation of the rule; it aggregates orders into price levels exactly as `cross_core::clear` does, calls
//! `clearing_core::clear`, applies the print guards and computes each order's fill with `clearing_core::fill`.
//!
//! The interface is a handful of exports and fixed byte layouts, all little-endian:
//!
//! * `alloc(len) -> ptr` and `dealloc(ptr, len)` hand out and take back linear memory for the caller's buffers.
//! * `preview(...)` clears a book. Orders are `n` records of 24 bytes: side `u8` (0 buy, 1 sell), 7 bytes of padding, price
//!   `u64`, quantity `u64`. The output buffer is `OUT_HEADER + 8n` bytes (see [`OUT_HEADER`]): a 128-byte header, then one
//!   `u64` fill per order, in input order.
//! * `buyer_pays` and `seller_receives` price a fill.
//!
//! Output header: `printed u32 @0`, `reason u32 @4` (0 none, 1 NoCross, 2 BelowMinimumVolume, 3 ImbalanceTooHigh), `price u64 @8`,
//! `matched u128 @16`, `demand u128 @32`, `supply u128 @48`, `rationed u32 @64` (0 none, 1 buy, 2 sell), `marginal_orders u32 @68`,
//! `marginal_quantity u128 @72`, `marginal_remaining u128 @88`.
use clearing_core::{clear, fill, Clearing, Level, NoPrint, OffsetGrid, PrintGuards, Side};

/// Size of the output header in bytes; fills follow it.
pub const OUT_HEADER: usize = 128;
/// Size of one order record in bytes.
pub const ORDER_SIZE: usize = 24;

pub const OK: u32 = 0;
pub const ERR_BAD_GRID: u32 = 1;
pub const ERR_OFF_GRID: u32 = 2;
pub const ERR_BAD_ORDER: u32 = 3;
pub const ERR_BAD_REFERENCE: u32 = 4;

pub const REASON_NONE: u32 = 0;
pub const REASON_NO_CROSS: u32 = 1;
pub const REASON_BELOW_MINIMUM_VOLUME: u32 = 2;
pub const REASON_IMBALANCE_TOO_HIGH: u32 = 3;

/// One order, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub side: Side,
    pub price: u64,
    pub quantity: u64,
}

/// The outcome of a preview.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    pub clearing: Option<Clearing>,
    pub reason: u32,
    pub fills: Vec<u64>,
}

/// Clears `orders` on the grid. Errors are the `ERR_*` codes.
pub fn preview_orders(
    grid: OffsetGrid,
    reference: Option<u64>,
    guards: PrintGuards,
    orders: &[Order],
) -> Result<Preview, u32> {
    if grid.tick == 0 || grid.ticks == 0 {
        return Err(ERR_BAD_GRID);
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
        if o.quantity == 0 {
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
    let dense: Vec<Level> = levels
        .into_iter()
        .filter(|l| l.buy_orders > 0 || l.sell_orders > 0)
        .collect();
    let none = |reason| Preview {
        clearing: None,
        reason,
        fills: vec![0; orders.len()],
    };
    let Some(c) = clear(&dense, reference, &grid).map_err(|_| ERR_BAD_ORDER)? else {
        return Ok(none(REASON_NO_CROSS));
    };
    match guards.check(&c) {
        Err(NoPrint::BelowMinimumVolume) => return Ok(none(REASON_BELOW_MINIMUM_VOLUME)),
        Err(NoPrint::ImbalanceTooHigh) => return Ok(none(REASON_IMBALANCE_TOO_HIGH)),
        Ok(()) => {}
    }
    let fills = orders
        .iter()
        .map(|o| fill(o.side, o.price, o.quantity, &c))
        .collect();
    Ok(Preview {
        clearing: Some(c),
        reason: REASON_NONE,
        fills,
    })
}

fn put_u128(out: &mut [u8], at: usize, v: u128) {
    out[at..at + 16].copy_from_slice(&v.to_le_bytes());
}

/// Writes a preview into the output layout described in the module documentation.
pub fn encode_preview(p: &Preview, out: &mut [u8]) {
    out[..OUT_HEADER].fill(0);
    out[4..8].copy_from_slice(&p.reason.to_le_bytes());
    if let Some(c) = p.clearing {
        out[0..4].copy_from_slice(&1u32.to_le_bytes());
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
    for (i, f) in p.fills.iter().enumerate() {
        let at = OUT_HEADER + i * 8;
        out[at..at + 8].copy_from_slice(&f.to_le_bytes());
    }
}

fn decode_orders(bytes: &[u8]) -> Option<Vec<Order>> {
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
            Some(Order {
                side,
                price: u64::from_le_bytes(r[8..16].try_into().ok()?),
                quantity: u64::from_le_bytes(r[16..24].try_into().ok()?),
            })
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

/// Clears a book. `max_imbalance_bps` of `u32::MAX` disables the imbalance guard. Returns `OK` or an `ERR_*` code; on `OK`
/// the output buffer holds the result.
///
/// # Safety
/// `orders` must point at `n * ORDER_SIZE` readable bytes and `out` at `OUT_HEADER + 8 * n` writable bytes.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn preview(
    min: u64,
    tick: u64,
    ticks: u32,
    has_reference: u32,
    reference: u64,
    min_matched: u64,
    max_imbalance_bps: u32,
    orders: *const u8,
    n: u32,
    out: *mut u8,
) -> u32 {
    let Ok(ticks) = u16::try_from(ticks) else {
        return ERR_BAD_GRID;
    };
    let n = n as usize;
    let Some(orders) = decode_orders(std::slice::from_raw_parts(orders, n * ORDER_SIZE)) else {
        return ERR_BAD_ORDER;
    };
    let guards = PrintGuards {
        min_matched: u128::from(min_matched),
        max_imbalance_bps: (max_imbalance_bps != u32::MAX).then_some(max_imbalance_bps),
    };
    let reference = (has_reference != 0).then_some(reference);
    match preview_orders(OffsetGrid { min, tick, ticks }, reference, guards, &orders) {
        Ok(p) => {
            encode_preview(&p, std::slice::from_raw_parts_mut(out, OUT_HEADER + 8 * n));
            OK
        }
        Err(code) => code,
    }
}

/// Quote atoms a buyer pays for `filled` base atoms, rounded up. Returns `u64::MAX` when the amount does not fit.
#[no_mangle]
pub extern "C" fn buyer_pays(filled: u64, price: u64, price_scale: u64) -> u64 {
    clearing_core::buyer_pays(filled, price, price_scale).unwrap_or(u64::MAX)
}

/// Quote atoms a seller receives for `filled` base atoms, rounded down. Returns `u64::MAX` when the amount does not fit.
#[no_mangle]
pub extern "C" fn seller_receives(filled: u64, price: u64, price_scale: u64) -> u64 {
    clearing_core::seller_receives(filled, price, price_scale).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRID: OffsetGrid = OffsetGrid {
        min: 100,
        tick: 10,
        ticks: 20,
    };
    const NONE: PrintGuards = PrintGuards {
        min_matched: 0,
        max_imbalance_bps: None,
    };
    fn o(side: Side, price: u64, quantity: u64) -> Order {
        Order {
            side,
            price,
            quantity,
        }
    }

    #[test]
    fn matches_the_core_on_a_simple_book() {
        let p = preview_orders(
            GRID,
            None,
            NONE,
            &[o(Side::Buy, 160, 10), o(Side::Sell, 150, 6)],
        )
        .unwrap();
        let c = p.clearing.unwrap();
        // At 150 the 10 of demand strictly above the price would exceed the 6 that can trade, so 150 is not a valid price; at 160 the
        // buyer's 10 is rationed down to the 6 on offer.
        assert_eq!((c.price, c.matched, c.rationed), (160, 6, Some(Side::Buy)));
        assert_eq!(p.fills, vec![6, 6]);
    }

    #[test]
    fn rations_the_long_side_pro_rata() {
        let p = preview_orders(
            GRID,
            None,
            NONE,
            &[
                o(Side::Buy, 150, 5),
                o(Side::Buy, 150, 5),
                o(Side::Sell, 150, 6),
            ],
        )
        .unwrap();
        assert_eq!(p.clearing.unwrap().rationed, Some(Side::Buy));
        assert_eq!(p.fills, vec![3, 3, 6]);
    }

    #[test]
    fn applies_the_guards_and_reports_no_cross() {
        let book = [o(Side::Buy, 150, 10), o(Side::Sell, 150, 4)];
        assert_eq!(
            preview_orders(
                GRID,
                None,
                PrintGuards {
                    min_matched: 5,
                    max_imbalance_bps: None
                },
                &book
            )
            .unwrap()
            .reason,
            REASON_BELOW_MINIMUM_VOLUME
        );
        assert_eq!(
            preview_orders(
                GRID,
                None,
                PrintGuards {
                    min_matched: 0,
                    max_imbalance_bps: Some(5_000)
                },
                &book
            )
            .unwrap()
            .reason,
            REASON_IMBALANCE_TOO_HIGH
        );
        assert_eq!(
            preview_orders(
                GRID,
                None,
                NONE,
                &[o(Side::Buy, 120, 1), o(Side::Sell, 200, 1)]
            )
            .unwrap()
            .reason,
            REASON_NO_CROSS
        );
        assert_eq!(
            preview_orders(GRID, None, NONE, &[]).unwrap().reason,
            REASON_NO_CROSS
        );
    }

    #[test]
    fn refuses_what_the_program_would() {
        assert_eq!(
            preview_orders(GRID, None, NONE, &[o(Side::Buy, 155, 1)]),
            Err(ERR_OFF_GRID)
        );
        assert_eq!(
            preview_orders(GRID, None, NONE, &[o(Side::Buy, 90, 1)]),
            Err(ERR_OFF_GRID)
        );
        assert_eq!(
            preview_orders(GRID, None, NONE, &[o(Side::Buy, 100, 0)]),
            Err(ERR_BAD_ORDER)
        );
        assert_eq!(
            preview_orders(GRID, Some(155), NONE, &[]),
            Err(ERR_BAD_REFERENCE)
        );
        assert_eq!(
            preview_orders(
                OffsetGrid {
                    min: 1,
                    tick: 0,
                    ticks: 5
                },
                None,
                NONE,
                &[]
            ),
            Err(ERR_BAD_GRID)
        );
        assert!(preview_orders(
            OffsetGrid {
                min: 1,
                tick: 1,
                ticks: 300
            },
            None,
            NONE,
            &[]
        )
        .is_ok());
    }

    #[test]
    fn the_c_interface_round_trips() {
        let mut orders = Vec::new();
        for (s, p, q) in [(0u8, 160u64, 10u64), (1, 150, 6)] {
            let mut r = [0u8; ORDER_SIZE];
            r[0] = s;
            r[8..16].copy_from_slice(&p.to_le_bytes());
            r[16..24].copy_from_slice(&q.to_le_bytes());
            orders.extend_from_slice(&r);
        }
        let mut out = vec![0u8; OUT_HEADER + 16];
        let code = unsafe {
            preview(
                100,
                10,
                20,
                0,
                0,
                0,
                u32::MAX,
                orders.as_ptr(),
                2,
                out.as_mut_ptr(),
            )
        };
        assert_eq!(code, OK);
        assert_eq!(u32::from_le_bytes(out[0..4].try_into().unwrap()), 1);
        assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 160);
        assert_eq!(
            u64::from_le_bytes(out[OUT_HEADER..OUT_HEADER + 8].try_into().unwrap()),
            6
        );
        assert_eq!(buyer_pays(3, 150, 100), 5); // ceil(4.5)
        assert_eq!(seller_receives(3, 150, 100), 4); // floor(4.5)
        assert_eq!(buyer_pays(u64::MAX, u64::MAX, 1), u64::MAX);
    }
}
