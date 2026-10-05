//! Opening Cross transfer hook.
//!
//! Token-2022 calls `execute` on every transfer of a mint whose transfer-hook program is this
//! one. Two rules are enforced:
//!
//! - **Passes.** In `Allowlist` mode the destination owner must hold a [`Pass`] for the mint
//!   (identity-gated assets; pool authorities get passes too). `Open` mode skips this check.
//! - **Locks.** If the source owner has an active [`Lock`], the source balance after the
//!   transfer must stay at or above the locked amount until `unlock_ts`.
//!
//! Locks can only be raised or extended while active, never reduced, so a lock is a commitment
//! other holders can rely on. The hook authority (normally the cross program's PDA) manages
//! passes and locks; it is set once at initialization by whoever holds the mint authority.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_token_2022_interface::{
    extension::{transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions},
    state::Account as Token2022Account,
    ID as TOKEN_2022_PROGRAM_ID,
};
use spl_transfer_hook_interface::instruction::{
    ExecuteInstruction, InitializeExtraAccountMetaListInstruction,
};

declare_id!("2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr");

pub const HOOK_SEED: &[u8] = b"hook";
pub const PASS_SEED: &[u8] = b"pass";
pub const LOCK_SEED: &[u8] = b"lock";
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";

/// Offset of the owner field in an SPL token account.
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

#[program]
pub mod cross_hook {
    use super::*;

    /// Creates the hook configuration and the extra-account-meta list for `mint`.
    /// Must be signed by the mint's current mint authority.
    #[instruction(discriminator = InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, mode: Mode) -> Result<()> {
        let mint = &ctx.accounts.mint;
        require!(
            Option::<Pubkey>::from(mint.mint_authority) == Some(ctx.accounts.mint_authority.key()),
            HookError::NotMintAuthority
        );

        let config = &mut ctx.accounts.hook_config;
        config.mint = mint.key();
        config.authority = authority;
        config.mode = mode;
        config.bump = ctx.bumps.hook_config;

        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &extra_account_metas()?)?;

        emit!(HookInitialized {
            mint: mint.key(),
            authority,
            mode
        });
        Ok(())
    }

    /// Called by Token-2022 during every transfer.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
        let source_info = ctx.accounts.source.to_account_info();
        let destination_info = ctx.accounts.destination.to_account_info();
        // Only a live Token-2022 transfer sets these flags; this also guarantees Token-2022 has
        // already resolved and checked the extra accounts against our meta list.
        require!(
            is_transferring(&source_info.try_borrow_data()?)?,
            HookError::NotTransferring
        );
        require!(
            is_transferring(&destination_info.try_borrow_data()?)?,
            HookError::NotTransferring
        );

        let config = &ctx.accounts.hook_config;
        let mint = ctx.accounts.mint.key();

        if config.mode == Mode::Allowlist {
            let owner = ctx.accounts.destination.owner;
            require!(
                holds_pass(&ctx.accounts.destination_pass, &mint, &owner)?,
                HookError::RecipientNotAllowed
            );
        }

        if let Some(lock) = read_lock(&ctx.accounts.source_lock, &mint, &ctx.accounts.source.owner)?
        {
            let now = Clock::get()?.unix_timestamp;
            if now < lock.unlock_ts {
                // Balances are already updated when Token-2022 invokes the hook.
                let remaining = ctx.accounts.source.amount;
                require!(remaining >= lock.amount, HookError::Locked);
            }
        }
        Ok(())
    }

    /// Grants `owner` a pass for the mint.
    pub fn grant_pass(ctx: Context<GrantPass>, owner: Pubkey) -> Result<()> {
        let pass = &mut ctx.accounts.pass;
        pass.mint = ctx.accounts.hook_config.mint;
        pass.owner = owner;
        pass.bump = ctx.bumps.pass;
        emit!(PassChanged {
            mint: pass.mint,
            owner,
            granted: true
        });
        Ok(())
    }

    /// Revokes `owner`'s pass and returns its rent to the authority.
    pub fn revoke_pass(ctx: Context<RevokePass>) -> Result<()> {
        emit!(PassChanged {
            mint: ctx.accounts.pass.mint,
            owner: ctx.accounts.pass.owner,
            granted: false
        });
        Ok(())
    }

    /// Creates or strengthens a lock. While a lock is active its amount can only rise and its
    /// unlock time can only move later; once expired it may be replaced freely.
    pub fn set_lock(
        ctx: Context<SetLock>,
        owner: Pubkey,
        amount: u64,
        unlock_ts: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let lock = &mut ctx.accounts.lock;
        let fresh = lock.owner == Pubkey::default();
        if !fresh && now < lock.unlock_ts {
            require!(
                amount >= lock.amount && unlock_ts >= lock.unlock_ts,
                HookError::LockCannotWeaken
            );
        }
        lock.mint = ctx.accounts.hook_config.mint;
        lock.owner = owner;
        lock.amount = amount;
        lock.unlock_ts = unlock_ts;
        lock.bump = ctx.bumps.lock;
        emit!(LockChanged {
            mint: lock.mint,
            owner,
            amount,
            unlock_ts
        });
        Ok(())
    }

    /// Closes an expired lock. Anyone may call; rent returns to the hook authority.
    pub fn close_lock(ctx: Context<CloseLock>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.lock.unlock_ts, HookError::LockActive);
        emit!(LockChanged {
            mint: ctx.accounts.lock.mint,
            owner: ctx.accounts.lock.owner,
            amount: 0,
            unlock_ts: 0
        });
        Ok(())
    }

    pub fn set_mode(ctx: Context<AuthorityOnly>, mode: Mode) -> Result<()> {
        ctx.accounts.hook_config.mode = mode;
        emit!(ModeChanged {
            mint: ctx.accounts.hook_config.mint,
            mode
        });
        Ok(())
    }

    pub fn set_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.hook_config.authority = new_authority;
        emit!(AuthorityChanged {
            mint: ctx.accounts.hook_config.mint,
            authority: new_authority
        });
        Ok(())
    }
}

/// Extra accounts Token-2022 must pass to `execute`, after the four standard accounts and the
/// meta list itself: hook config, destination owner's pass, source owner's lock.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let owner_of = |account_index: u8| Seed::AccountData {
        account_index,
        data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
        length: 32,
    };
    let mint = Seed::AccountKey { index: 1 };
    Ok(vec![
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: HOOK_SEED.to_vec(),
                },
                mint.clone(),
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: PASS_SEED.to_vec(),
                },
                mint.clone(),
                owner_of(2),
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: LOCK_SEED.to_vec(),
                },
                mint,
                owner_of(0),
            ],
            false,
            false,
        )?,
    ])
}

fn is_transferring(data: &[u8]) -> Result<bool> {
    let account = StateWithExtensions::<Token2022Account>::unpack(data)?;
    let ext = account.get_extension::<TransferHookAccount>()?;
    Ok(bool::from(ext.transferring))
}

/// A pass counts only if the account is ours, initialized, and recorded for this mint and owner.
fn holds_pass(info: &UncheckedAccount, mint: &Pubkey, owner: &Pubkey) -> Result<bool> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(false);
    }
    let pass = Pass::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    Ok(&pass.mint == mint && &pass.owner == owner)
}

fn read_lock(info: &UncheckedAccount, mint: &Pubkey, owner: &Pubkey) -> Result<Option<Lock>> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    let lock = Lock::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    Ok((&lock.mint == mint && &lock.owner == owner).then_some(lock))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Mode {
    /// Any wallet may receive the token.
    Open,
    /// Only wallets holding a pass may receive the token.
    Allowlist,
}

#[account]
#[derive(InitSpace)]
pub struct HookConfig {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub mode: Mode,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pass {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Lock {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub unlock_ts: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint_authority: Signer<'info>,
    #[account(
        mint::token_program = TOKEN_2022_PROGRAM_ID,
        constraint = hook_program_of(&mint.to_account_info())? == Some(crate::ID) @ HookError::WrongHookProgram,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, space = 8 + HookConfig::INIT_SPACE, seeds = [HOOK_SEED, mint.key().as_ref()], bump)]
    pub hook_config: Account<'info, HookConfig>,
    /// CHECK: TLV buffer created here; layout defined by the transfer-hook interface.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(extra_account_metas()?.len())?,
        seeds = [EXTRA_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint, token::token_program = TOKEN_2022_PROGRAM_ID)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = TOKEN_2022_PROGRAM_ID)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = mint, token::token_program = TOKEN_2022_PROGRAM_ID)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: source owner or delegate; Token-2022 has already authorised the transfer.
    pub owner_delegate: UncheckedAccount<'info>,
    /// CHECK: verified by seeds.
    #[account(seeds = [EXTRA_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    #[account(seeds = [HOOK_SEED, mint.key().as_ref()], bump = hook_config.bump)]
    pub hook_config: Account<'info, HookConfig>,
    /// CHECK: may be uninitialized; validated in `holds_pass`.
    pub destination_pass: UncheckedAccount<'info>,
    /// CHECK: may be uninitialized; validated in `read_lock`.
    pub source_lock: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct GrantPass<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ HookError::Unauthorized)]
    pub hook_config: Account<'info, HookConfig>,
    #[account(init, payer = authority, space = 8 + Pass::INIT_SPACE, seeds = [PASS_SEED, hook_config.mint.as_ref(), owner.as_ref()], bump)]
    pub pass: Account<'info, Pass>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokePass<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ HookError::Unauthorized)]
    pub hook_config: Account<'info, HookConfig>,
    #[account(mut, close = authority, constraint = pass.mint == hook_config.mint @ HookError::Unauthorized)]
    pub pass: Account<'info, Pass>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct SetLock<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ HookError::Unauthorized)]
    pub hook_config: Account<'info, HookConfig>,
    #[account(init_if_needed, payer = authority, space = 8 + Lock::INIT_SPACE, seeds = [LOCK_SEED, hook_config.mint.as_ref(), owner.as_ref()], bump)]
    pub lock: Account<'info, Lock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseLock<'info> {
    /// CHECK: receives rent; must be the hook authority.
    #[account(mut, address = hook_config.authority @ HookError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    pub hook_config: Account<'info, HookConfig>,
    #[account(mut, close = authority, constraint = lock.mint == hook_config.mint @ HookError::Unauthorized)]
    pub lock: Account<'info, Lock>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ HookError::Unauthorized)]
    pub hook_config: Account<'info, HookConfig>,
}

fn hook_program_of(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    use spl_token_2022_interface::{
        extension::transfer_hook::TransferHook, state::Mint as Token2022Mint,
    };
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)?;
    Ok(state
        .get_extension::<TransferHook>()
        .ok()
        .and_then(|h| Option::<Pubkey>::from(h.program_id)))
}

#[event]
pub struct HookInitialized {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub mode: Mode,
}
#[event]
pub struct PassChanged {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub granted: bool,
}
#[event]
pub struct LockChanged {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub unlock_ts: i64,
}
#[event]
pub struct ModeChanged {
    pub mint: Pubkey,
    pub mode: Mode,
}
#[event]
pub struct AuthorityChanged {
    pub mint: Pubkey,
    pub authority: Pubkey,
}

#[error_code]
pub enum HookError {
    #[msg("Hook executed outside a Token-2022 transfer")]
    NotTransferring,
    #[msg("Recipient does not hold a pass for this token")]
    RecipientNotAllowed,
    #[msg("Transfer would take the balance below an active lock")]
    Locked,
    #[msg("Signer is not the mint authority")]
    NotMintAuthority,
    #[msg("Mint's transfer hook does not point at this program")]
    WrongHookProgram,
    #[msg("Signer is not the hook authority")]
    Unauthorized,
    #[msg("An active lock can only be raised or extended")]
    LockCannotWeaken,
    #[msg("Lock has not expired")]
    LockActive,
}
