//! MetaDAO futarchy adapter (ADR-0657; PRODUCT_FEATURES X3).
//!
//! After a cross clears at P*, the issuer opens a MetaDAO DAO whose spot pool starts at P*, so a market that discovered its price in
//! a call auction is governed from its first minute by MetaDAO's decision markets. Two calls into MetaDAO's `futarchy` program
//! (v0.6, the program on mainnet and devnet), in one instruction:
//!
//! 1. `initialize_dao`, with the caller's parameters passed through untouched except for the one this adapter pins: the first
//!    16 bytes of the parameters are `twap_initial_observation`, which must equal `floor(P* * 10^12 / price_scale)`, MetaDAO's
//!    fixed-point price of one base atom in quote atoms, so the DAO's decision markets start from the price the cross printed.
//! 2. `provide_liquidity` with the creator's deposits, whose ratio must price the base at P* to within one quote atom (the same
//!    rule as the Raydium adapter). The creator owns the LP position.
//!
//! MetaDAO's program accepts only legacy SPL Token mints (and a six-decimal quote), so this adapter serves crosses whose two
//! tokens are legacy tokens, and refuses the others up front with a clear error instead of failing inside MetaDAO.
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

use super::*;

/// MetaDAO's `futarchy` program (the same address on mainnet and devnet).
pub const FUTARCHY_PROGRAM: Pubkey = pubkey!("FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq");
/// `sha256("global:initialize_dao")[..8]`.
const INITIALIZE_DAO: [u8; 8] = [128, 226, 96, 90, 39, 56, 24, 196];
/// `sha256("global:provide_liquidity")[..8]`.
const PROVIDE_LIQUIDITY: [u8; 8] = [40, 110, 107, 116, 174, 127, 97, 204];
/// MetaDAO's `PRICE_SCALE`: a price is quote atoms per base atom times 10^12.
const FUTARCHY_PRICE_SCALE: u128 = 1_000_000_000_000;
/// MetaDAO mints the first liquidity as `quote_amount * 10^9`.
const INITIAL_LIQUIDITY_PER_QUOTE: u128 = 1_000_000_000;

/// MetaDAO's fixed-point price of P*: `floor(P* * 10^12 / price_scale)`.
pub fn dao_price(price: u64, price_scale: u64) -> Option<u128> {
    if price_scale == 0 {
        return None;
    }
    u128::from(price)
        .checked_mul(FUTARCHY_PRICE_SCALE)
        .map(|n| n / u128::from(price_scale))
}

/// The first 16 bytes of the Borsh-encoded `InitializeDaoParams`, which is `twap_initial_observation: u128`.
pub fn twap_initial_observation(params: &[u8]) -> Option<u128> {
    params
        .get(..16)
        .and_then(|b| <[u8; 16]>::try_from(b).ok())
        .map(u128::from_le_bytes)
}

#[derive(Accounts)]
pub struct SeedFutarchyDao<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: the DAO PDA MetaDAO creates (`["dao", creator, nonce]`), validated by MetaDAO.
    #[account(mut)]
    pub dao: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the Squads multisig MetaDAO creates for the DAO, validated by MetaDAO.
    #[account(mut)]
    pub squads_multisig: UncheckedAccount<'info>,
    /// CHECK: the multisig's vault, validated by MetaDAO.
    pub squads_multisig_vault: UncheckedAccount<'info>,
    /// CHECK: the Squads v4 program, validated by MetaDAO.
    pub squads_program: UncheckedAccount<'info>,
    /// CHECK: Squads' program config, validated by MetaDAO.
    pub squads_program_config: UncheckedAccount<'info>,
    /// CHECK: Squads' program-config treasury, validated by MetaDAO.
    #[account(mut)]
    pub squads_program_config_treasury: UncheckedAccount<'info>,
    /// CHECK: the DAO's spending limit PDA, validated by MetaDAO.
    #[account(mut)]
    pub spending_limit: UncheckedAccount<'info>,
    /// CHECK: the DAO's AMM base vault (an associated token account of the DAO), validated by MetaDAO.
    #[account(mut)]
    pub amm_base_vault: UncheckedAccount<'info>,
    /// CHECK: the DAO's AMM quote vault, validated by MetaDAO.
    #[account(mut)]
    pub amm_quote_vault: UncheckedAccount<'info>,
    /// CHECK: the creator's base account; the token program enforces ownership on transfer.
    #[account(mut)]
    pub creator_base: UncheckedAccount<'info>,
    /// CHECK: the creator's quote account; the token program enforces ownership on transfer.
    #[account(mut)]
    pub creator_quote: UncheckedAccount<'info>,
    /// CHECK: the creator's LP position PDA, created by MetaDAO.
    #[account(mut)]
    pub amm_position: UncheckedAccount<'info>,
    /// CHECK: MetaDAO's event authority, validated by MetaDAO.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: MetaDAO's futarchy program.
    #[account(address = FUTARCHY_PROGRAM)]
    pub futarchy_program: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token::ID)]
    pub token_program: Program<'info, anchor_spl::token::Token>,
    /// CHECK: the associated token program, validated by MetaDAO.
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> SeedFutarchyDao<'info> {
    pub fn run(
        &self,
        remaining: &[AccountInfo<'info>],
        params: Vec<u8>,
        base_amount: u64,
        quote_amount: u64,
    ) -> Result<()> {
        graduation::require_approved(
            &self.cross.to_account_info(),
            remaining,
            graduation::Venue::Futarchy,
        )?;
        let cross = read_cross(&self.cross)?;
        require_keys_eq!(cross.creator, self.creator.key(), SettleError::NotCreator);
        require!(cross.base_bound, SettleError::PoolNotOpened);
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
        require!(
            cross.base_token_program == anchor_spl::token::ID
                && cross.quote_token_program == anchor_spl::token::ID,
            SettleError::FutarchyNeedsLegacyTokens
        );
        let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;
        let price = dao_price(clearing.price, cross.price_scale).ok_or(SettleError::Overflow)?;
        require!(
            twap_initial_observation(&params) == Some(price),
            SettleError::StartPriceNotClearingPrice
        );
        require!(
            deposit_matches_price(base_amount, quote_amount, clearing.price, cross.price_scale)
                .ok_or(SettleError::Overflow)?,
            SettleError::StartPriceNotClearingPrice
        );

        let creator = self.creator.key();
        let mut data = INITIALIZE_DAO.to_vec();
        data.extend_from_slice(&params);
        let init = Instruction {
            program_id: FUTARCHY_PROGRAM,
            accounts: vec![
                AccountMeta::new(self.dao.key(), false),
                AccountMeta::new_readonly(creator, true),
                AccountMeta::new(creator, true),
                AccountMeta::new_readonly(self.system_program.key(), false),
                AccountMeta::new_readonly(self.base_mint.key(), false),
                AccountMeta::new_readonly(self.quote_mint.key(), false),
                AccountMeta::new(self.squads_multisig.key(), false),
                AccountMeta::new_readonly(self.squads_multisig_vault.key(), false),
                AccountMeta::new_readonly(self.squads_program.key(), false),
                AccountMeta::new_readonly(self.squads_program_config.key(), false),
                AccountMeta::new(self.squads_program_config_treasury.key(), false),
                AccountMeta::new(self.spending_limit.key(), false),
                AccountMeta::new(self.amm_base_vault.key(), false),
                AccountMeta::new(self.amm_quote_vault.key(), false),
                AccountMeta::new_readonly(self.token_program.key(), false),
                AccountMeta::new_readonly(self.associated_token_program.key(), false),
                AccountMeta::new_readonly(self.event_authority.key(), false),
                AccountMeta::new_readonly(FUTARCHY_PROGRAM, false),
            ],
            data,
        };
        invoke(
            &init,
            &[
                self.dao.to_account_info(),
                self.creator.to_account_info(),
                self.system_program.to_account_info(),
                self.base_mint.to_account_info(),
                self.quote_mint.to_account_info(),
                self.squads_multisig.to_account_info(),
                self.squads_multisig_vault.to_account_info(),
                self.squads_program.to_account_info(),
                self.squads_program_config.to_account_info(),
                self.squads_program_config_treasury.to_account_info(),
                self.spending_limit.to_account_info(),
                self.amm_base_vault.to_account_info(),
                self.amm_quote_vault.to_account_info(),
                self.token_program.to_account_info(),
                self.associated_token_program.to_account_info(),
                self.event_authority.to_account_info(),
                self.futarchy_program.to_account_info(),
            ],
        )?;

        // ProvideLiquidityParams { quote_amount: u64, max_base_amount: u64, min_liquidity: u128, position_authority: Pubkey }
        let min_liquidity = u128::from(quote_amount)
            .checked_mul(INITIAL_LIQUIDITY_PER_QUOTE)
            .ok_or(SettleError::Overflow)?;
        let mut data = PROVIDE_LIQUIDITY.to_vec();
        data.extend_from_slice(&quote_amount.to_le_bytes());
        data.extend_from_slice(&base_amount.to_le_bytes());
        data.extend_from_slice(&min_liquidity.to_le_bytes());
        data.extend_from_slice(creator.as_ref());
        let provide = Instruction {
            program_id: FUTARCHY_PROGRAM,
            accounts: vec![
                AccountMeta::new(self.dao.key(), false),
                AccountMeta::new_readonly(creator, true),
                AccountMeta::new(self.creator_base.key(), false),
                AccountMeta::new(self.creator_quote.key(), false),
                AccountMeta::new(creator, true),
                AccountMeta::new_readonly(self.system_program.key(), false),
                AccountMeta::new(self.amm_base_vault.key(), false),
                AccountMeta::new(self.amm_quote_vault.key(), false),
                AccountMeta::new(self.amm_position.key(), false),
                AccountMeta::new_readonly(self.token_program.key(), false),
                AccountMeta::new_readonly(self.event_authority.key(), false),
                AccountMeta::new_readonly(FUTARCHY_PROGRAM, false),
            ],
            data,
        };
        invoke(
            &provide,
            &[
                self.dao.to_account_info(),
                self.creator.to_account_info(),
                self.creator_base.to_account_info(),
                self.creator_quote.to_account_info(),
                self.system_program.to_account_info(),
                self.amm_base_vault.to_account_info(),
                self.amm_quote_vault.to_account_info(),
                self.amm_position.to_account_info(),
                self.token_program.to_account_info(),
                self.event_authority.to_account_info(),
                self.futarchy_program.to_account_info(),
            ],
        )?;
        emit!(FutarchyDaoSeeded {
            cross: self.cross.key(),
            dao: self.dao.key(),
            clearing_price: clearing.price,
            base_amount,
            quote_amount,
        });
        Ok(())
    }
}

#[event]
pub struct FutarchyDaoSeeded {
    pub cross: Pubkey,
    pub dao: Pubkey,
    pub clearing_price: u64,
    pub base_amount: u64,
    pub quote_amount: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminators_are_the_anchor_ones() {
        assert_eq!(
            INITIALIZE_DAO,
            solana_sha256_hasher::hashv(&[b"global:initialize_dao"]).to_bytes()[..8]
        );
        assert_eq!(
            PROVIDE_LIQUIDITY,
            solana_sha256_hasher::hashv(&[b"global:provide_liquidity"]).to_bytes()[..8]
        );
    }

    #[test]
    fn the_dao_price_is_p_star_in_futarchy_fixed_point() {
        // 1.3 quote per base token, six decimals on both: 1,300,000 per 1,000,000 base atoms is 1.3 atoms per atom.
        assert_eq!(dao_price(1_300_000, 1_000_000), Some(1_300_000_000_000));
        // Floors: 1 / 3.
        assert_eq!(dao_price(1, 3), Some(333_333_333_333));
        assert_eq!(dao_price(5, 0), None);
        assert!(dao_price(u64::MAX, 1).is_some());
    }

    #[test]
    fn the_pinned_field_is_the_first_sixteen_bytes() {
        let mut params = 1_300_000_000_000u128.to_le_bytes().to_vec();
        params.extend_from_slice(&[9; 40]);
        assert_eq!(twap_initial_observation(&params), Some(1_300_000_000_000));
        assert_eq!(twap_initial_observation(&params[..15]), None);
    }
}
