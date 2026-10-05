//! Opening Cross gate: one set of passes and locks, enforced two ways.
//!
//! - **Transfer hook.** Token-2022 calls [`cross_gate::execute`] on every transfer of a mint
//!   whose transfer-hook program is this one. Used while a token trades on a Meteora DBC curve.
//! - **Token ACL gate (sRFC-37).** Token ACL calls [`cross_gate::can_thaw_permissionless`] and
//!   [`cross_gate::can_freeze_permissionless`] for mints that start every account frozen and
//!   delegate their freeze authority to Token ACL. Used for gated assets that live outside a
//!   hooked curve, because DBC removes the hook at graduation and its mints have no freeze
//!   authority (see `docs/evidence/DP-dbc-hook.md`).
//!
//! Rules:
//! - **Passes.** In `Allowlist` mode only owners holding a [`Pass`] may receive the token (hook)
//!   or thaw their account (Token ACL); an account whose owner has no pass may be frozen by
//!   anyone. `Open` mode lets everyone in.
//! - **Locks.** If the source owner has an active [`Lock`], the source balance after a hooked
//!   transfer must stay at or above the locked amount until `unlock_ts`. A lock can only be
//!   raised or extended while active, never reduced.
//!
//! The gate authority (normally the cross program's PDA) manages passes and locks. It is set
//! once, by whoever holds the mint authority, when the [`GateConfig`] is created.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_token_2022_interface::{
    extension::{
        transfer_hook::{TransferHook, TransferHookAccount},
        BaseStateWithExtensions, StateWithExtensions,
    },
    state::{Account as Token2022Account, Mint as Token2022Mint},
    ID as TOKEN_2022_PROGRAM_ID,
};
use spl_transfer_hook_interface::instruction::{
    ExecuteInstruction, InitializeExtraAccountMetaListInstruction,
};

declare_id!("2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr");

/// Token ACL program (sRFC-37), same address on mainnet and devnet.
pub const TOKEN_ACL_PROGRAM_ID: Pubkey = pubkey!("TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP");

pub const CONFIG_SEED: &[u8] = b"config";
pub const PASS_SEED: &[u8] = b"pass";
pub const LOCK_SEED: &[u8] = b"lock";
pub const HOOK_METAS_SEED: &[u8] = b"extra-account-metas";
/// The deployed Token ACL derives these with underscores (`token-acl-interface`); the sRFC-37
/// text shows hyphens. The program is authoritative.
pub const THAW_METAS_SEED: &[u8] = b"thaw_extra_account_metas";
pub const FREEZE_METAS_SEED: &[u8] = b"freeze_extra_account_metas";

/// sRFC-37 interface discriminators.
pub const CAN_THAW_PERMISSIONLESS: [u8; 8] = [8, 175, 169, 129, 137, 74, 61, 241];
pub const CAN_FREEZE_PERMISSIONLESS: [u8; 8] = [214, 141, 109, 75, 248, 1, 45, 29];

/// Offset of the owner field in an SPL token account.
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

#[program]
pub mod cross_gate {
    use super::*;

    /// Creates the gate configuration for `mint`. Must be signed by the mint authority.
    pub fn create_config(ctx: Context<CreateConfig>, authority: Pubkey, mode: Mode) -> Result<()> {
        let mint = &ctx.accounts.mint;
        require!(
            Option::<Pubkey>::from(mint.mint_authority) == Some(ctx.accounts.mint_authority.key()),
            GateError::NotMintAuthority
        );
        let config = &mut ctx.accounts.config;
        config.mint = mint.key();
        config.authority = authority;
        config.mode = mode;
        config.bump = ctx.bumps.config;
        emit!(ConfigCreated {
            mint: mint.key(),
            authority,
            mode
        });
        Ok(())
    }

    /// Writes the transfer-hook extra-account-meta list. The mint's hook must point here.
    #[instruction(discriminator = InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn init_hook_metas(ctx: Context<InitHookMetas>) -> Result<()> {
        require!(
            hook_program_of(&ctx.accounts.mint.to_account_info())? == Some(crate::ID),
            GateError::WrongHookProgram
        );
        let mut data = ctx.accounts.extra_metas.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &hook_extra_metas()?)?;
        Ok(())
    }

    /// Writes the Token ACL thaw and freeze extra-account-meta lists.
    pub fn init_gate_metas(ctx: Context<InitGateMetas>) -> Result<()> {
        let metas = gate_extra_metas()?;
        let mut thaw = ctx.accounts.thaw_metas.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<CanThawPermissionless>(&mut thaw, &metas)?;
        let mut freeze = ctx.accounts.freeze_metas.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<CanFreezePermissionless>(&mut freeze, &metas)?;
        Ok(())
    }

    /// Transfer hook: called by Token-2022 during every transfer.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
        // Only a live Token-2022 transfer sets these flags, and on that path Token-2022 has
        // already resolved the extra accounts from our meta list.
        require!(
            is_transferring(&ctx.accounts.source.to_account_info().try_borrow_data()?)?,
            GateError::NotTransferring
        );
        require!(
            is_transferring(
                &ctx.accounts
                    .destination
                    .to_account_info()
                    .try_borrow_data()?
            )?,
            GateError::NotTransferring
        );

        let mint = ctx.accounts.mint.key();
        if ctx.accounts.config.mode == Mode::Allowlist {
            let owner = ctx.accounts.destination.owner;
            require!(
                holds_pass(&ctx.accounts.destination_pass, &mint, &owner)?,
                GateError::RecipientNotAllowed
            );
        }

        if let Some(lock) = read_lock(&ctx.accounts.source_lock, &mint, &ctx.accounts.source.owner)?
        {
            if Clock::get()?.unix_timestamp < lock.unlock_ts {
                // Balances are already updated when Token-2022 invokes the hook.
                require!(ctx.accounts.source.amount >= lock.amount, GateError::Locked);
            }
        }
        Ok(())
    }

    /// Token ACL: may `owner`'s frozen account be thawed without the issuer? Yes if the mint is
    /// open or the owner holds a pass.
    #[instruction(discriminator = &CAN_THAW_PERMISSIONLESS)]
    pub fn can_thaw_permissionless(ctx: Context<GateCheck>) -> Result<()> {
        ctx.accounts.check_called_by_token_acl()?;
        let allowed = ctx.accounts.config.mode == Mode::Open
            || holds_pass(
                &ctx.accounts.pass,
                &ctx.accounts.mint.key(),
                &ctx.accounts.owner.key(),
            )?;
        require!(allowed, GateError::RecipientNotAllowed);
        Ok(())
    }

    /// Token ACL: may anyone freeze `owner`'s account? Yes if the mint is allowlisted and the
    /// owner holds no pass (for example after the pass was revoked).
    #[instruction(discriminator = &CAN_FREEZE_PERMISSIONLESS)]
    pub fn can_freeze_permissionless(ctx: Context<GateCheck>) -> Result<()> {
        ctx.accounts.check_called_by_token_acl()?;
        let blocked = ctx.accounts.config.mode == Mode::Allowlist
            && !holds_pass(
                &ctx.accounts.pass,
                &ctx.accounts.mint.key(),
                &ctx.accounts.owner.key(),
            )?;
        require!(blocked, GateError::OwnerAllowed);
        Ok(())
    }

    /// Grants `owner` a pass for the mint.
    pub fn grant_pass(ctx: Context<GrantPass>, owner: Pubkey) -> Result<()> {
        let pass = &mut ctx.accounts.pass;
        pass.mint = ctx.accounts.config.mint;
        pass.owner = owner;
        pass.bump = ctx.bumps.pass;
        emit!(PassChanged {
            mint: pass.mint,
            owner,
            granted: true
        });
        Ok(())
    }

    /// Revokes a pass and returns its rent to the authority.
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
                GateError::LockCannotWeaken
            );
        }
        lock.mint = ctx.accounts.config.mint;
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

    /// Closes an expired lock. Anyone may call; rent returns to the gate authority.
    pub fn close_lock(ctx: Context<CloseLock>) -> Result<()> {
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.lock.unlock_ts,
            GateError::LockActive
        );
        emit!(LockChanged {
            mint: ctx.accounts.lock.mint,
            owner: ctx.accounts.lock.owner,
            amount: 0,
            unlock_ts: 0
        });
        Ok(())
    }

    pub fn set_mode(ctx: Context<AuthorityOnly>, mode: Mode) -> Result<()> {
        ctx.accounts.config.mode = mode;
        emit!(ModeChanged {
            mint: ctx.accounts.config.mint,
            mode
        });
        Ok(())
    }

    pub fn set_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.authority = new_authority;
        emit!(AuthorityChanged {
            mint: ctx.accounts.config.mint,
            authority: new_authority
        });
        Ok(())
    }
}

/// Transfer-hook extras after the 4 standard accounts and the meta list:
/// gate config, destination owner's pass, source owner's lock.
pub fn hook_extra_metas() -> Result<Vec<ExtraAccountMeta>> {
    let owner_of = |account_index: u8| Seed::AccountData {
        account_index,
        data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
        length: 32,
    };
    let mint = Seed::AccountKey { index: 1 };
    Ok(vec![
        ExtraAccountMeta::new_with_seeds(&[literal(CONFIG_SEED), mint.clone()], false, false)?,
        ExtraAccountMeta::new_with_seeds(
            &[literal(PASS_SEED), mint.clone(), owner_of(2)],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_seeds(&[literal(LOCK_SEED), mint, owner_of(0)], false, false)?,
    ])
}

/// Token ACL extras after `[caller, token account, mint, owner, flag, extra metas]`:
/// gate config, owner's pass.
pub fn gate_extra_metas() -> Result<Vec<ExtraAccountMeta>> {
    let mint = Seed::AccountKey { index: 2 };
    Ok(vec![
        ExtraAccountMeta::new_with_seeds(&[literal(CONFIG_SEED), mint.clone()], false, false)?,
        ExtraAccountMeta::new_with_seeds(
            &[literal(PASS_SEED), mint, Seed::AccountKey { index: 3 }],
            false,
            false,
        )?,
    ])
}

fn literal(bytes: &[u8]) -> Seed {
    Seed::Literal {
        bytes: bytes.to_vec(),
    }
}

/// Marker types so the TLV lists are keyed by the sRFC-37 discriminators.
pub struct CanThawPermissionless;
impl SplDiscriminate for CanThawPermissionless {
    const SPL_DISCRIMINATOR: spl_discriminator::ArrayDiscriminator =
        spl_discriminator::ArrayDiscriminator::new(CAN_THAW_PERMISSIONLESS);
}
pub struct CanFreezePermissionless;
impl SplDiscriminate for CanFreezePermissionless {
    const SPL_DISCRIMINATOR: spl_discriminator::ArrayDiscriminator =
        spl_discriminator::ArrayDiscriminator::new(CAN_FREEZE_PERMISSIONLESS);
}

fn is_transferring(data: &[u8]) -> Result<bool> {
    let account = StateWithExtensions::<Token2022Account>::unpack(data)?;
    let ext = account.get_extension::<TransferHookAccount>()?;
    Ok(bool::from(ext.transferring))
}

fn hook_program_of(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)?;
    Ok(state
        .get_extension::<TransferHook>()
        .ok()
        .and_then(|h| Option::<Pubkey>::from(h.program_id)))
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
    /// Any wallet may hold and receive the token.
    Open,
    /// Only wallets holding a pass may receive the token or thaw their account.
    Allowlist,
}

#[account]
#[derive(InitSpace)]
pub struct GateConfig {
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
pub struct CreateConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint_authority: Signer<'info>,
    #[account(mint::token_program = TOKEN_2022_PROGRAM_ID)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = payer, space = 8 + GateConfig::INIT_SPACE, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: Account<'info, GateConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitHookMetas<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(mint::token_program = TOKEN_2022_PROGRAM_ID)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump, has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: TLV buffer created here; layout defined by the transfer-hook interface.
    #[account(init, payer = payer, space = ExtraAccountMetaList::size_of(hook_extra_metas()?.len())?, seeds = [HOOK_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitGateMetas<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(mint::token_program = TOKEN_2022_PROGRAM_ID)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump, has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: TLV buffer created here; layout defined by sRFC-37.
    #[account(init, payer = payer, space = ExtraAccountMetaList::size_of(gate_extra_metas()?.len())?, seeds = [THAW_METAS_SEED, mint.key().as_ref()], bump)]
    pub thaw_metas: UncheckedAccount<'info>,
    /// CHECK: TLV buffer created here; layout defined by sRFC-37.
    #[account(init, payer = payer, space = ExtraAccountMetaList::size_of(gate_extra_metas()?.len())?, seeds = [FREEZE_METAS_SEED, mint.key().as_ref()], bump)]
    pub freeze_metas: UncheckedAccount<'info>,
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
    #[account(seeds = [HOOK_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: may be uninitialized; validated in `holds_pass`.
    pub destination_pass: UncheckedAccount<'info>,
    /// CHECK: may be uninitialized; validated in `read_lock`.
    pub source_lock: UncheckedAccount<'info>,
}

/// Accounts for both sRFC-37 checks; `extra_metas` is the thaw or freeze list respectively.
#[derive(Accounts)]
pub struct GateCheck<'info> {
    /// CHECK: whoever asked Token ACL to thaw or freeze; carries no authority here.
    pub caller: UncheckedAccount<'info>,
    #[account(token::mint = mint, token::authority = owner, token::token_program = TOKEN_2022_PROGRAM_ID)]
    pub token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = TOKEN_2022_PROGRAM_ID)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: bound to `token_account` by its constraint.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: verified in `check_called_by_token_acl`.
    pub flag: UncheckedAccount<'info>,
    /// CHECK: thaw or freeze meta list; Token ACL resolved the extras from it.
    pub extra_metas: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: may be uninitialized; validated in `holds_pass`.
    pub pass: UncheckedAccount<'info>,
}

impl GateCheck<'_> {
    /// sRFC-37: during a permissionless thaw/freeze Token ACL creates a flag account it owns,
    /// holding the single byte `1`. Requiring it means only Token ACL can obtain a "yes".
    fn check_called_by_token_acl(&self) -> Result<()> {
        let data = self.flag.try_borrow_data()?;
        require!(
            self.flag.owner == &TOKEN_ACL_PROGRAM_ID && data.as_ref() == [1u8],
            GateError::NotCalledByTokenAcl
        );
        let metas = self.extra_metas.key();
        let mint = self.mint.key();
        let thaw = Pubkey::find_program_address(&[THAW_METAS_SEED, mint.as_ref()], &crate::ID).0;
        let freeze =
            Pubkey::find_program_address(&[FREEZE_METAS_SEED, mint.as_ref()], &crate::ID).0;
        require!(metas == thaw || metas == freeze, GateError::WrongMetaList);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct GrantPass<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    #[account(init, payer = authority, space = 8 + Pass::INIT_SPACE, seeds = [PASS_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub pass: Account<'info, Pass>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokePass<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    #[account(mut, close = authority, constraint = pass.mint == config.mint @ GateError::Unauthorized)]
    pub pass: Account<'info, Pass>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct SetLock<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    #[account(init_if_needed, payer = authority, space = 8 + Lock::INIT_SPACE, seeds = [LOCK_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub lock: Account<'info, Lock>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseLock<'info> {
    /// CHECK: receives rent; must be the gate authority.
    #[account(mut, address = config.authority @ GateError::Unauthorized)]
    pub authority: UncheckedAccount<'info>,
    pub config: Account<'info, GateConfig>,
    #[account(mut, close = authority, constraint = lock.mint == config.mint @ GateError::Unauthorized)]
    pub lock: Account<'info, Lock>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
}

#[event]
pub struct ConfigCreated {
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
pub enum GateError {
    #[msg("Hook executed outside a Token-2022 transfer")]
    NotTransferring,
    #[msg("Owner does not hold a pass for this token")]
    RecipientNotAllowed,
    #[msg("Transfer would take the balance below an active lock")]
    Locked,
    #[msg("Signer is not the mint authority")]
    NotMintAuthority,
    #[msg("Mint's transfer hook does not point at this program")]
    WrongHookProgram,
    #[msg("Signer is not the gate authority")]
    Unauthorized,
    #[msg("An active lock can only be raised or extended")]
    LockCannotWeaken,
    #[msg("Lock has not expired")]
    LockActive,
    #[msg("Gate check was not invoked by Token ACL")]
    NotCalledByTokenAcl,
    #[msg("Extra-account-meta list is not this mint's thaw or freeze list")]
    WrongMetaList,
    #[msg("Owner holds a pass; permissionless freeze is not allowed")]
    OwnerAllowed,
}
