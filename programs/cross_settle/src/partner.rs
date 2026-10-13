//! DBC partner-side claims (ADR-0480, ROADMAP HD4).
//!
//! `open_dbc_pool` makes this adapter's per-cross settler PDA the DBC *partner* (`fee_claimer`) of the
//! pool, so only `cross_settle` can sign the partner's claims. Without these instructions the partner's
//! share of the trading fees, its surplus and its migration fee are unreachable.
//!
//! Every instruction is permissionless, because each one pays a fixed destination that the cross
//! itself names and nobody else may choose:
//! - trading fees, the migration fee and the pool-creation fee are the protocol's revenue and go to
//!   an account owned by `Cross.fee_recipient`, the recipient snapshotted when the cross was created;
//! - the surplus above the migration threshold is the issuer's capital (it funds the treasury and
//!   the greenshoe, ADR-0481), so it goes to an account owned by `Cross.proceeds_to`.
//!
//! The settler holds no tokens at any time: DBC pays straight into the destination, and the
//! destination's owner is checked here before the CPI.

use super::*;

/// Destination owner rule, in one place so the four instructions cannot drift apart.
fn owned_by(account: &InterfaceAccount<TokenAccount>, owner: &Pubkey) -> Result<()> {
    let token: &TokenAccount = account;
    require_keys_eq!(token.owner, *owner, SettleError::WrongDestination);
    Ok(())
}

fn settler_signer_seeds<'a>(cross: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [SETTLER_SEED, cross.as_ref(), bump]
}

/// The pool must belong to this cross: its config is the cross's own DBC config PDA, which the
/// account constraints already pin, and the cross must have cleared and named a settler.
fn require_opened(cross: &Cross) -> Result<()> {
    require!(
        cross.settler.is_some() && cross.clearing.is_some(),
        SettleError::PoolNotOpened
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimPartnerFee<'info> {
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: this adapter's settler PDA; it is the DBC partner and signs the claim.
    #[account(seeds = [SETTLER_SEED, cross.key().as_ref()], bump)]
    pub settler: UncheckedAccount<'info>,
    /// CHECK: DBC's constant pool-authority PDA, validated by DBC.
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: the cross's own DBC config; DBC checks the pool belongs to it.
    #[account(seeds = [DBC_CONFIG_SEED, cross.key().as_ref()], bump)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC pool PDA, validated by DBC.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// Receives the partner's base-token fees; must belong to the fee recipient.
    #[account(mut)]
    pub base_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Receives the partner's quote-token fees; must belong to the fee recipient.
    #[account(mut)]
    pub quote_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DBC vault PDA, validated by DBC.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC vault PDA, validated by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: DBC's event authority, validated by DBC.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DBC program.
    #[account(address = dynamic_bonding_curve::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    pub base_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

impl<'info> ClaimPartnerFee<'info> {
    /// Claims the partner's trading fees to the protocol fee recipient. The base-token leg needs the
    /// mint's transfer-hook accounts, passed as remaining accounts with the slice description DBC asks for.
    pub fn run(
        &mut self,
        settler_bump: u8,
        remaining: &[AccountInfo<'info>],
        max_base: u64,
        max_quote: u64,
        hook: dynamic_bonding_curve::types::TransferHookAccountsInfo,
    ) -> Result<()> {
        let recipient = self.check_destinations()?;
        let before = (self.base_destination.amount, self.quote_destination.amount);
        self.claim(settler_bump, remaining, max_base, max_quote, hook)?;
        self.base_destination.reload()?;
        self.quote_destination.reload()?;
        emit!(PartnerFeeClaimed {
            cross: self.cross.key(),
            pool: self.pool.key(),
            base: self.base_destination.amount.saturating_sub(before.0),
            quote: self.quote_destination.amount.saturating_sub(before.1),
            recipient,
        });
        Ok(())
    }

    #[inline(never)]
    fn check_destinations(&self) -> Result<Pubkey> {
        let cross = read_cross(&self.cross)?;
        require_opened(&cross)?;
        owned_by(&self.base_destination, &cross.fee_recipient)?;
        owned_by(&self.quote_destination, &cross.fee_recipient)?;
        Ok(cross.fee_recipient)
    }

    #[inline(never)]
    fn claim(
        &self,
        settler_bump: u8,
        remaining: &[AccountInfo<'info>],
        max_base: u64,
        max_quote: u64,
        hook: dynamic_bonding_curve::types::TransferHookAccountsInfo,
    ) -> Result<()> {
        let cross_key = self.cross.key();
        let bump = [settler_bump];
        let seeds = settler_signer_seeds(&cross_key, &bump);
        let signer: &[&[&[u8]]] = &[&seeds];
        let cpi = CpiContext::new_with_signer(
            self.dbc_program.key(),
            dynamic_bonding_curve::cpi::accounts::ClaimTradingFee2 {
                pool_authority: self.dbc_pool_authority.to_account_info(),
                config: self.dbc_config.to_account_info(),
                pool: self.pool.to_account_info(),
                token_a_account: self.base_destination.to_account_info(),
                token_b_account: self.quote_destination.to_account_info(),
                base_vault: self.base_vault.to_account_info(),
                quote_vault: self.quote_vault.to_account_info(),
                base_mint: self.base_mint.to_account_info(),
                quote_mint: self.quote_mint.to_account_info(),
                fee_claimer: self.settler.to_account_info(),
                token_base_program: self.base_token_program.to_account_info(),
                token_quote_program: self.quote_token_program.to_account_info(),
                event_authority: self.dbc_event_authority.to_account_info(),
                program: self.dbc_program.to_account_info(),
            },
            signer,
        )
        .with_remaining_accounts(remaining.to_vec());
        dynamic_bonding_curve::cpi::claim_trading_fee2(cpi, max_base, max_quote, hook)
    }
}

#[derive(Accounts)]
pub struct WithdrawPartnerSurplus<'info> {
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: this adapter's settler PDA; it is the DBC partner and signs.
    #[account(seeds = [SETTLER_SEED, cross.key().as_ref()], bump)]
    pub settler: UncheckedAccount<'info>,
    /// CHECK: DBC's constant pool-authority PDA, validated by DBC.
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: the cross's own DBC config; DBC checks the pool belongs to it.
    #[account(seeds = [DBC_CONFIG_SEED, cross.key().as_ref()], bump)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC pool PDA, validated by DBC.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// Receives the quote; must belong to the cross's `proceeds_to` (surplus) or its fee recipient
    /// (migration fee).
    #[account(mut)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: DBC vault PDA, validated by DBC.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: DBC's event authority, validated by DBC.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DBC program.
    #[account(address = dynamic_bonding_curve::ID)]
    pub dbc_program: UncheckedAccount<'info>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

impl<'info> WithdrawPartnerSurplus<'info> {
    /// The partner's share of the quote above the migration threshold goes to the issuer's proceeds
    /// account: it is capital, not a fee (ADR-0481).
    pub fn surplus(&mut self, settler_bump: u8) -> Result<()> {
        let recipient = self.check_destination(|c| c.proceeds_to)?;
        let before = self.destination.amount;
        self.cpi_surplus(settler_bump)?;
        self.destination.reload()?;
        emit!(PartnerSurplusWithdrawn {
            cross: self.cross.key(),
            pool: self.pool.key(),
            amount: self.destination.amount.saturating_sub(before),
            recipient,
        });
        Ok(())
    }

    /// The partner's slice of the migration fee goes to the protocol fee recipient.
    pub fn migration_fee(&mut self, settler_bump: u8) -> Result<()> {
        let recipient = self.check_destination(|c| c.fee_recipient)?;
        let before = self.destination.amount;
        self.cpi_migration_fee(settler_bump)?;
        self.destination.reload()?;
        emit!(PartnerMigrationFeeWithdrawn {
            cross: self.cross.key(),
            pool: self.pool.key(),
            amount: self.destination.amount.saturating_sub(before),
            recipient,
        });
        Ok(())
    }

    #[inline(never)]
    fn check_destination(&self, owner_of: fn(&Cross) -> Pubkey) -> Result<Pubkey> {
        let cross = read_cross(&self.cross)?;
        require_opened(&cross)?;
        let owner = owner_of(&cross);
        owned_by(&self.destination, &owner)?;
        Ok(owner)
    }

    #[inline(never)]
    fn cpi_surplus(&self, settler_bump: u8) -> Result<()> {
        let cross_key = self.cross.key();
        let bump = [settler_bump];
        let seeds = settler_signer_seeds(&cross_key, &bump);
        let signer: &[&[&[u8]]] = &[&seeds];
        dynamic_bonding_curve::cpi::partner_withdraw_surplus(CpiContext::new_with_signer(
            self.dbc_program.key(),
            dynamic_bonding_curve::cpi::accounts::PartnerWithdrawSurplus {
                pool_authority: self.dbc_pool_authority.to_account_info(),
                config: self.dbc_config.to_account_info(),
                virtual_pool: self.pool.to_account_info(),
                token_quote_account: self.destination.to_account_info(),
                quote_vault: self.quote_vault.to_account_info(),
                quote_mint: self.quote_mint.to_account_info(),
                fee_claimer: self.settler.to_account_info(),
                token_quote_program: self.quote_token_program.to_account_info(),
                event_authority: self.dbc_event_authority.to_account_info(),
                program: self.dbc_program.to_account_info(),
            },
            signer,
        ))
    }

    #[inline(never)]
    fn cpi_migration_fee(&self, settler_bump: u8) -> Result<()> {
        let cross_key = self.cross.key();
        let bump = [settler_bump];
        let seeds = settler_signer_seeds(&cross_key, &bump);
        let signer: &[&[&[u8]]] = &[&seeds];
        dynamic_bonding_curve::cpi::withdraw_migration_fee(
            CpiContext::new_with_signer(
                self.dbc_program.key(),
                dynamic_bonding_curve::cpi::accounts::WithdrawMigrationFee {
                    pool_authority: self.dbc_pool_authority.to_account_info(),
                    config: self.dbc_config.to_account_info(),
                    virtual_pool: self.pool.to_account_info(),
                    token_quote_account: self.destination.to_account_info(),
                    quote_vault: self.quote_vault.to_account_info(),
                    quote_mint: self.quote_mint.to_account_info(),
                    sender: self.settler.to_account_info(),
                    token_quote_program: self.quote_token_program.to_account_info(),
                    event_authority: self.dbc_event_authority.to_account_info(),
                    program: self.dbc_program.to_account_info(),
                },
                signer,
            ),
            PARTNER_MIGRATION_FEE_FLAG,
        )
    }
}

#[derive(Accounts)]
pub struct ClaimPartnerPoolCreationFee<'info> {
    /// CHECK: owner and contents checked in `read_cross`.
    pub cross: UncheckedAccount<'info>,
    /// CHECK: this adapter's settler PDA; it is the DBC partner and signs.
    #[account(seeds = [SETTLER_SEED, cross.key().as_ref()], bump)]
    pub settler: UncheckedAccount<'info>,
    /// CHECK: the cross's own DBC config; DBC checks the pool belongs to it.
    #[account(seeds = [DBC_CONFIG_SEED, cross.key().as_ref()], bump)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC pool PDA, validated by DBC.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the lamport destination; it must be the cross's fee recipient wallet.
    #[account(mut)]
    pub fee_receiver: UncheckedAccount<'info>,
    /// CHECK: DBC's event authority, validated by DBC.
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DBC program.
    #[account(address = dynamic_bonding_curve::ID)]
    pub dbc_program: UncheckedAccount<'info>,
}

impl<'info> ClaimPartnerPoolCreationFee<'info> {
    /// The pool-creation fee the issuer paid into the config is the partner's to claim; it goes to the
    /// fee recipient's wallet.
    #[inline(never)]
    pub fn run(&self, settler_bump: u8) -> Result<()> {
        let cross = read_cross(&self.cross)?;
        require_opened(&cross)?;
        require_keys_eq!(
            self.fee_receiver.key(),
            cross.fee_recipient,
            SettleError::WrongDestination
        );
        let cross_key = self.cross.key();
        let bump = [settler_bump];
        let seeds = settler_signer_seeds(&cross_key, &bump);
        let signer: &[&[&[u8]]] = &[&seeds];
        let before = self.fee_receiver.lamports();
        dynamic_bonding_curve::cpi::claim_partner_pool_creation_fee(CpiContext::new_with_signer(
            self.dbc_program.key(),
            dynamic_bonding_curve::cpi::accounts::ClaimPartnerPoolCreationFee {
                config: self.dbc_config.to_account_info(),
                pool: self.pool.to_account_info(),
                fee_claimer: self.settler.to_account_info(),
                fee_receiver: self.fee_receiver.to_account_info(),
                event_authority: self.dbc_event_authority.to_account_info(),
                program: self.dbc_program.to_account_info(),
            },
            signer,
        ))?;
        emit!(PartnerPoolCreationFeeClaimed {
            cross: cross_key,
            pool: self.pool.key(),
            lamports: self.fee_receiver.lamports().saturating_sub(before),
            recipient: cross.fee_recipient,
        });
        Ok(())
    }
}

#[event]
pub struct PartnerFeeClaimed {
    pub cross: Pubkey,
    pub pool: Pubkey,
    pub base: u64,
    pub quote: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct PartnerSurplusWithdrawn {
    pub cross: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct PartnerMigrationFeeWithdrawn {
    pub cross: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct PartnerPoolCreationFeeClaimed {
    pub cross: Pubkey,
    pub pool: Pubkey,
    pub lamports: u64,
    pub recipient: Pubkey,
}
