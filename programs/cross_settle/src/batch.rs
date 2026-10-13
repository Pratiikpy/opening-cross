//! Batch-opened DAMM v2 pools (ADR-0483, rows F4 and W10).
//!
//! A pool the adapter opens can be made to stay closed while the market clears as a series of short crosses:
//! DAMM v2 refuses every swap before the pool's activation point, and the pool is opened at exactly the price
//! the cross discovered. `check_batched_pool` is what the program insists on before it lets such a pool be seeded.
//!
//! DAMM v2's own `BorshFeeTimeScheduler` layout (the 27 bytes of `BaseFeeParameters.data`, `programs/cp-amm`):
//! `cliff_fee_numerator: u64`, `number_of_period: u16`, `period_frequency: u64`, `reduction_factor: u64`,
//! `base_fee_mode: u8` at offset 26.

use super::*;
use cp_amm::types::InitializeCustomizablePoolParameters;

/// DAMM v2 `ActivationType::Timestamp` (`Slot` is 0).
pub const ACTIVATION_TYPE_TIMESTAMP: u8 = 1;
/// DAMM v2 `CollectFeeMode::Compounding`.
pub const COLLECT_FEE_MODE_COMPOUNDING: u8 = 2;
/// `BaseFeeMode::FeeTimeSchedulerLinear` and `FeeTimeSchedulerExponential`.
const TIME_SCHEDULER_MODES: [u8; 2] = [0, 1];
/// The shortest and longest window the program accepts: a batch needs time to run, and a pool nobody can trade for
/// a week is a lock-up, not a batch.
pub const MIN_WINDOW_SECS: i64 = 30;
pub const MAX_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

/// The fee schedule fields the program reads, or `None` when the bytes are not a decaying time scheduler.
pub fn decaying_time_schedule(data: &[u8; 27]) -> Option<(u64, u16, u64, u64)> {
    let cliff = u64::from_le_bytes(data[0..8].try_into().ok()?);
    let periods = u16::from_le_bytes(data[8..10].try_into().ok()?);
    let frequency = u64::from_le_bytes(data[10..18].try_into().ok()?);
    let reduction = u64::from_le_bytes(data[18..26].try_into().ok()?);
    let mode = data[26];
    (TIME_SCHEDULER_MODES.contains(&mode)
        && cliff > 0
        && periods > 0
        && frequency > 0
        && reduction > 0)
        .then_some((cliff, periods, frequency, reduction))
}

/// Refuses a pool that is not batch-opened. Pure apart from its inputs, so it is unit-tested below.
pub fn check_batched_pool(
    params: &InitializeCustomizablePoolParameters,
    now: i64,
    window_secs: i64,
) -> Result<()> {
    require!(
        (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs),
        SettleError::BatchWindow
    );
    require!(
        params.activation_type == ACTIVATION_TYPE_TIMESTAMP,
        SettleError::BatchActivation
    );
    let start = params
        .activation_point
        .ok_or(SettleError::BatchActivation)?;
    let earliest = u64::try_from(now.checked_add(window_secs).ok_or(SettleError::Overflow)?)
        .map_err(|_| SettleError::Overflow)?;
    require!(start >= earliest, SettleError::BatchActivation);
    require!(
        params.collect_fee_mode == COLLECT_FEE_MODE_COMPOUNDING
            && params.pool_fees.compounding_fee_bps > 0
            && params.pool_fees.compounding_fee_bps <= 10_000,
        SettleError::BatchNotCompounding
    );
    require!(
        decaying_time_schedule(&params.pool_fees.base_fee.data).is_some(),
        SettleError::BatchFeeNotDecaying
    );
    Ok(())
}

/// DLMM `ActivationType::Timestamp` (`Slot` is 0).
pub const DLMM_ACTIVATION_TYPE_TIMESTAMP: u8 = 1;

/// Refuses a DLMM pair that can trade before the window ends. DLMM keeps the start in the pair, and only
/// Meteora's admin or the pair creator (when `creator_pool_on_off_control` is set) can change status afterwards.
pub fn check_batched_pair(
    params: &lb_clmm::types::CustomizableParams,
    now: i64,
    window_secs: i64,
) -> Result<()> {
    require!(
        (MIN_WINDOW_SECS..=MAX_WINDOW_SECS).contains(&window_secs),
        SettleError::BatchWindow
    );
    require!(
        params.activation_type == DLMM_ACTIVATION_TYPE_TIMESTAMP,
        SettleError::BatchActivation
    );
    let start = params
        .activation_point
        .ok_or(SettleError::BatchActivation)?;
    let earliest = u64::try_from(now.checked_add(window_secs).ok_or(SettleError::Overflow)?)
        .map_err(|_| SettleError::Overflow)?;
    require!(start >= earliest, SettleError::BatchActivation);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cp_amm::types::{BaseFeeParameters, PoolFeeParameters};

    #[test]
    fn dlmm_pairs_need_a_timestamp_start_beyond_the_window() {
        let pair = |ty: u8, at: Option<u64>| lb_clmm::types::CustomizableParams {
            active_id: 0,
            bin_step: 10,
            base_factor: 10_000,
            activation_type: ty,
            has_alpha_vault: false,
            activation_point: at,
            creator_pool_on_off_control: true,
            base_fee_power_factor: 0,
            concrete_function_type: 0,
            collect_fee_mode: 0,
            padding: [0; 60],
        };
        assert!(check_batched_pair(&pair(1, Some(1_300)), 1_000, 300).is_ok());
        assert!(check_batched_pair(&pair(1, Some(1_299)), 1_000, 300).is_err());
        assert!(check_batched_pair(&pair(0, Some(5_000)), 1_000, 300).is_err());
        assert!(check_batched_pair(&pair(1, None), 1_000, 300).is_err());
        assert!(check_batched_pair(&pair(1, Some(5_000)), 1_000, 29).is_err());
        assert!(check_batched_pair(&pair(1, Some(u64::MAX)), i64::MAX, 300).is_err());
    }

    fn fee(cliff: u64, periods: u16, frequency: u64, reduction: u64, mode: u8) -> [u8; 27] {
        let mut d = [0u8; 27];
        d[0..8].copy_from_slice(&cliff.to_le_bytes());
        d[8..10].copy_from_slice(&periods.to_le_bytes());
        d[10..18].copy_from_slice(&frequency.to_le_bytes());
        d[18..26].copy_from_slice(&reduction.to_le_bytes());
        d[26] = mode;
        d
    }

    fn good(start: u64) -> InitializeCustomizablePoolParameters {
        InitializeCustomizablePoolParameters {
            pool_fees: PoolFeeParameters {
                base_fee: BaseFeeParameters {
                    data: fee(10_000_000, 10, 60, 500_000, 0),
                },
                compounding_fee_bps: 5_000,
                padding: 0,
                dynamic_fee: None,
            },
            sqrt_min_price: 0,
            sqrt_max_price: 0,
            has_alpha_vault: false,
            liquidity: 1,
            sqrt_price: 1,
            activation_type: ACTIVATION_TYPE_TIMESTAMP,
            collect_fee_mode: COLLECT_FEE_MODE_COMPOUNDING,
            activation_point: Some(start),
        }
    }

    #[test]
    fn accepts_a_batched_pool_exactly_at_the_window() {
        assert!(check_batched_pool(&good(1_000 + 300), 1_000, 300).is_ok());
        assert!(check_batched_pool(&good(1_000 + 301), 1_000, 300).is_ok());
    }

    #[test]
    fn refuses_each_departure() {
        // opens before the window ends, or has no start, or counts slots
        assert!(check_batched_pool(&good(1_000 + 299), 1_000, 300).is_err());
        let mut p = good(2_000);
        p.activation_point = None;
        assert!(check_batched_pool(&p, 1_000, 300).is_err());
        let mut p = good(2_000);
        p.activation_type = 0;
        assert!(check_batched_pool(&p, 1_000, 300).is_err());
        // window out of range
        assert!(check_batched_pool(&good(2_000), 1_000, MIN_WINDOW_SECS - 1).is_err());
        assert!(check_batched_pool(&good(10_000_000), 1_000, MAX_WINDOW_SECS + 1).is_err());
        // not compounding, or a compounding mode with no compounding share
        let mut p = good(2_000);
        p.collect_fee_mode = 0;
        assert!(check_batched_pool(&p, 1_000, 300).is_err());
        let mut p = good(2_000);
        p.pool_fees.compounding_fee_bps = 0;
        assert!(check_batched_pool(&p, 1_000, 300).is_err());
        let mut p = good(2_000);
        p.pool_fees.compounding_fee_bps = 10_001;
        assert!(check_batched_pool(&p, 1_000, 300).is_err());
        // a flat fee, a fee that never steps, or a scheduler driven by price rather than time
        for data in [
            fee(10_000_000, 0, 60, 500_000, 0),
            fee(10_000_000, 10, 0, 500_000, 0),
            fee(10_000_000, 10, 60, 0, 0),
            fee(0, 10, 60, 500_000, 0),
            fee(10_000_000, 10, 60, 500_000, 3),
            fee(10_000_000, 10, 60, 500_000, 2),
        ] {
            let mut p = good(2_000);
            p.pool_fees.base_fee = BaseFeeParameters { data };
            assert!(check_batched_pool(&p, 1_000, 300).is_err());
        }
        // the exponential time scheduler is accepted
        let mut p = good(2_000);
        p.pool_fees.base_fee = BaseFeeParameters {
            data: fee(10_000_000, 10, 60, 500, 1),
        };
        assert!(check_batched_pool(&p, 1_000, 300).is_ok());
    }

    #[test]
    fn overflowing_times_are_refused_not_wrapped() {
        assert!(check_batched_pool(&good(u64::MAX), i64::MAX, 300).is_err());
        assert!(check_batched_pool(&good(1), -1_000, 300).is_err());
    }
}
