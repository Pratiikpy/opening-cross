use anchor_lang::prelude::*;

/// Maximum price ticks per cross. Keeps a book shard at ~6 KB and the clear within one
/// transaction's heap and compute budget.
pub const MAX_TICKS: usize = 256;
/// Maximum book shards per cross.
pub const MAX_SHARDS: u8 = 32;
/// Hard cap on the protocol fee (ADR-0005).
pub const MAX_PROTOCOL_FEE_BPS: u16 = 100;
/// Integrator fee ceiling (PLAN W6).
pub const MAX_INTEGRATOR_FEE_BPS: u16 = 300;
pub const BPS: u64 = 10_000;

pub const PROTOCOL_SEED: &[u8] = b"protocol";
pub const CROSS_SEED: &[u8] = b"cross";
pub const BOOK_SEED: &[u8] = b"book";
pub const SHARD_SEED: &[u8] = b"shard";
pub const ORDER_SEED: &[u8] = b"order";
pub const QUOTE_VAULT_SEED: &[u8] = b"quote_vault";
pub const BASE_VAULT_SEED: &[u8] = b"base_vault";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CrossKind {
    Launch,
    Reopen,
    Tender,
    Recurring,
}

impl CrossKind {
    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum SupplyMode {
    /// Sellers escrow base when they commit.
    Escrow,
    /// The issuer's schedule is fixed at creation and buyers' fills are minted at claim.
    Mint,
    /// Like `Mint`, but the base mint does not exist yet: a settlement adapter creates it after
    /// the clear (e.g. a Meteora DBC pool starting at P*) and binds it (ADR-0006).
    DeferredMint,
}

impl SupplyMode {
    /// Buyers' fills are minted by the cross rather than paid from escrow.
    pub fn mints(self) -> bool {
        matches!(self, SupplyMode::Mint | SupplyMode::DeferredMint)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Disclosure {
    /// Orders are committed as hashes and revealed after the call closes.
    Sealed,
    /// Orders are public from the moment they are placed.
    Open,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CrossState {
    /// Accepting orders (time-gated).
    Live,
    /// Cleared and printed; claims pay fills.
    Cleared,
    /// Did not print; every order is refunded in full.
    NoPrint,
    /// All orders settled and proceeds distributed.
    Finalized,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OrderSide {
    Buy,
    Sell,
}

impl From<OrderSide> for clearing_core::Side {
    fn from(s: OrderSide) -> Self {
        match s {
            OrderSide::Buy => clearing_core::Side::Buy,
            OrderSide::Sell => clearing_core::Side::Sell,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OrderState {
    Committed,
    Revealed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum NoPrintReason {
    NoCross,
    BelowMinimumVolume,
    ImbalanceTooHigh,
    /// Deferred-mint cross whose settlement adapter did not bind a mint before the deadline.
    SettlementExpired,
    /// The clearing price strayed too far from the oracle.
    OracleDivergence,
    /// No fresh, fully verified oracle price was available at the clear.
    OracleUnavailable,
}

/// Pyth price guard: the cross does not print if P* differs from the oracle by more than
/// `max_divergence_bps`, or if no fully verified price newer than `max_staleness_secs` exists.
///
/// The guard pins the Pyth **feed id**, not an account: Pyth's sponsored push accounts for US
/// equities were 24–40 days stale on mainnet (DP15), so the clearing keeper posts a fresh update
/// through the Pyth receiver (pull model) and passes that account. The receiver verifies the
/// Wormhole signatures; the guard accepts only fully verified updates for the pinned feed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct OracleGuard {
    pub feed_id: [u8; 32],
    pub max_divergence_bps: u32,
    pub max_staleness_secs: u32,
}

#[account]
#[derive(InitSpace)]
pub struct Protocol {
    pub admin: Pubkey,
    /// May pause new crosses and orders; can never block claims or refunds.
    pub guardian: Pubkey,
    pub fee_recipient: Pubkey,
    /// Protocol fee in bps of filled notional, indexed by [`CrossKind`].
    pub fee_bps: [u16; 4],
    pub paused: bool,
    pub bump: u8,
}

/// Clearing summary stored on the cross; mirrors `clearing_core::Clearing`.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct ClearingSummary {
    pub price: u64,
    pub matched: u128,
    pub demand: u128,
    pub supply: u128,
    /// 0 = none, 1 = buy, 2 = sell.
    pub rationed: u8,
    pub marginal_quantity: u128,
    pub marginal_remaining: u128,
    pub marginal_orders: u32,
}

impl ClearingSummary {
    pub fn from_core(c: &clearing_core::Clearing) -> Self {
        Self {
            price: c.price,
            matched: c.matched,
            demand: c.demand,
            supply: c.supply,
            rationed: match c.rationed {
                None => 0,
                Some(clearing_core::Side::Buy) => 1,
                Some(clearing_core::Side::Sell) => 2,
            },
            marginal_quantity: c.marginal_quantity,
            marginal_remaining: c.marginal_remaining,
            marginal_orders: c.marginal_orders,
        }
    }

    pub fn to_core(self) -> clearing_core::Clearing {
        clearing_core::Clearing {
            price: self.price,
            matched: self.matched,
            demand: self.demand,
            supply: self.supply,
            rationed: match self.rationed {
                1 => Some(clearing_core::Side::Buy),
                2 => Some(clearing_core::Side::Sell),
                _ => None,
            },
            marginal_quantity: self.marginal_quantity,
            marginal_remaining: self.marginal_remaining,
            marginal_orders: self.marginal_orders,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Cross {
    pub creator: Pubkey,
    pub cross_id: u64,
    pub kind: CrossKind,
    pub supply_mode: SupplyMode,
    pub disclosure: Disclosure,
    pub state: CrossState,

    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_token_program: Pubkey,
    pub quote_token_program: Pubkey,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    /// Receives the issuer's proceeds in mint mode and the dust/bond remainder in all modes.
    pub proceeds_to: Pubkey,

    /// Price grid: `min_price + i * tick` for `i < ticks`. Prices are quote atoms per
    /// `price_scale` base atoms.
    pub min_price: u64,
    pub tick: u64,
    pub ticks: u16,
    pub price_scale: u64,

    pub open_ts: i64,
    pub close_ts: i64,
    pub reveal_end_ts: i64,

    pub reference_price: Option<u64>,
    pub min_matched: u64,
    pub max_imbalance_bps: Option<u32>,

    pub protocol_fee_bps: u16,
    pub integrator_fee_bps: u16,
    pub integrator: Pubkey,
    pub fee_recipient: Pubkey,

    /// When set, only owners holding a `cross_gate` pass for this mint may place orders.
    pub gate_mint: Option<Pubkey>,

    pub shards: u8,
    pub max_orders: u32,
    pub dust_bond: u64,

    pub orders_total: u32,
    pub orders_open: u32,
    pub merged_mask: u32,

    pub clearing: Option<ClearingSummary>,
    pub no_print_reason: Option<NoPrintReason>,

    /// Running settlement totals.
    pub buyer_paid: u64,
    pub base_bought: u64,
    pub base_sold: u64,
    pub seller_paid: u64,
    pub fees_accrued: u64,

    /// Optional oracle divergence guard (reopens of assets with a reference market).
    pub oracle: Option<OracleGuard>,

    /// Deferred-mint crosses: the only signer allowed to bind the base mint, and the deadline
    /// after which anyone may abandon settlement and refund every order.
    pub settler: Option<Pubkey>,
    pub settle_deadline_ts: i64,
    /// False until a deferred-mint cross has its base mint bound.
    pub base_bound: bool,

    pub bump: u8,
    pub quote_vault_bump: u8,
    pub base_vault_bump: u8,
    pub book_bump: u8,
}

impl Cross {
    pub fn max_price(&self) -> Option<u64> {
        u64::from(self.ticks)
            .checked_sub(1)?
            .checked_mul(self.tick)?
            .checked_add(self.min_price)
    }

    /// Tick index of `price`, if the price lies on this cross's grid.
    pub fn tick_index(&self, price: u64) -> Option<usize> {
        let offset = price.checked_sub(self.min_price)?;
        if self.tick == 0 || offset.checked_rem(self.tick)? != 0 {
            return None;
        }
        let i = usize::try_from(offset.checked_div(self.tick)?).ok()?;
        (i < usize::from(self.ticks)).then_some(i)
    }

    pub fn total_fee_bps(&self) -> u16 {
        self.protocol_fee_bps
            .saturating_add(self.integrator_fee_bps)
    }
}

/// Per-tick aggregates. Used both for shards (written by orders) and the merged book.
#[account(zero_copy)]
#[repr(C)]
pub struct Levels {
    pub cross: Pubkey,
    pub buy: [u64; MAX_TICKS],
    pub sell: [u64; MAX_TICKS],
    pub buy_orders: [u32; MAX_TICKS],
    pub sell_orders: [u32; MAX_TICKS],
    pub index: u8,
    pub _pad: [u8; 7],
}

impl Levels {
    pub const SIZE: usize = 8 + core::mem::size_of::<Levels>();

    pub fn add(&mut self, side: OrderSide, tick: usize, quantity: u64) -> Result<()> {
        let (qty, count) = match side {
            OrderSide::Buy => (&mut self.buy, &mut self.buy_orders),
            OrderSide::Sell => (&mut self.sell, &mut self.sell_orders),
        };
        let q = qty.get_mut(tick).ok_or(crate::CrossError::OffGrid)?;
        *q = q.checked_add(quantity).ok_or(crate::CrossError::Overflow)?;
        let c = count.get_mut(tick).ok_or(crate::CrossError::OffGrid)?;
        *c = c.checked_add(1).ok_or(crate::CrossError::Overflow)?;
        Ok(())
    }

    pub fn remove(&mut self, side: OrderSide, tick: usize, quantity: u64) -> Result<()> {
        let (qty, count) = match side {
            OrderSide::Buy => (&mut self.buy, &mut self.buy_orders),
            OrderSide::Sell => (&mut self.sell, &mut self.sell_orders),
        };
        let q = qty.get_mut(tick).ok_or(crate::CrossError::OffGrid)?;
        *q = q.checked_sub(quantity).ok_or(crate::CrossError::Overflow)?;
        let c = count.get_mut(tick).ok_or(crate::CrossError::OffGrid)?;
        *c = c.checked_sub(1).ok_or(crate::CrossError::Overflow)?;
        Ok(())
    }

    pub fn merge_from(&mut self, other: &Levels) -> Result<()> {
        for i in 0..MAX_TICKS {
            self.buy[i] = self.buy[i]
                .checked_add(other.buy[i])
                .ok_or(crate::CrossError::Overflow)?;
            self.sell[i] = self.sell[i]
                .checked_add(other.sell[i])
                .ok_or(crate::CrossError::Overflow)?;
            self.buy_orders[i] = self.buy_orders[i]
                .checked_add(other.buy_orders[i])
                .ok_or(crate::CrossError::Overflow)?;
            self.sell_orders[i] = self.sell_orders[i]
                .checked_add(other.sell_orders[i])
                .ok_or(crate::CrossError::Overflow)?;
        }
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    pub cross: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub index: u32,
    pub side: OrderSide,
    pub state: OrderState,
    /// Sealed crosses: `sha256(cross ‖ owner ‖ nonce ‖ side ‖ price ‖ quantity ‖ salt)`.
    pub commitment: [u8; 32],
    pub price: u64,
    pub quantity: u64,
    /// Quote atoms (buys) or base atoms (sells) held in the vault for this order.
    pub escrow: u64,
    pub bump: u8,
}

/// The cross's price grid for `clearing_core`.
pub struct OffsetGrid {
    pub min: u64,
    pub tick: u64,
    pub ticks: u16,
}

impl clearing_core::TickGrid for OffsetGrid {
    fn next(&self, price: u64) -> Option<u64> {
        if price < self.min {
            return Some(self.min);
        }
        let i = (price.checked_sub(self.min)?)
            .checked_div(self.tick)?
            .checked_add(1)?;
        (i < u64::from(self.ticks))
            .then(|| self.min.checked_add(i.checked_mul(self.tick)?))
            .flatten()
    }

    fn prev(&self, price: u64) -> Option<u64> {
        if price <= self.min {
            return None;
        }
        let offset = price.checked_sub(self.min)?;
        let i = offset.checked_sub(1)?.checked_div(self.tick)?;
        let i = i.min(u64::from(self.ticks).checked_sub(1)?);
        self.min.checked_add(i.checked_mul(self.tick)?)
    }
}
