//! The fair-launch continuation design the program can enforce on a DBC config (ADR-0482).
//!
//! `open_dbc_pool` accepts any config whose start price is P*. `open_dbc_pool_locked` additionally refuses
//! every config that leaves the opening liquidity withdrawable or turns the migrated market into a plain
//! pool: PRODUCT_FEATURES [D3] asks for a migration into a compounding DAMM v2 pool whose liquidity is
//! locked or vests, and the program is the only party that can promise that to buyers.
//!
//! DBC splits the migration liquidity four ways between the partner (this adapter's settler PDA) and the
//! pool creator (the issuer): `*_liquidity_percentage` is unlocked and withdrawable at once,
//! `*_permanent_locked_liquidity_percentage` is locked for good, and the vesting percentage vests on a
//! schedule. The four numbers (plus the partner and creator vesting percentages) sum to 100.

use super::*;
use dynamic_bonding_curve::types::ConfigParameters;

/// DBC `MigrationOption::MET_DAMM_V2`.
pub const MIGRATION_OPTION_DAMM_V2: u8 = 1;
/// DBC `MigratedCollectFeeMode::Compounding` (DAMM v2 collect-fee mode 2).
pub const COLLECT_FEE_MODE_COMPOUNDING: u8 = 2;
/// At least this share of the migration liquidity is locked forever (PRODUCT_FEATURES [D1]: about 20%).
pub const MIN_PERMANENT_LOCK_PCT: u8 = 20;

/// Refuses a config that is not the locked, compounding design. Pure, so it is unit-tested below.
pub fn check_locked_design(c: &ConfigParameters) -> Result<()> {
    require!(
        c.migration_option == MIGRATION_OPTION_DAMM_V2,
        SettleError::DesignMigration
    );
    require!(
        c.migrated_pool_fee.collect_fee_mode == COLLECT_FEE_MODE_COMPOUNDING
            && c.compounding_fee_bps > 0
            && c.compounding_fee_bps <= 10_000,
        SettleError::DesignNotCompounding
    );
    // No liquidity may be withdrawable the moment the pool migrates.
    require!(
        c.partner_liquidity_percentage == 0 && c.creator_liquidity_percentage == 0,
        SettleError::DesignUnlockedLiquidity
    );
    // The partner side belongs to the settler PDA, which has no instruction that vests or withdraws:
    // partner liquidity may only be locked permanently (its fees are claimed by `claim_pol_fees`).
    require!(
        c.partner_liquidity_vesting_info.vesting_percentage == 0,
        SettleError::DesignPartnerVesting
    );
    let locked = u16::from(c.partner_permanent_locked_liquidity_percentage)
        + u16::from(c.creator_permanent_locked_liquidity_percentage);
    require!(
        locked >= u16::from(MIN_PERMANENT_LOCK_PCT),
        SettleError::DesignLockTooLow
    );
    // Whatever is not locked for good must vest on a schedule with at least one period.
    let creator_vesting = &c.creator_liquidity_vesting_info;
    if creator_vesting.vesting_percentage > 0 {
        require!(
            creator_vesting.number_of_periods > 0 && creator_vesting.bps_per_period > 0,
            SettleError::DesignUnlockedLiquidity
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use dynamic_bonding_curve::types::{
        ConfigParameters, LiquidityVestingInfoParams, MigratedPoolFee,
    };

    fn good() -> ConfigParameters {
        let mut c = ConfigParameters {
            migration_option: MIGRATION_OPTION_DAMM_V2,
            compounding_fee_bps: 5_000,
            partner_permanent_locked_liquidity_percentage: 30,
            creator_permanent_locked_liquidity_percentage: 10,
            ..Default::default()
        };
        c.migrated_pool_fee = MigratedPoolFee {
            collect_fee_mode: COLLECT_FEE_MODE_COMPOUNDING,
            ..Default::default()
        };
        c.creator_liquidity_vesting_info = LiquidityVestingInfoParams {
            vesting_percentage: 60,
            bps_per_period: 2_500,
            number_of_periods: 4,
            cliff_duration_from_migration_time: 0,
            frequency: 86_400,
        };
        c
    }

    #[test]
    fn accepts_the_designed_config() {
        assert!(check_locked_design(&good()).is_ok());
    }

    #[test]
    fn refuses_each_departure_from_the_design() {
        let mut c = good();
        c.migration_option = 0;
        assert!(check_locked_design(&c).is_err(), "DAMM v1");

        let mut c = good();
        c.migrated_pool_fee.collect_fee_mode = 0;
        assert!(check_locked_design(&c).is_err(), "not compounding");

        let mut c = good();
        c.compounding_fee_bps = 0;
        assert!(
            check_locked_design(&c).is_err(),
            "compounding with no compounding fee"
        );

        let mut c = good();
        c.compounding_fee_bps = 10_001;
        assert!(
            check_locked_design(&c).is_err(),
            "compounding fee above 100%"
        );

        let mut c = good();
        c.creator_liquidity_percentage = 5;
        assert!(
            check_locked_design(&c).is_err(),
            "creator liquidity unlocked"
        );

        let mut c = good();
        c.partner_liquidity_percentage = 1;
        assert!(
            check_locked_design(&c).is_err(),
            "partner liquidity unlocked"
        );

        let mut c = good();
        c.partner_liquidity_vesting_info.vesting_percentage = 10;
        assert!(check_locked_design(&c).is_err(), "settler cannot vest");

        let mut c = good();
        c.partner_permanent_locked_liquidity_percentage = 10;
        c.creator_permanent_locked_liquidity_percentage = 9;
        assert!(check_locked_design(&c).is_err(), "locked below 20%");

        let mut c = good();
        c.creator_liquidity_vesting_info.number_of_periods = 0;
        assert!(check_locked_design(&c).is_err(), "vesting with no periods");
    }

    #[test]
    fn the_lock_floor_is_inclusive() {
        let mut c = good();
        c.partner_permanent_locked_liquidity_percentage = 10;
        c.creator_permanent_locked_liquidity_percentage = 10;
        assert!(check_locked_design(&c).is_ok());
        c.creator_permanent_locked_liquidity_percentage = 9;
        assert!(check_locked_design(&c).is_err());
    }
}
