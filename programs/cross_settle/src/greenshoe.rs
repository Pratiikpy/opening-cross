//! Greenshoe: standing bids under the clearing price, held by the program for a fixed week (ADR-0487, rows D4, VM8, X18).
//!
//! After a launch, the issuer commits a budget (at least 10% of what buyers paid) to Meteora DLMM limit orders that buy the token back
//! below the price the cross discovered: one order at each of 0.90, 0.85 and 0.80 times P*. The orders are owned by a PDA of this
//! program, so the issuer cannot pull them back early, and everything bought is burned when the week ends. Whatever was not spent is
//! returned to the cross's proceeds account.
//!
//! What the program enforces: the pair belongs to the cross, each bid sits in the bin nearest its level and strictly below the active
//! bin, a level is placed once, the amount per level and the amount per period are capped, nothing is placed after the week, and the
//! only exits are cancelling at expiry and returning the unspent budget to `proceeds_to`. What it cannot enforce, and says so: which
//! counterparties sell into the bids (insiders are kept out by their own lockups, not here), and when a keeper chooses to place a level
//! inside the week (the per-period cap bounds how fast).

use super::*;
use anchor_spl::token_interface::{self, Burn, TransferChecked};

pub const GREENSHOE_SEED: &[u8] = b"greenshoe";
pub const GREENSHOE_VAULT_SEED: &[u8] = b"greenshoe_vault";
pub const GREENSHOE_BASE_SEED: &[u8] = b"greenshoe_base";
/// The three bid levels as a share of P*, in basis points.
pub const LEVELS_BPS: [u16; 3] = [9_000, 8_500, 8_000];
/// How long the bids stand.
pub const WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
/// The least budget, as a share of what buyers paid in the cross, in basis points.
pub const MIN_BUDGET_BPS: u64 = 1_000;

/// Byte offsets inside a DLMM `LbPair` account (the IDL's packed layout, checked against the real binary in the tests).
const LB_ACTIVE_ID: usize = 76;
const LB_BIN_STEP: usize = 80;
const LB_STATUS: usize = 82;
const LB_TOKEN_X_MINT: usize = 88;
const LB_TOKEN_Y_MINT: usize = 120;

#[account]
#[derive(InitSpace)]
pub struct Greenshoe {
    pub cross: Pubkey,
    pub creator: Pubkey,
    pub lb_pair: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// P* and its scale, copied from the cross so the bids never depend on a later read.
    pub reference_price: u64,
    pub price_scale: u64,
    pub start_ts: i64,
    pub expires_ts: i64,
    /// Quote committed at creation; nothing can be added and nothing leaves except as bids, refunds at expiry or burns.
    pub budget: u64,
    pub deployed: u64,
    pub period_secs: i64,
    pub period_cap: u64,
    pub period_start: i64,
    pub period_deployed: u64,
    pub orders: [Pubkey; 3],
    pub bins: [i32; 3],
    pub amounts: [u64; 3],
    pub level_settled: [bool; 3],
    pub finished: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub base_bump: u8,
}

impl Greenshoe {
    pub fn placed(&self, level: usize) -> bool {
        self.orders
            .get(level)
            .is_some_and(|o| *o != Pubkey::default())
    }

    /// Rolls the rate-limit period forward and charges `amount` to it, or refuses.
    pub fn charge_period(&mut self, now: i64, amount: u64) -> Result<()> {
        if now
            >= self
                .period_start
                .checked_add(self.period_secs)
                .ok_or(SettleError::Overflow)?
        {
            self.period_start = now;
            self.period_deployed = 0;
        }
        let total = self
            .period_deployed
            .checked_add(amount)
            .ok_or(SettleError::Overflow)?;
        require!(total <= self.period_cap, SettleError::GreenshoeRateLimit);
        self.period_deployed = total;
        Ok(())
    }
}

/// The target price of a level: `floor(P* · bps / 10,000)` in the cross's price units.
pub fn level_price(reference: u64, level: usize) -> Option<u64> {
    let bps = u128::from(*LEVELS_BPS.get(level)?);
    u64::try_from(u128::from(reference).checked_mul(bps)? / 10_000).ok()
}

/// The most one level may hold: a third of the budget, rounded up.
pub fn level_cap(budget: u64) -> u64 {
    budget.div_ceil(3)
}

/// The budget floor for a cross whose buyers paid `buyer_paid`.
pub fn min_budget(buyer_paid: u64) -> Option<u64> {
    u64::try_from(
        u128::from(buyer_paid)
            .checked_mul(u128::from(MIN_BUDGET_BPS))?
            .div_ceil(10_000),
    )
    .ok()
}

fn read_i32(data: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}
fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}
fn read_key(data: &[u8], at: usize) -> Option<Pubkey> {
    Some(Pubkey::new_from_array(
        data.get(at..at + 32)?.try_into().ok()?,
    ))
}

struct Pair {
    active_id: i32,
    bin_step: u16,
}

/// Reads the pair and checks it is a DLMM pair of this cross's two mints that is open for trading.
fn read_pair(info: &AccountInfo, base: &Pubkey, quote: &Pubkey) -> Result<Pair> {
    require_keys_eq!(*info.owner, lb_clmm::ID, SettleError::WrongPair);
    let data = info.try_borrow_data()?;
    require!(
        read_key(&data, LB_TOKEN_X_MINT) == Some(*base)
            && read_key(&data, LB_TOKEN_Y_MINT) == Some(*quote),
        SettleError::WrongPair
    );
    // status 0 = enabled
    require!(data.get(LB_STATUS) == Some(&0), SettleError::WrongPair);
    Ok(Pair {
        active_id: read_i32(&data, LB_ACTIVE_ID).ok_or(SettleError::WrongPair)?,
        bin_step: read_u16(&data, LB_BIN_STEP).ok_or(SettleError::WrongPair)?,
    })
}

// ---------------------------------------------------------------- create

#[derive(Accounts)]
pub struct CreateGreenshoe<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = 8 + Greenshoe::INIT_SPACE, seeds = [GREENSHOE_SEED, cross.key().as_ref()], bump)]
    pub greenshoe: Box<Account<'info, Greenshoe>>,
    #[account(init, payer = creator, seeds = [GREENSHOE_VAULT_SEED, greenshoe.key().as_ref()], bump, token::mint = quote_mint, token::authority = greenshoe, token::token_program = quote_token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = creator, seeds = [GREENSHOE_BASE_SEED, greenshoe.key().as_ref()], bump, token::mint = base_mint, token::authority = greenshoe, token::token_program = base_token_program)]
    pub base_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = quote_mint, token::authority = creator, token::token_program = quote_token_program)]
    pub creator_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the DLMM pair; owner, mints and status are checked in `read_pair`.
    pub lb_pair: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> CreateGreenshoe<'info> {
    #[inline(never)]
    pub fn run(
        &mut self,
        bumps: &CreateGreenshoeBumps,
        budget: u64,
        start_ts: i64,
        period_secs: i64,
        period_cap: u64,
    ) -> Result<()> {
        let cross = read_cross(&self.cross)?;
        require_keys_eq!(cross.creator, self.creator.key(), SettleError::NotCreator);
        require!(
            matches!(cross.state, cross_core::types::CrossState::Finalized),
            SettleError::NotCleared
        );
        let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;
        require_keys_eq!(
            cross.base_mint,
            self.base_mint.key(),
            SettleError::WrongMint
        );
        require_keys_eq!(
            cross.quote_mint,
            self.quote_mint.key(),
            SettleError::WrongMint
        );
        read_pair(&self.lb_pair, &cross.base_mint, &cross.quote_mint)?;
        let now = Clock::get()?.unix_timestamp;
        require!(start_ts >= now, SettleError::GreenshoeWindow);
        require!(
            period_secs >= 60 && period_cap > 0 && period_cap <= budget,
            SettleError::GreenshoeWindow
        );
        require!(
            budget >= min_budget(cross.buyer_paid).ok_or(SettleError::Overflow)? && budget > 0,
            SettleError::GreenshoeBudget
        );

        let g = &mut self.greenshoe;
        g.cross = self.cross.key();
        g.creator = self.creator.key();
        g.lb_pair = self.lb_pair.key();
        g.base_mint = cross.base_mint;
        g.quote_mint = cross.quote_mint;
        g.reference_price = clearing.price;
        g.price_scale = cross.price_scale;
        g.start_ts = start_ts;
        g.expires_ts = start_ts
            .checked_add(WINDOW_SECS)
            .ok_or(SettleError::Overflow)?;
        g.budget = budget;
        g.deployed = 0;
        g.period_secs = period_secs;
        g.period_cap = period_cap;
        g.period_start = start_ts;
        g.period_deployed = 0;
        g.orders = [Pubkey::default(); 3];
        g.bins = [0; 3];
        g.amounts = [0; 3];
        g.level_settled = [false; 3];
        g.finished = false;
        g.bump = bumps.greenshoe;
        g.vault_bump = bumps.vault;
        g.base_bump = bumps.base_account;

        token_interface::transfer_checked(
            CpiContext::new(
                self.quote_token_program.key(),
                TransferChecked {
                    from: self.creator_quote.to_account_info(),
                    mint: self.quote_mint.to_account_info(),
                    to: self.vault.to_account_info(),
                    authority: self.creator.to_account_info(),
                },
            ),
            budget,
            self.quote_mint.decimals,
        )?;
        emit!(GreenshoeCreated {
            cross: g.cross,
            greenshoe: g.key(),
            budget,
            start_ts,
            expires_ts: g.expires_ts
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- deploy a bid

#[derive(Accounts)]
pub struct DeployGreenshoeBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [GREENSHOE_SEED, greenshoe.cross.as_ref()], bump = greenshoe.bump)]
    pub greenshoe: Box<Account<'info, Greenshoe>>,
    #[account(mut, seeds = [GREENSHOE_VAULT_SEED, greenshoe.key().as_ref()], bump = greenshoe.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the DLMM pair; owner, mints and status are checked in `read_pair`, and it must be the pair the greenshoe names.
    #[account(mut, address = greenshoe.lb_pair)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: the pair's bin-array bitmap extension, if it has one; validated by DLMM.
    #[account(mut)]
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,
    /// CHECK: the pair's quote reserve, validated by DLMM.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The new limit-order account; it signs once so DLMM can create it.
    #[account(mut)]
    pub limit_order: Signer<'info>,
    /// CHECK: DLMM's event authority.
    pub dlmm_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DLMM program.
    #[account(address = lb_clmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> DeployGreenshoeBid<'info> {
    /// Anyone may place a level once the week has started. The bin must be the one nearest `level`'s target price and strictly below
    /// the market.
    pub fn run(
        &mut self,
        remaining: &[AccountInfo<'info>],
        level: u8,
        bin_id: i32,
        amount: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let lv = usize::from(level);
        let g = &mut self.greenshoe;
        require!(
            lv < LEVELS_BPS.len() && !g.finished,
            SettleError::GreenshoeLevel
        );
        require!(
            now >= g.start_ts && now < g.expires_ts,
            SettleError::GreenshoeWindow
        );
        require!(!g.placed(lv), SettleError::GreenshoeLevel);
        require_keys_eq!(self.quote_mint.key(), g.quote_mint, SettleError::WrongMint);
        require!(
            amount > 0 && amount <= level_cap(g.budget),
            SettleError::GreenshoeBudget
        );
        let deployed = g
            .deployed
            .checked_add(amount)
            .ok_or(SettleError::Overflow)?;
        require!(deployed <= g.budget, SettleError::GreenshoeBudget);
        g.charge_period(now, amount)?;

        let pair = read_pair(&self.lb_pair, &g.base_mint, &g.quote_mint)?;
        let target = level_price(g.reference_price, lv).ok_or(SettleError::Overflow)?;
        require!(
            bin_contains(bin_id, pair.bin_step, target, g.price_scale)
                .ok_or(SettleError::Overflow)?,
            SettleError::GreenshoeBin
        );
        require!(bin_id < pair.active_id, SettleError::GreenshoeBin);

        g.deployed = deployed;
        g.orders[lv] = self.limit_order.key();
        g.bins[lv] = bin_id;
        g.amounts[lv] = amount;
        let (cross, bump, greenshoe_key) = (g.cross, [g.bump], g.key());
        let seeds: [&[u8]; 3] = [GREENSHOE_SEED, cross.as_ref(), &bump];
        let signer: &[&[&[u8]]] = &[&seeds];
        self.place(signer, remaining, pair.active_id, bin_id, amount)?;
        emit!(GreenshoeBidPlaced {
            greenshoe: greenshoe_key,
            level,
            bin_id,
            amount,
            limit_order: self.limit_order.key()
        });
        Ok(())
    }

    #[inline(never)]
    fn place(
        &self,
        signer: &[&[&[u8]]],
        remaining: &[AccountInfo<'info>],
        active_id: i32,
        bin_id: i32,
        amount: u64,
    ) -> Result<()> {
        // With a relative bin DLMM reads each bin id as an offset from the active bin, and the move of the active bin is bounded to none.
        let offset = bin_id.checked_sub(active_id).ok_or(SettleError::Overflow)?;
        lb_clmm::cpi::place_limit_order(
            CpiContext::new_with_signer(
                self.dlmm_program.key(),
                lb_clmm::cpi::accounts::PlaceLimitOrder {
                    lb_pair: self.lb_pair.to_account_info(),
                    bin_array_bitmap_extension: self
                        .bin_array_bitmap_extension
                        .as_ref()
                        .map(|a| a.to_account_info()),
                    reserve: self.reserve_y.to_account_info(),
                    token_mint: self.quote_mint.to_account_info(),
                    limit_order: self.limit_order.to_account_info(),
                    payer: self.payer.to_account_info(),
                    owner: self.greenshoe.to_account_info(),
                    user_token: self.vault.to_account_info(),
                    sender: self.greenshoe.to_account_info(),
                    token_program: self.quote_token_program.to_account_info(),
                    system_program: self.system_program.to_account_info(),
                    event_authority: self.dlmm_event_authority.to_account_info(),
                    program: self.dlmm_program.to_account_info(),
                },
                signer,
            )
            .with_remaining_accounts(remaining.to_vec()),
            lb_clmm::types::PlaceLimitOrderParams {
                is_ask_side: false,
                padding: [0; 16],
                relative_bin: Some(lb_clmm::types::RelativeBin {
                    active_id,
                    max_active_bin_slippage: 0,
                }),
                bins: vec![lb_clmm::types::BinLimitOrderAmount { id: offset, amount }],
            },
            lb_clmm::types::RemainingAccountsInfo { slices: vec![] },
        )
    }
}

// ---------------------------------------------------------------- settle a level

#[derive(Accounts)]
pub struct SettleGreenshoeLevel<'info> {
    #[account(mut)]
    pub rent_receiver: SystemAccount<'info>,
    #[account(mut, seeds = [GREENSHOE_SEED, greenshoe.cross.as_ref()], bump = greenshoe.bump)]
    pub greenshoe: Box<Account<'info, Greenshoe>>,
    #[account(mut, seeds = [GREENSHOE_VAULT_SEED, greenshoe.key().as_ref()], bump = greenshoe.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [GREENSHOE_BASE_SEED, greenshoe.key().as_ref()], bump = greenshoe.base_bump)]
    pub base_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the pair the greenshoe names.
    #[account(mut, address = greenshoe.lb_pair)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: the pair's bin-array bitmap extension, if it has one; validated by DLMM.
    #[account(mut)]
    pub bin_array_bitmap_extension: Option<UncheckedAccount<'info>>,
    /// CHECK: validated by DLMM.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: validated by DLMM.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    #[account(address = greenshoe.base_mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = greenshoe.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the limit-order account the greenshoe recorded for the level, checked in the handler.
    #[account(mut)]
    pub limit_order: UncheckedAccount<'info>,
    /// CHECK: the SPL memo program DLMM requires.
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: DLMM's event authority.
    pub dlmm_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DLMM program.
    #[account(address = lb_clmm::ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

impl<'info> SettleGreenshoeLevel<'info> {
    /// After the week anyone cancels a placed level: unspent quote returns to the vault, the base the bid bought lands in the greenshoe's
    /// base account, and the limit order is closed with its rent going back to `rent_receiver`. The base-token transfer runs the mint's
    /// transfer hook, whose accounts arrive as remaining accounts with the slice description DLMM asks for.
    pub fn run(
        &mut self,
        level: u8,
        remaining: &[AccountInfo<'info>],
        hook: lb_clmm::types::RemainingAccountsInfo,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let lv = usize::from(level);
        let g = &mut self.greenshoe;
        require!(
            lv < LEVELS_BPS.len() && g.placed(lv) && !g.level_settled[lv],
            SettleError::GreenshoeLevel
        );
        require!(now >= g.expires_ts, SettleError::GreenshoeNotExpired);
        require_keys_eq!(
            self.limit_order.key(),
            g.orders[lv],
            SettleError::GreenshoeLevel
        );
        g.level_settled[lv] = true;
        let (bin, cross, bump, key) = (g.bins[lv], g.cross, [g.bump], g.key());
        let seeds: [&[u8]; 3] = [GREENSHOE_SEED, cross.as_ref(), &bump];
        let signer: &[&[&[u8]]] = &[&seeds];
        self.cancel(signer, bin, remaining, hook)?;
        self.close(signer)?;
        emit!(GreenshoeLevelSettled {
            greenshoe: key,
            level
        });
        Ok(())
    }

    #[inline(never)]
    fn cancel(
        &self,
        signer: &[&[&[u8]]],
        bin: i32,
        remaining: &[AccountInfo<'info>],
        hook: lb_clmm::types::RemainingAccountsInfo,
    ) -> Result<()> {
        lb_clmm::cpi::cancel_limit_order(
            CpiContext::new_with_signer(
                self.dlmm_program.key(),
                lb_clmm::cpi::accounts::CancelLimitOrder {
                    lb_pair: self.lb_pair.to_account_info(),
                    bin_array_bitmap_extension: self
                        .bin_array_bitmap_extension
                        .as_ref()
                        .map(|a| a.to_account_info()),
                    reserve_x: self.reserve_x.to_account_info(),
                    reserve_y: self.reserve_y.to_account_info(),
                    token_x_mint: self.base_mint.to_account_info(),
                    token_y_mint: self.quote_mint.to_account_info(),
                    limit_order: self.limit_order.to_account_info(),
                    owner_token_x: self.base_account.to_account_info(),
                    owner_token_y: self.vault.to_account_info(),
                    owner: self.greenshoe.to_account_info(),
                    token_x_program: self.base_token_program.to_account_info(),
                    token_y_program: self.quote_token_program.to_account_info(),
                    memo_program: self.memo_program.to_account_info(),
                    event_authority: self.dlmm_event_authority.to_account_info(),
                    program: self.dlmm_program.to_account_info(),
                },
                signer,
            )
            .with_remaining_accounts(remaining.to_vec()),
            vec![bin],
            hook,
        )
    }

    #[inline(never)]
    fn close(&self, signer: &[&[&[u8]]]) -> Result<()> {
        lb_clmm::cpi::close_limit_order_if_empty(CpiContext::new_with_signer(
            self.dlmm_program.key(),
            lb_clmm::cpi::accounts::CloseLimitOrderIfEmpty {
                limit_order: self.limit_order.to_account_info(),
                owner: self.greenshoe.to_account_info(),
                rent_receiver: self.rent_receiver.to_account_info(),
                event_authority: self.dlmm_event_authority.to_account_info(),
                program: self.dlmm_program.to_account_info(),
            },
            signer,
        ))
    }
}

// ---------------------------------------------------------------- finish

#[derive(Accounts)]
pub struct FinishGreenshoe<'info> {
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    #[account(mut, seeds = [GREENSHOE_SEED, cross.key().as_ref()], bump = greenshoe.bump, has_one = cross)]
    pub greenshoe: Box<Account<'info, Greenshoe>>,
    #[account(mut, seeds = [GREENSHOE_VAULT_SEED, greenshoe.key().as_ref()], bump = greenshoe.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [GREENSHOE_BASE_SEED, greenshoe.key().as_ref()], bump = greenshoe.base_bump)]
    pub base_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = greenshoe.base_mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = greenshoe.quote_mint)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Receives what the bids did not spend; must belong to the cross's `proceeds_to`.
    #[account(mut, token::mint = quote_mint, token::token_program = quote_token_program)]
    pub proceeds_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

impl<'info> FinishGreenshoe<'info> {
    /// Burns everything the bids bought and returns the unspent budget to the issuer's proceeds. Permissionless once every placed level
    /// is settled (levels never placed need nothing).
    pub fn run(&mut self) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cross = read_cross(&self.cross)?;
        let g = &mut self.greenshoe;
        require!(!g.finished, SettleError::GreenshoeLevel);
        require!(now >= g.expires_ts, SettleError::GreenshoeNotExpired);
        require!(
            (0..3).all(|i| !g.placed(i) || g.level_settled[i]),
            SettleError::GreenshoeLevel
        );
        let proceeds: &TokenAccount = &self.proceeds_quote;
        require_keys_eq!(
            proceeds.owner,
            cross.proceeds_to,
            SettleError::WrongDestination
        );
        g.finished = true;
        let (cross_key, bump, key) = (g.cross, [g.bump], g.key());
        let seeds: [&[u8]; 3] = [GREENSHOE_SEED, cross_key.as_ref(), &bump];
        let signer: &[&[&[u8]]] = &[&seeds];

        self.base_account.reload()?;
        self.vault.reload()?;
        let (bought, unspent) = (self.base_account.amount, self.vault.amount);
        if bought > 0 {
            token_interface::burn(
                CpiContext::new_with_signer(
                    self.base_token_program.key(),
                    Burn {
                        mint: self.base_mint.to_account_info(),
                        from: self.base_account.to_account_info(),
                        authority: self.greenshoe.to_account_info(),
                    },
                    signer,
                ),
                bought,
            )?;
        }
        if unspent > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    self.quote_token_program.key(),
                    TransferChecked {
                        from: self.vault.to_account_info(),
                        mint: self.quote_mint.to_account_info(),
                        to: self.proceeds_quote.to_account_info(),
                        authority: self.greenshoe.to_account_info(),
                    },
                    signer,
                ),
                unspent,
                self.quote_mint.decimals,
            )?;
        }
        emit!(GreenshoeFinished {
            greenshoe: key,
            burned: bought,
            returned: unspent
        });
        Ok(())
    }
}

#[event]
pub struct GreenshoeCreated {
    pub cross: Pubkey,
    pub greenshoe: Pubkey,
    pub budget: u64,
    pub start_ts: i64,
    pub expires_ts: i64,
}
#[event]
pub struct GreenshoeBidPlaced {
    pub greenshoe: Pubkey,
    pub level: u8,
    pub bin_id: i32,
    pub amount: u64,
    pub limit_order: Pubkey,
}
#[event]
pub struct GreenshoeLevelSettled {
    pub greenshoe: Pubkey,
    pub level: u8,
}
#[event]
pub struct GreenshoeFinished {
    pub greenshoe: Pubkey,
    pub burned: u64,
    pub returned: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_fractions_of_the_clearing_price() {
        assert_eq!(level_price(1_000_000, 0), Some(900_000));
        assert_eq!(level_price(1_000_000, 1), Some(850_000));
        assert_eq!(level_price(1_000_000, 2), Some(800_000));
        assert_eq!(level_price(1_000_000, 3), None);
        assert_eq!(
            level_price(u64::MAX, 0),
            Some((u128::from(u64::MAX) * 9_000 / 10_000) as u64)
        );
    }

    #[test]
    fn caps_round_up_and_cover_the_budget() {
        for budget in [1u64, 2, 3, 4, 7, 100, 1_000_000_007, u64::MAX] {
            let cap = level_cap(budget);
            assert!(
                u128::from(cap) * 3 >= u128::from(budget),
                "three levels must be able to hold the budget"
            );
            assert!(cap <= budget);
        }
        assert_eq!(min_budget(1_000_000), Some(100_000));
        assert_eq!(min_budget(1), Some(1));
        assert_eq!(min_budget(0), Some(0));
        assert!(min_budget(u64::MAX).is_some());
    }

    #[test]
    fn the_rate_limit_rolls_and_never_exceeds_its_cap() {
        let mut g = Greenshoe {
            cross: Pubkey::default(),
            creator: Pubkey::default(),
            lb_pair: Pubkey::default(),
            base_mint: Pubkey::default(),
            quote_mint: Pubkey::default(),
            reference_price: 1,
            price_scale: 1,
            start_ts: 0,
            expires_ts: WINDOW_SECS,
            budget: 900,
            deployed: 0,
            period_secs: 100,
            period_cap: 400,
            period_start: 0,
            period_deployed: 0,
            orders: [Pubkey::default(); 3],
            bins: [0; 3],
            amounts: [0; 3],
            level_settled: [false; 3],
            finished: false,
            bump: 0,
            vault_bump: 0,
            base_bump: 0,
        };
        assert!(g.charge_period(10, 300).is_ok());
        assert!(
            g.charge_period(20, 101).is_err(),
            "300 + 101 > 400 in the same period"
        );
        assert!(g.charge_period(20, 100).is_ok());
        assert!(
            g.charge_period(99, 1).is_err(),
            "the period is full until it rolls"
        );
        assert!(
            g.charge_period(100, 400).is_ok(),
            "a new period resets the count"
        );
        assert!(g.charge_period(100, 1).is_err());
        assert!(g.charge_period(i64::MAX, u64::MAX).is_err());
    }
}
