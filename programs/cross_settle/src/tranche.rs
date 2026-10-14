//! A fixed-price tranche at the clearing price, through Meteora's Presale Vault (ADR-0663; PRODUCT_FEATURES B4).
//!
//! After a cross prints P*, its creator can offer more of the token to everyone else at exactly P*: a Meteora Presale Vault in fixed-price
//! mode whose price is the price the call auction discovered, not one the creator picks afterwards. The adapter creates the vault with
//! two calls into Meteora's `presale` program, `initialize_fixed_price_presale_args` and `initialize_presale`, and checks the one thing
//! only it can: the vault's `q_price` (quote atoms per base atom as a Q64.64 number) is `floor(P* * 2^64 / price_scale)`. The caps,
//! times, vesting and registries are the creator's, validated by the presale program; the presale program moves the supply from the
//! creator's token account into its vault.
use super::*;

/// `q_price` for P*: quote atoms per base atom, as `floor(P* * 2^64 / price_scale)`.
pub fn q_price(price: u64, price_scale: u64) -> Option<u128> {
    if price_scale == 0 {
        return None;
    }
    (u128::from(price) << 64).checked_div(u128::from(price_scale))
}

/// `presale_mode` value of a fixed-price presale in `presale::types::PresaleArgs`.
pub const FIXED_PRICE_MODE: u8 = 0;

#[derive(Accounts)]
pub struct OpenFixedPricePresale<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// The presale's `base` key: a fresh keypair that signs once, so the presale's address is its own.
    pub base: Signer<'info>,
    pub presale_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_token_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the presale PDA, created and validated by the presale program.
    #[account(mut)]
    pub presale: UncheckedAccount<'info>,
    /// CHECK: the presale's fixed-price parameters PDA, created and validated by the presale program.
    #[account(mut)]
    pub fixed_price_presale_params: UncheckedAccount<'info>,
    /// CHECK: the presale program's authority PDA, validated by the presale program.
    pub presale_authority: UncheckedAccount<'info>,
    /// CHECK: the presale's base vault, created by the presale program.
    #[account(mut)]
    pub presale_vault: UncheckedAccount<'info>,
    /// CHECK: the presale's quote vault, created by the presale program.
    #[account(mut)]
    pub quote_token_vault: UncheckedAccount<'info>,
    /// CHECK: the creator's base account the supply is moved from; the token program enforces ownership.
    #[account(mut)]
    pub payer_presale_token: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// CHECK: the presale program's event authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: the presale program.
    #[account(address = presale::ID)]
    pub presale_program: UncheckedAccount<'info>,
}

impl<'info> OpenFixedPricePresale<'info> {
    pub fn run(
        &self,
        remaining: &'info [AccountInfo<'info>],
        args: Vec<u8>,
        q: u128,
        disable_withdraw: u8,
        hook: Vec<u8>,
    ) -> Result<()> {
        let cross = read_cross(&self.cross)?;
        require_keys_eq!(cross.creator, self.creator.key(), SettleError::NotCreator);
        require!(cross.base_bound, SettleError::PoolNotOpened);
        require_keys_eq!(
            cross.base_mint,
            self.presale_mint.key(),
            SettleError::WrongMint
        );
        require_keys_eq!(
            cross.quote_mint,
            self.quote_token_mint.key(),
            SettleError::WrongMint
        );
        let clearing = cross.clearing.ok_or(SettleError::NotCleared)?;
        require!(
            Some(q) == q_price(clearing.price, cross.price_scale),
            SettleError::StartPriceNotClearingPrice
        );
        let params = decode_args::<presale::types::InitializePresaleArgs>(&args)?;
        let hook = decode_args::<presale::types::RemainingAccountsInfo>(&hook)?;
        require!(
            params.presale_params.presale_mode == FIXED_PRICE_MODE,
            SettleError::PresaleNotFixedPrice
        );

        presale::cpi::initialize_fixed_price_presale_args(
            CpiContext::new(
                self.presale_program.key(),
                presale::cpi::accounts::InitializeFixedPricePresaleArgs {
                    fixed_price_presale_params: self.fixed_price_presale_params.to_account_info(),
                    owner: self.creator.to_account_info(),
                    payer: self.creator.to_account_info(),
                    system_program: self.system_program.to_account_info(),
                    event_authority: self.event_authority.to_account_info(),
                    program: self.presale_program.to_account_info(),
                },
            ),
            presale::types::InitializeFixedPricePresaleExtraArgs {
                presale: self.presale.key(),
                disable_withdraw,
                q_price: q,
                padding1: [0; 8],
            },
        )?;
        // The presale program reads the fixed-price parameters as the first remaining account, then the base token's transfer-hook accounts.
        let mut extra = vec![self.fixed_price_presale_params.to_account_info()];
        extra.extend(remaining.iter().cloned());
        presale::cpi::initialize_presale(
            CpiContext::new(
                self.presale_program.key(),
                presale::cpi::accounts::InitializePresale {
                    presale_mint: self.presale_mint.to_account_info(),
                    presale: self.presale.to_account_info(),
                    presale_authority: self.presale_authority.to_account_info(),
                    quote_token_mint: self.quote_token_mint.to_account_info(),
                    presale_vault: self.presale_vault.to_account_info(),
                    quote_token_vault: self.quote_token_vault.to_account_info(),
                    payer_presale_token: self.payer_presale_token.to_account_info(),
                    creator: self.creator.to_account_info(),
                    base: self.base.to_account_info(),
                    payer: self.creator.to_account_info(),
                    base_token_program: self.base_token_program.to_account_info(),
                    quote_token_program: self.quote_token_program.to_account_info(),
                    system_program: self.system_program.to_account_info(),
                    event_authority: self.event_authority.to_account_info(),
                    program: self.presale_program.to_account_info(),
                },
            )
            .with_remaining_accounts(extra),
            params,
            hook,
        )?;
        emit!(FixedPricePresaleOpened {
            cross: self.cross.key(),
            presale: self.presale.key(),
            clearing_price: clearing.price,
            q_price: q,
        });
        Ok(())
    }
}

#[event]
pub struct FixedPricePresaleOpened {
    pub cross: Pubkey,
    pub presale: Pubkey,
    pub clearing_price: u64,
    pub q_price: u128,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q_price_is_p_star_in_q64() {
        // 1.3 quote per base token with six decimals on both sides: 1.3 atoms per atom.
        assert_eq!(q_price(1_300_000, 1_000_000), Some((13u128 << 64) / 10));
        assert_eq!(q_price(1, 3), Some((1u128 << 64) / 3));
        assert_eq!(q_price(5, 0), None);
        assert_eq!(q_price(u64::MAX, 1), Some(u128::from(u64::MAX) << 64));
    }
}
