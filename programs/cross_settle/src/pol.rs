//! Fees earned by the protocol-owned liquidity a DBC migration leaves with the settler (ADR-0482).
//!
//! DBC migrates a curve into a DAMM v2 pool and mints up to two positions: the creator's, held by the
//! issuer's wallet (the issuer claims its fees with Meteora's own instruction), and the partner's, held by
//! this adapter's settler PDA. The partner's liquidity is locked permanently, so only its fees can ever
//! move, and only the settler can claim them. `claim_pol_fees` does that for anyone, to accounts owned by
//! the cross's `proceeds_to`: the liquidity came out of the issuer's raise, so its fees are the issuer's.

use super::*;

#[derive(Accounts)]
pub struct ClaimPolFees<'info> {
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: this adapter's settler PDA; it owns the partner position's NFT and signs the claim.
    #[account(seeds = [SETTLER_SEED, cross.key().as_ref()], bump)]
    pub settler: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's constant pool-authority PDA, validated by DAMM v2.
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 pool, validated by DAMM v2 against the mints below.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 position, validated by DAMM v2 against the pool and the NFT account.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// Receives the pool's token-A fees; must belong to the cross's `proceeds_to`.
    #[account(mut)]
    pub token_a_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Receives the pool's token-B fees; must belong to the cross's `proceeds_to`.
    #[account(mut)]
    pub token_b_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DAMM v2 vault PDA, validated by DAMM v2.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 vault PDA, validated by DAMM v2.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    pub token_a_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_b_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the position's NFT token account; DAMM v2 requires the settler to own it.
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority, validated by DAMM v2.
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DAMM v2 program.
    #[account(address = cp_amm::ID)]
    pub damm_program: UncheckedAccount<'info>,
    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,
}

impl<'info> ClaimPolFees<'info> {
    pub fn run(&mut self, settler_bump: u8) -> Result<()> {
        let recipient = self.check()?;
        let before = (
            self.token_a_destination.amount,
            self.token_b_destination.amount,
        );
        self.claim(settler_bump)?;
        self.token_a_destination.reload()?;
        self.token_b_destination.reload()?;
        emit!(PolFeesClaimed {
            cross: self.cross.key(),
            pool: self.pool.key(),
            position: self.position.key(),
            token_a: self.token_a_destination.amount.saturating_sub(before.0),
            token_b: self.token_b_destination.amount.saturating_sub(before.1),
            recipient,
        });
        Ok(())
    }

    #[inline(never)]
    fn check(&self) -> Result<Pubkey> {
        let cross = read_cross(&self.cross)?;
        require!(cross.base_bound, SettleError::PoolNotOpened);
        // DAMM v2 orders a pool's mints by key, so the base may be token A or token B.
        let (a, b) = (self.token_a_mint.key(), self.token_b_mint.key());
        require!(
            (a == cross.base_mint && b == cross.quote_mint)
                || (a == cross.quote_mint && b == cross.base_mint),
            SettleError::WrongMint
        );
        let base: &TokenAccount = &self.token_a_destination;
        let quote: &TokenAccount = &self.token_b_destination;
        require_keys_eq!(base.owner, cross.proceeds_to, SettleError::WrongDestination);
        require_keys_eq!(
            quote.owner,
            cross.proceeds_to,
            SettleError::WrongDestination
        );
        Ok(cross.proceeds_to)
    }

    #[inline(never)]
    fn claim(&self, settler_bump: u8) -> Result<()> {
        let cross_key = self.cross.key();
        let bump = [settler_bump];
        let seeds: [&[u8]; 3] = [SETTLER_SEED, cross_key.as_ref(), &bump];
        let signer: &[&[&[u8]]] = &[&seeds];
        cp_amm::cpi::claim_position_fee(CpiContext::new_with_signer(
            self.damm_program.key(),
            cp_amm::cpi::accounts::ClaimPositionFee {
                pool_authority: self.damm_pool_authority.to_account_info(),
                pool: self.pool.to_account_info(),
                position: self.position.to_account_info(),
                token_a_account: self.token_a_destination.to_account_info(),
                token_b_account: self.token_b_destination.to_account_info(),
                token_a_vault: self.token_a_vault.to_account_info(),
                token_b_vault: self.token_b_vault.to_account_info(),
                token_a_mint: self.token_a_mint.to_account_info(),
                token_b_mint: self.token_b_mint.to_account_info(),
                position_nft_account: self.position_nft_account.to_account_info(),
                signer: self.settler.to_account_info(),
                token_a_program: self.token_a_program.to_account_info(),
                token_b_program: self.token_b_program.to_account_info(),
                event_authority: self.damm_event_authority.to_account_info(),
                program: self.damm_program.to_account_info(),
            },
            signer,
        ))
    }
}

#[event]
pub struct PolFeesClaimed {
    pub cross: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub token_a: u64,
    pub token_b: u64,
    pub recipient: Pubkey,
}
