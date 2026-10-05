//! Oracle divergence guard (ADR-0005 print guards, ROADMAP C3/DP15).
//!
//! Reads a Pyth `PriceUpdateV2` account written by the Pyth Solana Receiver and converts its price
//! into the cross's units. Layout, from `pyth-solana-receiver-sdk` 2.0.0 and `pythnet-sdk` 3.0.0:
//! 8-byte discriminator, `write_authority: Pubkey`, `verification_level` (Borsh enum: `0` =
//! `Partial { num_signatures: u8 }`, `1` = `Full`), then `PriceFeedMessage { feed_id: [u8; 32],
//! price: i64, conf: u64, exponent: i32, publish_time: i64, prev_publish_time: i64,
//! ema_price: i64, ema_conf: u64 }`, then `posted_slot: u64`.
use anchor_lang::prelude::*;

/// Pyth Solana Receiver, pre-upgrade address (mainnet and devnet).
pub const PYTH_RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Pyth Solana Receiver after the 26 Aug 2026 Pyth Core upgrade (docs.pyth.network,
/// "Upgraded Pyth Core contract addresses"); writes the same `PriceUpdateV2` layout.
pub const PYTH_RECEIVER_UPGRADED_ID: Pubkey =
    pubkey!("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");

/// `true` for accounts written by either official Pyth receiver.
pub fn is_pyth_receiver(owner: &Pubkey) -> bool {
    owner == &PYTH_RECEIVER_ID || owner == &PYTH_RECEIVER_UPGRADED_ID
}
/// Anchor discriminator of `PriceUpdateV2` (`sha256("account:PriceUpdateV2")[..8]`).
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OraclePrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub exponent: i32,
    pub publish_time: i64,
    pub fully_verified: bool,
}

/// Parses a `PriceUpdateV2` account body. Returns `None` for anything malformed.
pub fn parse_price_update(data: &[u8]) -> Option<OraclePrice> {
    if data.get(..8)? != PRICE_UPDATE_V2_DISCRIMINATOR {
        return None;
    }
    let mut at = 8 + 32;
    let (fully_verified, level_len) = match *data.get(at)? {
        0 => (false, 2),
        1 => (true, 1),
        _ => return None,
    };
    at += level_len;
    let feed_id: [u8; 32] = data.get(at..at + 32)?.try_into().ok()?;
    at += 32;
    let price = i64::from_le_bytes(data.get(at..at + 8)?.try_into().ok()?);
    at += 8 + 8; // price, conf
    let exponent = i32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?);
    at += 4;
    let publish_time = i64::from_le_bytes(data.get(at..at + 8)?.try_into().ok()?);
    Some(OraclePrice {
        feed_id,
        price,
        exponent,
        publish_time,
        fully_verified,
    })
}

/// Oracle price (whole quote per whole base, `price · 10^exponent`) expressed in the cross's
/// units: quote atoms per `price_scale` base atoms. `None` if non-positive or out of range.
pub fn to_cross_units(
    o: &OraclePrice,
    quote_decimals: u8,
    base_decimals: u8,
    price_scale: u64,
) -> Option<u128> {
    if o.price <= 0 {
        return None;
    }
    // value = price · 10^(exponent + quote_decimals − base_decimals) · price_scale
    let mut num = u128::try_from(o.price)
        .ok()?
        .checked_mul(u128::from(price_scale))?;
    let shift = i64::from(o.exponent) + i64::from(quote_decimals) - i64::from(base_decimals);
    if shift >= 0 {
        num = num.checked_mul(10u128.checked_pow(u32::try_from(shift).ok()?)?)?;
    } else {
        num = num.checked_div(10u128.checked_pow(u32::try_from(-shift).ok()?)?)?;
    }
    (num > 0).then_some(num)
}

/// `true` when `|p − reference| · 10_000 > max_bps · reference`.
pub fn diverges(p: u64, reference: u128, max_bps: u32) -> bool {
    let diff = u128::from(p).abs_diff(reference);
    diff.saturating_mul(10_000) > u128::from(max_bps).saturating_mul(reference)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(level: &[u8], price: i64, expo: i32, t: i64) -> Vec<u8> {
        let mut d = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
        d.extend([9u8; 32]);
        d.extend(level);
        d.extend([7u8; 32]);
        d.extend(price.to_le_bytes());
        d.extend(5u64.to_le_bytes());
        d.extend(expo.to_le_bytes());
        d.extend(t.to_le_bytes());
        d.extend([0u8; 8 * 4]);
        d
    }

    #[test]
    fn parses_both_verification_levels() {
        let full = parse_price_update(&account(&[1], 18_123_000_000, -8, 1_700)).unwrap();
        assert_eq!(
            (
                full.price,
                full.exponent,
                full.publish_time,
                full.fully_verified,
                full.feed_id
            ),
            (18_123_000_000, -8, 1_700, true, [7u8; 32])
        );
        let partial = parse_price_update(&account(&[0, 5], 1, -2, 3)).unwrap();
        assert!(!partial.fully_verified);
        assert_eq!(partial.publish_time, 3);
        assert!(parse_price_update(&account(&[2], 1, 0, 0)).is_none());
        assert!(parse_price_update(&[0u8; 20]).is_none());
    }

    #[test]
    fn converts_to_cross_units() {
        // $181.23 (expo −8), USDC 6 decimals, stock token 8 decimals, scale = 1 whole token.
        let o = OraclePrice {
            feed_id: [0; 32],
            price: 18_123_000_000,
            exponent: -8,
            publish_time: 0,
            fully_verified: true,
        };
        assert_eq!(to_cross_units(&o, 6, 8, 100_000_000), Some(181_230_000));
        assert!(to_cross_units(&OraclePrice { price: 0, ..o }, 6, 8, 1).is_none());
        assert!(diverges(190_000_000, 181_230_000, 300));
        assert!(!diverges(185_000_000, 181_230_000, 300));
    }
}
