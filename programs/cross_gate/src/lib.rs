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
//!
//! **Compliance rules (ADR-0900).** A gate can opt into rules with `init_rules`: country allow or
//! deny lists, minimum tier, required flags (accredited, sanctions-screened, KYC), an investor cap,
//! one pass per identity, issuance windows, transfer blackouts, affiliate volume limits and a resale
//! lock. The rules live after the original [`GateConfig`] bytes in the same account. While they are
//! active the original permissionless and authority issuance paths are refused (`UseRulesPath`) and
//! passes are issued with [`Terms`] (identity, country, tier, flags, cap) by the `*_terms` family.
//!
//! Where each rule is enforced:
//! - **Issuance and refresh** (`issue`, `refresh_terms`): country, tier, flags, issuance window,
//!   investor cap, one pass per identity, denial.
//! - **Every hooked transfer** (`execute`): the receiver's terms have not lapsed and still satisfy the
//!   country, tier and flag rules, so a rule change bites on the next transfer; a sender flagged as
//!   an affiliate is held to the blackout windows and the volume limit.
//! - **Afterwards, by anyone**: `revoke_expired`, `revoke_nonconforming` and `revoke_denied` close
//!   the pass of a wallet that no longer qualifies.
//! - **Token ACL gates** (`can_thaw_permissionless`) check the pass only; a closed pass is what
//!   removes access there.
//!
//! A gate with rules needs the longer transfer-hook account list (`update_hook_metas`). Gates without
//! rules keep the three-account list, so existing clients of hooked mints are unaffected.
#![allow(unexpected_cfgs)]
// Anchor 1.0.2's `#[program]` expansion trips this lint; it is not in our code.
#![allow(clippy::diverging_sub_expression)]

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

pub mod attest;
pub mod rules;
use rules::{
    AffiliateLimit, Rules, TermsData, FLAG_ACCREDITED, FLAG_AFFILIATE, SOURCE_AUTHORITY,
    SOURCE_MERKLE, SOURCE_SAS,
};

declare_id!("2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr");

/// Token ACL program (sRFC-37), same address on mainnet and devnet.
pub const TOKEN_ACL_PROGRAM_ID: Pubkey = pubkey!("TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP");

pub const CONFIG_SEED: &[u8] = b"config";
pub const PASS_SEED: &[u8] = b"pass";
pub const LOCK_SEED: &[u8] = b"lock";
pub const HOOK_METAS_SEED: &[u8] = b"extra-account-metas";
pub const TERMS_SEED: &[u8] = b"terms";
pub const IDENTITY_SEED: &[u8] = b"identity";
pub const VOLUME_SEED: &[u8] = b"volume";
pub const DENY_SEED: &[u8] = b"deny";
pub const ALLOC_SEED: &[u8] = b"alloc";

/// The only program allowed to reserve allocations and apply resale locks on a gate's behalf. A
/// test pins this to `CROSS_CORE_PROGRAM_ADDRESS` of the generated client.
pub const CROSS_CORE_PROGRAM_ID: Pubkey = pubkey!("F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ");
/// Where the rules extension begins inside a gate's config account.
pub const EXT_OFFSET: usize = 8 + GateConfig::INIT_SPACE;
/// Where the one fact this program needs sits inside a `cross_core::Cross` account (Anchor layout: 8-byte
/// discriminator, then the fields in declaration order): the base mint, after `creator`, `cross_id` and four one-byte
/// enums. `cross_gate` cannot depend on `cross_core` (the dependency runs the other way), so it reads the field by
/// offset. Only fields before the first `Option` are read: an `Option` serialises to one byte when it is `None`, so any
/// offset after one moves with the cross's contents. `packages/cross-gate-client/test/svm/gate-hook.test.ts` checks the
/// offset against a cross `cross_core` created, so a layout change in `cross_core` fails a test instead of misreading.
const CROSS_BASE_MINT_OFFSET: usize = 8 + 32 + 8 + 4;
const CROSS_MIN_LEN: usize = CROSS_BASE_MINT_OFFSET + 32;

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
        config.sas = None;
        config.allowlist_root = None;
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
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
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

        // Compliance rules (ADR-0900): the receiver's terms still satisfy them, and the sender's
        // blackout windows and volume limit hold.
        if let Some(rules) = rules_of(&ctx.accounts.config.to_account_info())? {
            enforce_transfer_rules(
                &rules,
                &mint,
                &ctx.accounts.source.owner,
                &ctx.accounts.destination.owner,
                amount,
                ctx.remaining_accounts,
            )?;
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
        require_legacy_path(&ctx.accounts.config.to_account_info())?;
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
        require_legacy_path(&ctx.accounts.config.to_account_info())?;
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
        // The authority, or the keeper the rules name as lock delegate (it can only ever strengthen).
        let signer = ctx.accounts.authority.key();
        if signer != ctx.accounts.config.authority {
            let delegate =
                rules_of(&ctx.accounts.config.to_account_info())?.and_then(|r| r.lock_delegate);
            require!(delegate == Some(signer), GateError::Unauthorized);
        }
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

    /// Sets (or clears) the SAS credential and schema that entitle wallets to passes.
    pub fn set_sas_requirement(
        ctx: Context<AuthorityOnly>,
        sas: Option<SasRequirement>,
    ) -> Result<()> {
        require_legacy_path(&ctx.accounts.config.to_account_info())?;
        ctx.accounts.config.sas = sas;
        emit!(SasRequirementChanged {
            mint: ctx.accounts.config.mint,
            sas
        });
        Ok(())
    }

    /// Self-service pass: anyone may submit a wallet's SAS attestation; if it was issued under the
    /// gate's credential and schema for that wallet and has not expired, the wallet gets a pass.
    pub fn claim_pass(ctx: Context<ClaimPass>) -> Result<()> {
        require_legacy_path(&ctx.accounts.config.to_account_info())?;
        let req = ctx.accounts.config.sas.ok_or(GateError::SasNotConfigured)?;
        let owner = ctx.accounts.owner.key();
        require!(
            sas::attestation_valid(
                &ctx.accounts.attestation,
                &req,
                &owner,
                Clock::get()?.unix_timestamp
            )?,
            GateError::AttestationInvalid
        );
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

    /// Anyone may revoke a pass whose SAS attestation has expired or been closed. The rent goes
    /// back to the pass owner. Passes granted directly by the authority are unaffected unless the
    /// gate requires SAS and the owner has no valid attestation.
    pub fn revoke_unattested(ctx: Context<RevokeUnattested>) -> Result<()> {
        require_legacy_path(&ctx.accounts.config.to_account_info())?;
        let req = ctx.accounts.config.sas.ok_or(GateError::SasNotConfigured)?;
        let owner = ctx.accounts.pass.owner;
        require!(
            !sas::attestation_valid(
                &ctx.accounts.attestation,
                &req,
                &owner,
                Clock::get()?.unix_timestamp
            )?,
            GateError::AttestationStillValid
        );
        emit!(PassChanged {
            mint: ctx.accounts.pass.mint,
            owner,
            granted: false
        });
        Ok(())
    }

    /// Sets (or clears) the allowlist Merkle root.
    pub fn set_allowlist_root(ctx: Context<AuthorityOnly>, root: Option<[u8; 32]>) -> Result<()> {
        require_legacy_path(&ctx.accounts.config.to_account_info())?;
        ctx.accounts.config.allowlist_root = root;
        emit!(AllowlistRootChanged {
            mint: ctx.accounts.config.mint,
            root
        });
        Ok(())
    }

    /// Self-service pass from an allowlist: anyone may submit the proof for a wallet.
    pub fn claim_pass_merkle(ctx: Context<ClaimPassMerkle>, proof: Vec<[u8; 32]>) -> Result<()> {
        require_legacy_path(&ctx.accounts.config.to_account_info())?;
        let root = ctx
            .accounts
            .config
            .allowlist_root
            .ok_or(GateError::AllowlistNotConfigured)?;
        let owner = ctx.accounts.owner.key();
        let mint = ctx.accounts.config.mint;
        require!(
            merkle::verify(&proof, &root, &merkle::leaf(&mint, &owner)),
            GateError::NotOnAllowlist
        );
        let pass = &mut ctx.accounts.pass;
        pass.mint = mint;
        pass.owner = owner;
        pass.bump = ctx.bumps.pass;
        emit!(PassChanged {
            mint,
            owner,
            granted: true
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

    // ------------------------------------------------------------------ rules (ADR-0900)

    /// Switches the gate to compliance rules and reallocates the config account to hold them.
    /// `rules.passes` is the number of live passes issued before the rules existed.
    pub fn init_rules(ctx: Context<InitRules>, rules: Rules) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        require!(!rules_active(&info), GateError::RulesAlreadyActive);
        rules.validate()?;
        store_rules(&info, &rules)?;
        emit!(RulesChanged {
            mint: ctx.accounts.config.mint,
            rules
        });
        Ok(())
    }

    /// Replaces the rules. The live-pass counter is kept; everything else is the authority's.
    pub fn set_rules(ctx: Context<AuthorityOnly>, rules: Rules) -> Result<()> {
        let mut rules = rules;
        let info = ctx.accounts.config.to_account_info();
        let current = rules_of(&info)?.ok_or(GateError::RulesNotActive)?;
        rules.validate()?;
        rules.passes = current.passes;
        store_rules(&info, &rules)?;
        emit!(RulesChanged {
            mint: ctx.accounts.config.mint,
            rules
        });
        Ok(())
    }

    /// Self-service pass from an issuer-signed identity attestation (`oc-identity` v1) and,
    /// when the gate has an accreditation attester, an accreditation attestation. Anyone may
    /// submit a wallet's attestations; the terms come from the attestation, not the caller.
    pub fn claim_pass_attested(ctx: Context<ClaimPassAttested>, identity: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mint = ctx.accounts.config.mint;
        let owner = ctx.accounts.owner.key();
        let config = ctx.accounts.config.to_account_info();
        let mut rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        let accreditation = ctx
            .accounts
            .accreditation_attestation
            .as_ref()
            .map(|a| a.to_account_info());
        let args = attested_terms(
            &rules,
            &ctx.accounts.identity_attestation,
            accreditation.as_ref(),
            &owner,
            now,
        )?;
        require!(args.identity == identity, GateError::IdentityMismatch);
        let bumps = ctx.bumps;
        let a = &mut *ctx.accounts;
        let payer = a.payer.to_account_info();
        let system = a.system_program.to_account_info();
        let denied = a.denied.to_account_info();
        let previous = a.previous_pass.to_account_info();
        let volume = a.volume.to_account_info();
        let pass_info = a.pass.to_account_info();
        let terms_info = a.terms.to_account_info();
        let binding_info = a.binding.to_account_info();
        issue(
            Issuance {
                mint,
                owner,
                config: &config,
                payer: &payer,
                system_program: &system,
                denied: &denied,
                previous_pass: &previous,
                volume: &volume,
                pass: &pass_info,
                terms: &terms_info,
                binding: &binding_info,
                bumps: IssueBumps {
                    pass: bumps.pass,
                    terms: bumps.terms,
                    binding: bumps.binding,
                    volume: bumps.volume,
                },
            },
            &mut rules,
            args,
            SOURCE_SAS,
            now,
        )
    }

    /// Self-service pass from a terms-bearing allowlist: anyone may submit the proof.
    pub fn claim_pass_merkle_terms(
        ctx: Context<ClaimPassMerkleTerms>,
        args: TermsData,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mint = ctx.accounts.config.mint;
        let owner = ctx.accounts.owner.key();
        let config = ctx.accounts.config.to_account_info();
        let mut rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        let root = rules
            .allowlist_root
            .ok_or(GateError::AllowlistNotConfigured)?;
        args.validate()?;
        require!(
            merkle::verify(&proof, &root, &rules::terms_leaf(&mint, &owner, &args)),
            GateError::NotOnAllowlist
        );
        let bumps = ctx.bumps;
        let a = &mut *ctx.accounts;
        let payer = a.payer.to_account_info();
        let system = a.system_program.to_account_info();
        let denied = a.denied.to_account_info();
        let previous = a.previous_pass.to_account_info();
        let volume = a.volume.to_account_info();
        let pass_info = a.pass.to_account_info();
        let terms_info = a.terms.to_account_info();
        let binding_info = a.binding.to_account_info();
        issue(
            Issuance {
                mint,
                owner,
                config: &config,
                payer: &payer,
                system_program: &system,
                denied: &denied,
                previous_pass: &previous,
                volume: &volume,
                pass: &pass_info,
                terms: &terms_info,
                binding: &binding_info,
                bumps: IssueBumps {
                    pass: bumps.pass,
                    terms: bumps.terms,
                    binding: bumps.binding,
                    volume: bumps.volume,
                },
            },
            &mut rules,
            args,
            SOURCE_MERKLE,
            now,
        )
    }

    /// The authority grants a pass with terms. The same issuance rules apply: an authority
    /// cannot violate its own rules without publicly changing them.
    pub fn grant_pass_terms(
        ctx: Context<GrantPassTerms>,
        owner: Pubkey,
        args: TermsData,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mint = ctx.accounts.config.mint;
        let config = ctx.accounts.config.to_account_info();
        let mut rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        let bumps = ctx.bumps;
        let a = &mut *ctx.accounts;
        let payer = a.authority.to_account_info();
        let system = a.system_program.to_account_info();
        let denied = a.denied.to_account_info();
        let previous = a.previous_pass.to_account_info();
        let volume = a.volume.to_account_info();
        let pass_info = a.pass.to_account_info();
        let terms_info = a.terms.to_account_info();
        let binding_info = a.binding.to_account_info();
        issue(
            Issuance {
                mint,
                owner,
                config: &config,
                payer: &payer,
                system_program: &system,
                denied: &denied,
                previous_pass: &previous,
                volume: &volume,
                pass: &pass_info,
                terms: &terms_info,
                binding: &binding_info,
                bumps: IssueBumps {
                    pass: bumps.pass,
                    terms: bumps.terms,
                    binding: bumps.binding,
                    volume: bumps.volume,
                },
            },
            &mut rules,
            args,
            SOURCE_AUTHORITY,
            now,
        )
    }

    /// Anyone re-reads a wallet's attestations and updates its terms in place (a changed tier,
    /// cap or expiry). The identity cannot change, and the new terms must satisfy the rules.
    pub fn refresh_terms(ctx: Context<RefreshTerms>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = ctx.accounts.config.to_account_info();
        let rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        require!(
            ctx.accounts.terms.source == SOURCE_SAS,
            GateError::NotAttestedPass
        );
        let owner = ctx.accounts.terms.owner;
        let accreditation = ctx
            .accounts
            .accreditation_attestation
            .as_ref()
            .map(|a| a.to_account_info());
        let args = attested_terms(
            &rules,
            &ctx.accounts.identity_attestation,
            accreditation.as_ref(),
            &owner,
            now,
        )?;
        let terms = &mut ctx.accounts.terms;
        require!(args.identity == terms.identity, GateError::IdentityMismatch);
        args.validate()?;
        require!(
            args.expires_ts == 0 || args.expires_ts > now,
            GateError::TermsExpired
        );
        rules.conforms(&args)?;
        terms.country = args.country;
        terms.tier = args.tier;
        terms.flags = args.flags;
        terms.cap = args.cap;
        terms.expires_ts = args.expires_ts;
        emit!(TermsRefreshed {
            mint: terms.mint,
            owner,
            country: terms.country,
            tier: terms.tier,
            flags: terms.flags,
            cap: terms.cap,
            expires_ts: terms.expires_ts
        });
        Ok(())
    }

    /// The authority closes a pass with whatever hangs off it (terms, identity binding, volume).
    /// Also revokes passes issued before the rules existed (their terms account does not exist).
    pub fn revoke_pass_terms(ctx: Context<RevokePassTerms>) -> Result<()> {
        let config = ctx.accounts.config.to_account_info();
        let mut rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        let owner = ctx.accounts.owner.to_account_info();
        close_bundle(
            &config,
            &mut rules,
            &ctx.accounts.config.mint,
            &owner,
            &ctx.accounts.terms.to_account_info(),
            &ctx.accounts.binding.to_account_info(),
            &ctx.accounts.volume.to_account_info(),
        )?;
        emit!(PassClosed {
            mint: ctx.accounts.config.mint,
            owner: owner.key(),
            reason: CLOSE_AUTHORITY
        });
        Ok(())
    }

    /// Anyone closes a pass whose terms have expired, or whose SAS attestation no longer holds.
    pub fn revoke_expired(ctx: Context<RevokeByTerms>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = ctx.accounts.config.to_account_info();
        let mut rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        let t = &ctx.accounts.terms;
        let lapsed = t.expires_ts != 0 && now >= t.expires_ts;
        let attestation_gone = t.source == SOURCE_SAS
            && match rules.identity {
                Some(req) => !sas_attestation::is_valid(
                    &ctx.accounts.identity_attestation,
                    &req.credential,
                    &req.schema,
                    &t.owner,
                    now,
                )
                .ok_or(GateError::AttestationInvalid)?,
                None => false,
            };
        require!(lapsed || attestation_gone, GateError::NotExpired);
        let reason = if lapsed {
            CLOSE_EXPIRED
        } else {
            CLOSE_ATTESTATION_GONE
        };
        close_by_terms(&ctx, &mut rules, &config, reason)
    }

    /// Anyone closes a pass whose terms no longer satisfy the current rules.
    pub fn revoke_nonconforming(ctx: Context<RevokeByTerms>) -> Result<()> {
        let config = ctx.accounts.config.to_account_info();
        let mut rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        require!(
            rules.conforms(&ctx.accounts.terms.args()).is_err(),
            GateError::StillConforms
        );
        close_by_terms(&ctx, &mut rules, &config, CLOSE_NONCONFORMING)
    }

    /// Anyone closes the pass of a wallet the compliance officer has denied.
    pub fn revoke_denied(ctx: Context<RevokeByTerms>) -> Result<()> {
        let config = ctx.accounts.config.to_account_info();
        let mut rules = rules_of(&config)?.ok_or(GateError::RulesNotActive)?;
        let denied = &ctx.accounts.denied;
        require!(
            denied.owner == &crate::ID && !denied.data_is_empty(),
            GateError::NotDenied
        );
        close_by_terms(&ctx, &mut rules, &config, CLOSE_DENIED)
    }

    /// Blocks a wallet from obtaining a pass (sanctions hit, court order, issuer decision).
    pub fn deny_wallet(ctx: Context<DenyWallet>, owner: Pubkey, reason: u8) -> Result<()> {
        let d = &mut ctx.accounts.denied;
        d.mint = ctx.accounts.config.mint;
        d.owner = owner;
        d.reason = reason;
        d.since = Clock::get()?.unix_timestamp;
        d.bump = ctx.bumps.denied;
        emit!(WalletDenied {
            mint: d.mint,
            owner,
            reason,
            denied: true
        });
        Ok(())
    }

    /// Lifts a denial.
    pub fn allow_wallet(ctx: Context<AllowWallet>) -> Result<()> {
        emit!(WalletDenied {
            mint: ctx.accounts.denied.mint,
            owner: ctx.accounts.denied.owner,
            reason: ctx.accounts.denied.reason,
            denied: false
        });
        Ok(())
    }

    /// Rewrites the mint's transfer-hook extra-account-meta list to the layout the rules need, which
    /// adds the sender's terms and affiliate volume and the receiver's terms to the three accounts
    /// every list carries. A gate must run it once after `init_rules`: until then the hook refuses
    /// transfers (it fails closed rather than skip the rules). Gates without rules keep the short
    /// list, so clients of existing hooked mints are unaffected.
    pub fn update_hook_metas(ctx: Context<UpdateHookMetas>) -> Result<()> {
        require!(
            hook_program_of(&ctx.accounts.mint.to_account_info())? == Some(crate::ID),
            GateError::WrongHookProgram
        );
        require!(
            rules_active(&ctx.accounts.config.to_account_info()),
            GateError::RulesNotActive
        );
        let metas = hook_rules_metas()?;
        let size = ExtraAccountMetaList::size_of(metas.len())?;
        let info = ctx.accounts.extra_metas.to_account_info();
        let want = Rent::get()?.minimum_balance(size);
        if info.lamports() < want {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: info.clone(),
                    },
                ),
                want.saturating_sub(info.lamports()),
            )?;
        }
        if info.data_len() < size {
            info.resize(size)?;
        }
        let mut data = info.try_borrow_mut_data()?;
        ExtraAccountMetaList::update::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    /// Opens the affiliate-volume account of a wallet whose terms carry the affiliate flag. Anyone
    /// may pay for it. `issue` opens it with the pass, so this is for a wallet that became an
    /// affiliate afterwards (a refreshed attestation) or for a gate that switched the volume limit
    /// on after the pass was issued; until it exists such a wallet cannot transfer.
    pub fn open_volume(ctx: Context<OpenVolume>) -> Result<()> {
        let rules = rules_of(&ctx.accounts.config.to_account_info())?
            .ok_or(GateError::RulesNotActive)?;
        require!(rules.affiliate_limit.is_some(), GateError::NoVolumeLimit);
        let terms = &ctx.accounts.terms;
        require!(terms.flags & FLAG_AFFILIATE != 0, GateError::NotAffiliate);
        init_volume(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.volume.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &terms.mint,
            &terms.owner,
            ctx.bumps.volume,
        )
    }

    // ---------------------------------------------- hooks for cross_core (CPI, ADR-0900 s5)

    /// Reserves `amount` quote atoms of a wallet's per-identity allocation in `cross`. Only the
    /// cross program can sign for the `cross` account. A gate with no cap for these terms
    /// reserves nothing and succeeds.
    pub fn reserve_allocation(ctx: Context<ReserveAllocation>, amount: u64) -> Result<()> {
        let config = ctx.accounts.config.to_account_info();
        read_cross(&ctx.accounts.cross.to_account_info())?;
        let terms = &ctx.accounts.terms;
        let cap = match rules_of(&config)? {
            Some(r) => r.cap_for(terms.cap),
            None => terms.cap,
        };
        if cap == 0 {
            return Ok(());
        }
        let key = allocation_key(terms);
        let cross = ctx.accounts.cross.key();
        let (expected, bump) =
            Pubkey::find_program_address(&[ALLOC_SEED, cross.as_ref(), &key], &crate::ID);
        let alloc_info = ctx.accounts.alloc.to_account_info();
        require_keys_eq!(alloc_info.key(), expected, GateError::WrongAccount);
        if alloc_info.owner != &crate::ID || alloc_info.data_is_empty() {
            let bump_arr = [bump];
            let seeds: &[&[u8]] = &[ALLOC_SEED, cross.as_ref(), &key, &bump_arr];
            create_pda(
                &ctx.accounts.payer.to_account_info(),
                &alloc_info,
                &ctx.accounts.system_program.to_account_info(),
                seeds,
                8 + Allocation::INIT_SPACE,
            )?;
            let fresh = Allocation {
                cross,
                key,
                reserved: 0,
                bump,
            };
            let mut data = alloc_info.try_borrow_mut_data()?;
            fresh.try_serialize(&mut &mut data[..])?;
        }
        let mut data = alloc_info.try_borrow_mut_data()?;
        let mut a = Allocation::try_deserialize(&mut &data[..])?;
        require!(a.cross == cross && a.key == key, GateError::WrongAccount);
        a.reserved = a.reserved.checked_add(amount).ok_or(GateError::Overflow)?;
        require!(a.reserved <= cap, GateError::OverIdentityCap);
        emit!(AllocationChanged {
            cross,
            key,
            reserved: a.reserved,
            cap
        });
        a.try_serialize(&mut &mut data[..])?;
        Ok(())
    }

    /// Returns reserved allocation (a cancel or a refund). It never fails for want of an account
    /// and never fails on arithmetic, so a refund can always be paid.
    pub fn release_allocation(
        ctx: Context<ReleaseAllocation>,
        key: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        read_cross(&ctx.accounts.cross.to_account_info())?;
        let cross = ctx.accounts.cross.key();
        let info = ctx.accounts.alloc.to_account_info();
        let expected =
            Pubkey::find_program_address(&[ALLOC_SEED, cross.as_ref(), &key], &crate::ID).0;
        if info.key() != expected || info.owner != &crate::ID || info.data_is_empty() {
            return Ok(());
        }
        let mut data = info.try_borrow_mut_data()?;
        let mut a = Allocation::try_deserialize(&mut &data[..])?;
        a.reserved = a.reserved.saturating_sub(amount);
        emit!(AllocationChanged {
            cross,
            key,
            reserved: a.reserved,
            cap: 0
        });
        a.try_serialize(&mut &mut data[..])?;
        Ok(())
    }

    /// After a gated cross pays base tokens to `owner`, applies the gate's resale-lock policy:
    /// the received amount is locked for the policy's duration, on top of any lock still active.
    pub fn receive_locked(ctx: Context<ReceiveLocked>, owner: Pubkey, amount: u64) -> Result<()> {
        let config = ctx.accounts.config.to_account_info();
        // Only a cross that sells this very token can lock it: anything else could lock a holder's balance of a
        // token the cross never paid out.
        let sold = read_cross(&ctx.accounts.cross.to_account_info())?;
        let mint = ctx.accounts.config.mint;
        require!(sold == mint, GateError::WrongGate);
        let Some(policy) = rules_of(&config)?.and_then(|r| r.lock_policy) else {
            return Ok(());
        };
        let now = Clock::get()?.unix_timestamp;
        let lock = &mut ctx.accounts.lock;
        let fresh = lock.owner == Pubkey::default();
        let active = !fresh && now < lock.unlock_ts;
        let until = now
            .checked_add(policy.duration_secs)
            .ok_or(GateError::Overflow)?;
        lock.mint = ctx.accounts.config.mint;
        lock.owner = owner;
        lock.amount = if active {
            lock.amount.checked_add(amount).ok_or(GateError::Overflow)?
        } else {
            amount
        };
        lock.unlock_ts = if active {
            lock.unlock_ts.max(until)
        } else {
            until
        };
        lock.bump = ctx.bumps.lock;
        emit!(LockChanged {
            mint: lock.mint,
            owner,
            amount: lock.amount,
            unlock_ts: lock.unlock_ts
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------- rules helpers

pub const CLOSE_AUTHORITY: u8 = 0;
pub const CLOSE_EXPIRED: u8 = 1;
pub const CLOSE_NONCONFORMING: u8 = 2;
pub const CLOSE_DENIED: u8 = 3;
pub const CLOSE_ATTESTATION_GONE: u8 = 4;

/// The rules, if the config account carries an active extension.
pub fn rules_of(config: &AccountInfo) -> Result<Option<Rules>> {
    let data = config.try_borrow_data()?;
    rules::read_rules(&data, EXT_OFFSET)
}

fn rules_active(config: &AccountInfo) -> bool {
    config
        .try_borrow_data()
        .is_ok_and(|d| d.get(EXT_OFFSET) == Some(&rules::EXT_MAGIC))
}

fn store_rules(config: &AccountInfo, rules: &Rules) -> Result<()> {
    let mut data = config.try_borrow_mut_data()?;
    rules::write_rules(&mut data, EXT_OFFSET, rules)
}

/// The original issuance and revocation paths cannot run once rules are active: they do not
/// check the rules, keep the counters or carry terms.
fn require_legacy_path(config: &AccountInfo) -> Result<()> {
    require!(!rules_active(config), GateError::UseRulesPath);
    Ok(())
}

fn earliest(a: i64, b: i64) -> i64 {
    match (a, b) {
        (0, x) | (x, 0) => x,
        (x, y) => x.min(y),
    }
}

/// Terms from a wallet's attestations. Errors when the identity attestation is missing, foreign,
/// expired or malformed. With a separate accreditation attester, only that attestation can set
/// the accredited flag.
fn attested_terms(
    rules: &Rules,
    identity_attestation: &AccountInfo,
    accreditation_attestation: Option<&AccountInfo>,
    owner: &Pubkey,
    now: i64,
) -> Result<TermsData> {
    let req = rules.identity.ok_or(GateError::SasNotConfigured)?;
    let live = attest::read_valid(
        identity_attestation,
        &req.credential,
        &req.schema,
        owner,
        now,
    )
    .ok_or(GateError::AttestationInvalid)?
    .ok_or(GateError::AttestationInvalid)?;
    let mut t =
        rules::parse_identity_data(&live.data, live.expiry).ok_or(GateError::BadAttestationData)?;
    if let Some(acc) = rules.accreditation {
        t.flags &= !FLAG_ACCREDITED;
        if let Some(info) = accreditation_attestation {
            if let Some(a) =
                attest::read_valid(info, &acc.credential, &acc.schema, owner, now)
                    .ok_or(GateError::AttestationInvalid)?
            {
                t.flags |= FLAG_ACCREDITED;
                t.expires_ts = earliest(t.expires_ts, a.expiry);
            }
        }
    }
    Ok(t)
}

/// The base mint of a genuine `Cross`: an account owned by `cross_core` that carries its account discriminator. Anyone
/// can assign a keypair account they hold to `cross_core` and sign with it, but only `cross_core` can write a
/// discriminator into one of its accounts, so a signer that passes this check is a cross that `cross_core` created.
fn read_cross(info: &AccountInfo) -> Result<Pubkey> {
    require!(info.owner == &CROSS_CORE_PROGRAM_ID, GateError::NotCross);
    let d = info.try_borrow_data()?;
    let disc = solana_sha256_hasher::hashv(&[b"account:Cross"]).to_bytes();
    require!(
        d.len() >= CROSS_MIN_LEN && d.get(..8) == disc.get(..8),
        GateError::NotCross
    );
    let bytes: [u8; 32] = d
        .get(CROSS_BASE_MINT_OFFSET..CROSS_MIN_LEN)
        .and_then(|b| b.try_into().ok())
        .ok_or(GateError::NotCross)?;
    Ok(Pubkey::new_from_array(bytes))
}

fn allocation_key(t: &Terms) -> [u8; 32] {
    if t.identity == [0u8; 32] {
        t.owner.to_bytes()
    } else {
        t.identity
    }
}

struct IssueBumps {
    pass: u8,
    terms: u8,
    binding: u8,
    volume: u8,
}

struct Issuance<'a, 'info> {
    mint: Pubkey,
    owner: Pubkey,
    config: &'a AccountInfo<'info>,
    payer: &'a AccountInfo<'info>,
    system_program: &'a AccountInfo<'info>,
    denied: &'a AccountInfo<'info>,
    previous_pass: &'a AccountInfo<'info>,
    volume: &'a AccountInfo<'info>,
    pass: &'a AccountInfo<'info>,
    terms: &'a AccountInfo<'info>,
    binding: &'a AccountInfo<'info>,
    bumps: IssueBumps,
}

/// The single issuance path for every way of getting a pass under rules.
fn issue(
    a: Issuance<'_, '_>,
    rules: &mut Rules,
    args: TermsData,
    source: u8,
    now: i64,
) -> Result<()> {
    args.validate()?;
    require!(
        a.denied.owner != &crate::ID || a.denied.data_is_empty(),
        GateError::WalletDenied
    );
    require!(
        rules.issuance_start == 0 || now >= rules.issuance_start,
        GateError::IssuanceNotOpen
    );
    require!(
        rules.issuance_end == 0 || now < rules.issuance_end,
        GateError::IssuanceClosed
    );
    require!(
        args.expires_ts == 0 || args.expires_ts > now,
        GateError::TermsExpired
    );
    rules.conforms(&args)?;
    require!(
        rules.max_passes == 0 || rules.passes < rules.max_passes,
        GateError::HolderCapReached
    );

    if args.has_identity() {
        let current = read_binding(a.binding)?;
        if let Some(b) = &current {
            let held_by_other = b.wallet != a.owner;
            if held_by_other && rules.one_identity_one_pass {
                // The wallet that held this identity must have lost its pass.
                let previous = Pubkey::find_program_address(
                    &[PASS_SEED, a.mint.as_ref(), b.wallet.as_ref()],
                    &crate::ID,
                )
                .0;
                require_keys_eq!(
                    a.previous_pass.key(),
                    previous,
                    GateError::WrongPreviousPass
                );
                require!(
                    a.previous_pass.owner != &crate::ID || a.previous_pass.data_is_empty(),
                    GateError::IdentityAlreadyBound
                );
            }
        }
        let bump = [a.bumps.binding];
        write_account(
            a.payer,
            a.binding,
            a.system_program,
            &[
                IDENTITY_SEED,
                a.mint.as_ref(),
                args.identity.as_ref(),
                &bump,
            ],
            &IdentityBinding {
                mint: a.mint,
                identity: args.identity,
                wallet: a.owner,
                bump: a.bumps.binding,
            },
        )?;
    }

    // A wallet holds one pass: an existing pass account is an error, not an overwrite.
    require!(
        a.pass.owner != &crate::ID || a.pass.data_is_empty(),
        GateError::PassExists
    );
    let bump = [a.bumps.pass];
    write_account(
        a.payer,
        a.pass,
        a.system_program,
        &[PASS_SEED, a.mint.as_ref(), a.owner.as_ref(), &bump],
        &Pass {
            mint: a.mint,
            owner: a.owner,
            bump: a.bumps.pass,
        },
    )?;
    let bump = [a.bumps.terms];
    write_account(
        a.payer,
        a.terms,
        a.system_program,
        &[TERMS_SEED, a.mint.as_ref(), a.owner.as_ref(), &bump],
        &Terms {
            mint: a.mint,
            owner: a.owner,
            identity: args.identity,
            country: args.country,
            tier: args.tier,
            flags: args.flags,
            cap: args.cap,
            source,
            issued_ts: now,
            expires_ts: args.expires_ts,
            bump: a.bumps.terms,
        },
    )?;

    if args.flags & FLAG_AFFILIATE != 0 && rules.affiliate_limit.is_some() {
        init_volume(
            a.payer,
            a.volume,
            a.system_program,
            &a.mint,
            &a.owner,
            a.bumps.volume,
        )?;
    }

    rules.passes = rules.passes.checked_add(1).ok_or(GateError::Overflow)?;
    store_rules(a.config, rules)?;
    emit!(PassChanged {
        mint: a.mint,
        owner: a.owner,
        granted: true
    });
    emit!(PassIssued {
        mint: a.mint,
        owner: a.owner,
        identity: args.identity,
        country: args.country,
        tier: args.tier,
        flags: args.flags,
        cap: args.cap,
        expires_ts: args.expires_ts,
        source
    });
    Ok(())
}

fn close_by_terms<'info>(
    ctx: &Context<RevokeByTerms<'info>>,
    rules: &mut Rules,
    config: &AccountInfo<'info>,
    reason: u8,
) -> Result<()> {
    close_bundle(
        config,
        rules,
        &ctx.accounts.config.mint,
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.terms.to_account_info(),
        &ctx.accounts.binding.to_account_info(),
        &ctx.accounts.volume.to_account_info(),
    )?;
    emit!(PassClosed {
        mint: ctx.accounts.config.mint,
        owner: ctx.accounts.owner.key(),
        reason
    });
    Ok(())
}

/// Closes everything that hangs off a pass except the pass itself (Anchor closes that through its
/// `close` constraint): the terms, the identity binding if it still points at this wallet and the
/// affiliate volume. Returns the rent to `owner` and decrements the live-pass counter. The terms
/// account may be empty for a pass issued before the rules existed.
fn close_bundle<'info>(
    config: &AccountInfo<'info>,
    rules: &mut Rules,
    mint: &Pubkey,
    owner: &AccountInfo<'info>,
    terms: &AccountInfo<'info>,
    binding: &AccountInfo<'info>,
    volume: &AccountInfo<'info>,
) -> Result<()> {
    if terms.owner == &crate::ID && !terms.data_is_empty() {
        let t = Terms::try_deserialize(&mut &terms.try_borrow_data()?[..])?;
        require!(
            &t.mint == mint && t.owner == owner.key(),
            GateError::WrongAccount
        );
        if t.identity != [0u8; 32] {
            let expected = Pubkey::find_program_address(
                &[IDENTITY_SEED, mint.as_ref(), t.identity.as_ref()],
                &crate::ID,
            )
            .0;
            if binding.key() == expected && binding.owner == &crate::ID && !binding.data_is_empty()
            {
                let b = IdentityBinding::try_deserialize(&mut &binding.try_borrow_data()?[..])?;
                if b.wallet == owner.key() {
                    close_to(binding, owner)?;
                }
            }
        }
        close_to(terms, owner)?;
    }
    let vol = Pubkey::find_program_address(
        &[VOLUME_SEED, mint.as_ref(), owner.key().as_ref()],
        &crate::ID,
    )
    .0;
    if volume.key() == vol && volume.owner == &crate::ID && !volume.data_is_empty() {
        close_to(volume, owner)?;
    }
    rules.passes = rules.passes.saturating_sub(1);
    store_rules(config, rules)
}

/// Moves all lamports of a program-owned account to `dest` and empties it.
fn close_to<'info>(info: &AccountInfo<'info>, dest: &AccountInfo<'info>) -> Result<()> {
    let lamports = info.lamports();
    let total = dest
        .lamports()
        .checked_add(lamports)
        .ok_or(GateError::Overflow)?;
    **dest.try_borrow_mut_lamports()? = total;
    **info.try_borrow_mut_lamports()? = 0;
    info.resize(0)?;
    info.assign(&anchor_lang::solana_program::system_program::ID);
    Ok(())
}

/// Writes `value` (with its Anchor discriminator) into the PDA at `info`, creating the account
/// first if it does not exist. One shared copy of the account-creation code keeps the program
/// small; Anchor's `init` would expand it into every instruction that creates a pass.
fn write_account<'info, T: AccountSerialize + Space>(
    payer: &AccountInfo<'info>,
    info: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
    value: &T,
) -> Result<()> {
    if info.owner != &crate::ID || info.data_is_empty() {
        create_pda(payer, info, system, seeds, 8 + T::INIT_SPACE)?;
    }
    let mut data = info.try_borrow_mut_data()?;
    value.try_serialize(&mut &mut data[..])
}

fn read_binding(info: &AccountInfo) -> Result<Option<IdentityBinding>> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    Ok(Some(IdentityBinding::try_deserialize(
        &mut &info.try_borrow_data()?[..],
    )?))
}

/// Creates a PDA account, tolerating lamports someone pre-sent to its address.
fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
    space: usize,
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    let space64 = u64::try_from(space).map_err(|_| GateError::Overflow)?;
    let signer: &[&[&[u8]]] = &[seeds];
    if target.lamports() == 0 {
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                system.key(),
                anchor_lang::system_program::CreateAccount {
                    from: payer.clone(),
                    to: target.clone(),
                },
                signer,
            ),
            rent,
            space64,
            &crate::ID,
        )
    } else {
        let need = rent.saturating_sub(target.lamports());
        if need > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    system.key(),
                    anchor_lang::system_program::Transfer {
                        from: payer.clone(),
                        to: target.clone(),
                    },
                ),
                need,
            )?;
        }
        anchor_lang::system_program::allocate(
            CpiContext::new_with_signer(
                system.key(),
                anchor_lang::system_program::Allocate {
                    account_to_allocate: target.clone(),
                },
                signer,
            ),
            space64,
        )?;
        anchor_lang::system_program::assign(
            CpiContext::new_with_signer(
                system.key(),
                anchor_lang::system_program::Assign {
                    account_to_assign: target.clone(),
                },
                signer,
            ),
            &crate::ID,
        )
    }
}

fn init_volume<'info>(
    payer: &AccountInfo<'info>,
    volume: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    mint: &Pubkey,
    owner: &Pubkey,
    bump: u8,
) -> Result<()> {
    if volume.owner == &crate::ID && !volume.data_is_empty() {
        return Ok(());
    }
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[VOLUME_SEED, mint.as_ref(), owner.as_ref(), &bump_arr];
    create_pda(payer, volume, system, seeds, 8 + Volume::INIT_SPACE)?;
    let v = Volume {
        mint: *mint,
        owner: *owner,
        window_start: 0,
        sold: 0,
        bump,
    };
    let mut data = volume.try_borrow_mut_data()?;
    v.try_serialize(&mut &mut data[..])?;
    Ok(())
}

/// Transfer-time rules, in the order the hook meta list carries the accounts after the lock:
/// the source wallet's terms, the source wallet's affiliate volume, the receiver's terms.
///
/// - **Receiver.** If the receiver's pass carries terms they must not have lapsed and must still
///   satisfy the current country, tier and flag rules. A rule change therefore takes effect on the
///   next transfer, not only when someone closes the pass with `revoke_nonconforming`. A pass issued
///   before the rules existed has no terms and is left alone until the authority revokes it.
/// - **Sender.** Wallets flagged as affiliates may not transfer inside a blackout window and may not
///   sell more than the volume limit in a window.
///
/// Fails closed: once rules are active a hook list that predates them (it stops after the lock)
/// refuses transfers until the authority runs `update_hook_metas`.
fn enforce_transfer_rules(
    rules: &Rules,
    mint: &Pubkey,
    source_owner: &Pubkey,
    destination_owner: &Pubkey,
    amount: u64,
    remaining: &[AccountInfo],
) -> Result<()> {
    let (Some(source_terms), Some(volume_info), Some(destination_terms)) =
        (remaining.first(), remaining.get(1), remaining.get(2))
    else {
        return err!(GateError::RulesAccountsMissing);
    };
    let now = Clock::get()?.unix_timestamp;
    if let Some(t) = read_terms(destination_terms, mint, destination_owner)? {
        require!(
            t.expires_ts == 0 || t.expires_ts > now,
            GateError::TermsExpired
        );
        rules.conforms(&t.args())?;
    }
    if !rules.has_transfer_rules() {
        return Ok(());
    }
    let Some(terms) = read_terms(source_terms, mint, source_owner)? else {
        return Ok(()); // a wallet with no terms is not an affiliate
    };
    if terms.flags & FLAG_AFFILIATE == 0 {
        return Ok(());
    }
    for w in &rules.blackouts {
        require!(!w.contains(now), GateError::Blackout);
    }
    if let Some(limit) = rules.affiliate_limit {
        update_volume(volume_info, mint, source_owner, &limit, amount, now)?;
    }
    Ok(())
}

fn read_terms(info: &AccountInfo, mint: &Pubkey, owner: &Pubkey) -> Result<Option<Terms>> {
    if info.owner != &crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    let t = Terms::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    Ok((&t.mint == mint && &t.owner == owner).then_some(t))
}

fn update_volume(
    info: &AccountInfo,
    mint: &Pubkey,
    owner: &Pubkey,
    limit: &AffiliateLimit,
    amount: u64,
    now: i64,
) -> Result<()> {
    require!(
        info.owner == &crate::ID && !info.data_is_empty() && info.is_writable,
        GateError::VolumeMissing
    );
    let mut data = info.try_borrow_mut_data()?;
    let mut v = Volume::try_deserialize(&mut &data[..])?;
    require!(
        &v.mint == mint && &v.owner == owner,
        GateError::VolumeMissing
    );
    let window_end = v
        .window_start
        .checked_add(limit.window_secs)
        .ok_or(GateError::Overflow)?;
    if now >= window_end {
        v.window_start = now;
        v.sold = 0;
    }
    v.sold = v.sold.checked_add(amount).ok_or(GateError::Overflow)?;
    require!(v.sold <= limit.max_amount, GateError::VolumeLimit);
    v.try_serialize(&mut &mut data[..])?;
    Ok(())
}

fn hook_owner_of(account_index: u8) -> Seed {
    Seed::AccountData {
        account_index,
        data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
        length: 32,
    }
}

/// Transfer-hook extras after the 4 standard accounts and the meta list:
/// gate config, destination owner's pass, source owner's lock. This is the list `init_hook_metas`
/// writes and the one every client of a gate without rules passes.
pub fn hook_extra_metas() -> Result<Vec<ExtraAccountMeta>> {
    let owner_of = hook_owner_of;
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

/// The list for a gate with rules (ADR-0900): the three accounts above, then the sender's terms,
/// the sender's affiliate volume (writable) and the receiver's terms.
pub fn hook_rules_metas() -> Result<Vec<ExtraAccountMeta>> {
    let mint = Seed::AccountKey { index: 1 };
    let mut metas = hook_extra_metas()?;
    metas.push(ExtraAccountMeta::new_with_seeds(
        &[literal(TERMS_SEED), mint.clone(), hook_owner_of(0)],
        false,
        false,
    )?);
    metas.push(ExtraAccountMeta::new_with_seeds(
        &[literal(VOLUME_SEED), mint.clone(), hook_owner_of(0)],
        false,
        true,
    )?);
    metas.push(ExtraAccountMeta::new_with_seeds(
        &[literal(TERMS_SEED), mint, hook_owner_of(2)],
        false,
        false,
    )?);
    Ok(metas)
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
    /// Solana Attestation Service credential and schema whose attestations entitle a wallet to a
    /// pass (`claim_pass`). `None` disables self-service passes.
    pub sas: Option<SasRequirement>,
    /// Merkle root of an allowlist; leaves are `sha256(0x00 ‖ mint ‖ owner)` (`claim_pass_merkle`).
    pub allowlist_root: Option<[u8; 32]>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct SasRequirement {
    pub credential: Pubkey,
    pub schema: Pubkey,
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
    /// The gate authority or the rules' lock delegate; checked in the handler.
    #[account(mut)]
    pub authority: Signer<'info>,
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

#[derive(Accounts)]
pub struct ClaimPass<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the wallet receiving the pass; bound to the attestation's nonce.
    pub owner: UncheckedAccount<'info>,
    pub config: Account<'info, GateConfig>,
    /// CHECK: SAS attestation; owner, address and contents checked in `sas::attestation_valid`.
    pub attestation: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Pass::INIT_SPACE, seeds = [PASS_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub pass: Account<'info, Pass>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeUnattested<'info> {
    pub config: Account<'info, GateConfig>,
    /// CHECK: the pass owner's SAS attestation address (may be closed); checked in the handler.
    pub attestation: UncheckedAccount<'info>,
    /// CHECK: receives the pass rent; bound to the pass by constraint.
    #[account(mut, address = pass.owner @ GateError::Unauthorized)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, close = owner, constraint = pass.mint == config.mint @ GateError::Unauthorized)]
    pub pass: Account<'info, Pass>,
}

#[derive(Accounts)]
pub struct ClaimPassMerkle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the wallet receiving the pass; bound by the Merkle leaf.
    pub owner: UncheckedAccount<'info>,
    pub config: Account<'info, GateConfig>,
    #[account(init, payer = payer, space = 8 + Pass::INIT_SPACE, seeds = [PASS_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub pass: Account<'info, Pass>,
    pub system_program: Program<'info, System>,
}

/// Sorted-pair SHA-256 Merkle tree. Leaves are domain-separated from inner nodes (`0x00` vs
/// `0x01` prefix) so an inner node can never be presented as a leaf.
pub mod merkle {
    use super::*;

    pub fn leaf(mint: &Pubkey, owner: &Pubkey) -> [u8; 32] {
        solana_sha256_hasher::hashv(&[&[0u8], mint.as_ref(), owner.as_ref()]).to_bytes()
    }

    pub fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let (l, r) = if a <= b { (a, b) } else { (b, a) };
        solana_sha256_hasher::hashv(&[&[1u8], l, r]).to_bytes()
    }

    pub fn verify(proof: &[[u8; 32]], root: &[u8; 32], leaf: &[u8; 32]) -> bool {
        proof.len() <= 32 && proof.iter().fold(*leaf, |acc, p| node(&acc, p)) == *root
    }
}

/// Solana Attestation Service account checks (layout from solana-attestation-service
/// `program/src/state/attestation.rs`, MIT).
pub mod sas {
    use super::*;
    pub use sas_attestation::{parse, SAS_PROGRAM_ID};

    /// `true` if `info` is the SAS attestation `[attestation, credential, schema, owner]`, owned
    /// by SAS, with matching fields and not expired (`expiry == 0` never expires). A missing,
    /// closed or foreign account is simply invalid; the wrong address is an error.
    pub fn attestation_valid(
        info: &UncheckedAccount,
        req: &SasRequirement,
        owner: &Pubkey,
        now: i64,
    ) -> Result<bool> {
        sas_attestation::is_valid(info, &req.credential, &req.schema, owner, now)
            .ok_or_else(|| error!(GateError::AttestationInvalid))
    }
}

#[event]
pub struct AllowlistRootChanged {
    pub mint: Pubkey,
    pub root: Option<[u8; 32]>,
}

#[event]
pub struct SasRequirementChanged {
    pub mint: Pubkey,
    pub sas: Option<SasRequirement>,
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
    #[msg("This gate has no allowlist")]
    AllowlistNotConfigured,
    #[msg("Proof does not place this wallet on the allowlist")]
    NotOnAllowlist,
    #[msg("This gate does not accept SAS attestations")]
    SasNotConfigured,
    #[msg("Attestation is missing, foreign, expired or not for this wallet")]
    AttestationInvalid,
    #[msg("Attestation is still valid")]
    AttestationStillValid,
    #[msg("Owner holds a pass; permissionless freeze is not allowed")]
    OwnerAllowed,
    #[msg("This gate has compliance rules: use the terms-bearing instructions")]
    UseRulesPath,
    #[msg("Compliance rules are already active on this gate")]
    RulesAlreadyActive,
    #[msg("This gate has no compliance rules")]
    RulesNotActive,
    #[msg("The rules are malformed")]
    BadRules,
    #[msg("The terms are malformed")]
    BadTerms,
    #[msg("The wallet's country is unknown, so it cannot satisfy a country list")]
    CountryUnknown,
    #[msg("The wallet's country is not allowed for this token")]
    CountryNotAllowed,
    #[msg("The wallet's tier is below the minimum for this token")]
    TierTooLow,
    #[msg("The wallet lacks a flag this token requires")]
    MissingFlags,
    #[msg("The investor cap for this token has been reached")]
    HolderCapReached,
    #[msg("Passes cannot be issued yet")]
    IssuanceNotOpen,
    #[msg("Passes can no longer be issued")]
    IssuanceClosed,
    #[msg("The terms have already expired")]
    TermsExpired,
    #[msg("This wallet is denied")]
    WalletDenied,
    #[msg("This identity already holds a live pass on another wallet")]
    IdentityAlreadyBound,
    #[msg("The previous holder's pass account is not the one for this identity")]
    WrongPreviousPass,
    #[msg("The identity does not match the attestation")]
    IdentityMismatch,
    #[msg("The attestation data is not an identity record")]
    BadAttestationData,
    #[msg("Only an attested pass can be refreshed")]
    NotAttestedPass,
    #[msg("The pass has not expired and its attestation still holds")]
    NotExpired,
    #[msg("The terms still satisfy the rules")]
    StillConforms,
    #[msg("The wallet is not denied")]
    NotDenied,
    #[msg("The transfer hook was not given the accounts this gate's transfer rules need")]
    RulesAccountsMissing,
    #[msg("Transfers by this wallet are blocked in this window")]
    Blackout,
    #[msg("This transfer exceeds the wallet's volume limit for the window")]
    VolumeLimit,
    #[msg("The wallet's volume account is missing or wrong")]
    VolumeMissing,
    #[msg("This order would exceed the identity's allocation cap")]
    OverIdentityCap,
    #[msg("Only an account owned by the cross program may call this")]
    NotCross,
    #[msg("The account is not the one this instruction expects")]
    WrongAccount,
    #[msg("This cross does not sell this token")]
    WrongGate,
    #[msg("This wallet already holds a pass")]
    PassExists,
    #[msg("This gate has no affiliate volume limit")]
    NoVolumeLimit,
    #[msg("The wallet's terms do not carry the affiliate flag")]
    NotAffiliate,
    #[msg("Arithmetic overflow")]
    Overflow,
}

// ---------------------------------------------------------------------- rules accounts (ADR-0900)

/// What a pass carries: who the holder is (never PII), where, what tier, which flags, how much it
/// may buy per cross, and when the pass lapses. Created with the pass by the `*_terms` family.
#[account]
#[derive(InitSpace)]
pub struct Terms {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub identity: [u8; 32],
    pub country: u16,
    pub tier: u8,
    pub flags: u8,
    pub cap: u64,
    pub source: u8,
    pub issued_ts: i64,
    pub expires_ts: i64,
    pub bump: u8,
}

impl Terms {
    pub fn args(&self) -> TermsData {
        TermsData {
            identity: self.identity,
            country: self.country,
            tier: self.tier,
            flags: self.flags,
            cap: self.cap,
            expires_ts: self.expires_ts,
        }
    }
}

/// The wallet that currently holds an identity's pass for a mint.
#[account]
#[derive(InitSpace)]
pub struct IdentityBinding {
    pub mint: Pubkey,
    pub identity: [u8; 32],
    pub wallet: Pubkey,
    pub bump: u8,
}

/// Rolling sold amount of an affiliate-flagged wallet.
#[account]
#[derive(InitSpace)]
pub struct Volume {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub window_start: i64,
    pub sold: u64,
    pub bump: u8,
}

/// A wallet the compliance officer has blocked from holding a pass.
#[account]
#[derive(InitSpace)]
pub struct Denied {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub reason: u8,
    pub since: i64,
    pub bump: u8,
}

/// Quote atoms an identity (or, without one, a wallet) has reserved in one cross.
#[account]
#[derive(InitSpace)]
pub struct Allocation {
    pub cross: Pubkey,
    pub key: [u8; 32],
    pub reserved: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitRules<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ GateError::Unauthorized,
        realloc = EXT_OFFSET + Rules::EXT_SIZE,
        realloc::payer = authority,
        realloc::zero = true
    )]
    pub config: Account<'info, GateConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(identity: [u8; 32])]
pub struct ClaimPassAttested<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the wallet receiving the pass; bound to the attestations' nonce.
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: SAS identity attestation; address, owner and contents checked in `attested_terms`.
    pub identity_attestation: UncheckedAccount<'info>,
    /// CHECK: SAS accreditation attestation, when the gate has an accreditation attester.
    pub accreditation_attestation: Option<UncheckedAccount<'info>>,
    /// CHECK: the wallet's denial record (a PDA owned by this program only if denied).
    #[account(seeds = [DENY_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub denied: UncheckedAccount<'info>,
    /// CHECK: the pass PDA, created by `issue`.
    #[account(mut, seeds = [PASS_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub pass: UncheckedAccount<'info>,
    /// CHECK: the terms PDA, created by `issue`.
    #[account(mut, seeds = [TERMS_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: the identity-binding PDA, created or updated by `issue`.
    #[account(mut, seeds = [IDENTITY_SEED, config.mint.as_ref(), identity.as_ref()], bump)]
    pub binding: UncheckedAccount<'info>,
    /// CHECK: the pass of the wallet that held this identity before; inspected only on a takeover.
    pub previous_pass: UncheckedAccount<'info>,
    /// CHECK: the wallet's affiliate-volume PDA; created only for affiliate-flagged wallets.
    #[account(mut, seeds = [VOLUME_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub volume: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: TermsData)]
pub struct ClaimPassMerkleTerms<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the wallet receiving the pass; bound by the Merkle leaf.
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: the wallet's denial record (a PDA owned by this program only if denied).
    #[account(seeds = [DENY_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub denied: UncheckedAccount<'info>,
    /// CHECK: the pass PDA, created by `issue`.
    #[account(mut, seeds = [PASS_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub pass: UncheckedAccount<'info>,
    /// CHECK: the terms PDA, created by `issue`.
    #[account(mut, seeds = [TERMS_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: the identity-binding PDA, created or updated by `issue`.
    #[account(mut, seeds = [IDENTITY_SEED, config.mint.as_ref(), args.identity.as_ref()], bump)]
    pub binding: UncheckedAccount<'info>,
    /// CHECK: the pass of the wallet that held this identity before; inspected only on a takeover.
    pub previous_pass: UncheckedAccount<'info>,
    /// CHECK: the wallet's affiliate-volume PDA; created only for affiliate-flagged wallets.
    #[account(mut, seeds = [VOLUME_SEED, config.mint.as_ref(), owner.key().as_ref()], bump)]
    pub volume: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey, args: TermsData)]
pub struct GrantPassTerms<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: the wallet's denial record (a PDA owned by this program only if denied).
    #[account(seeds = [DENY_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub denied: UncheckedAccount<'info>,
    /// CHECK: the pass PDA, created by `issue`.
    #[account(mut, seeds = [PASS_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub pass: UncheckedAccount<'info>,
    /// CHECK: the terms PDA, created by `issue`.
    #[account(mut, seeds = [TERMS_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: the identity-binding PDA, created or updated by `issue`.
    #[account(mut, seeds = [IDENTITY_SEED, config.mint.as_ref(), args.identity.as_ref()], bump)]
    pub binding: UncheckedAccount<'info>,
    /// CHECK: the pass of the wallet that held this identity before; inspected only on a takeover.
    pub previous_pass: UncheckedAccount<'info>,
    /// CHECK: the wallet's affiliate-volume PDA; created only for affiliate-flagged wallets.
    #[account(mut, seeds = [VOLUME_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub volume: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefreshTerms<'info> {
    pub config: Account<'info, GateConfig>,
    /// CHECK: SAS identity attestation; address, owner and contents checked in `attested_terms`.
    pub identity_attestation: UncheckedAccount<'info>,
    /// CHECK: SAS accreditation attestation, when the gate has an accreditation attester.
    pub accreditation_attestation: Option<UncheckedAccount<'info>>,
    #[account(
        mut,
        seeds = [TERMS_SEED, config.mint.as_ref(), terms.owner.as_ref()],
        bump = terms.bump,
        constraint = terms.mint == config.mint @ GateError::WrongAccount
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts)]
pub struct RevokePassTerms<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: receives the rent; bound to the pass.
    #[account(mut, address = pass.owner @ GateError::Unauthorized)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, close = owner, constraint = pass.mint == config.mint @ GateError::Unauthorized)]
    pub pass: Account<'info, Pass>,
    /// CHECK: the wallet's terms (empty for a pass issued before the rules existed).
    #[account(mut, seeds = [TERMS_SEED, config.mint.as_ref(), pass.owner.as_ref()], bump)]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: the identity binding named by the terms; validated in `close_bundle`.
    #[account(mut)]
    pub binding: UncheckedAccount<'info>,
    /// CHECK: the wallet's affiliate-volume PDA; validated in `close_bundle`.
    #[account(mut)]
    pub volume: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RevokeByTerms<'info> {
    #[account(mut)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: receives the rent; bound to the pass.
    #[account(mut, address = pass.owner @ GateError::Unauthorized)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, close = owner, constraint = pass.mint == config.mint @ GateError::Unauthorized)]
    pub pass: Account<'info, Pass>,
    #[account(
        mut,
        seeds = [TERMS_SEED, config.mint.as_ref(), pass.owner.as_ref()],
        bump = terms.bump,
        constraint = terms.mint == config.mint @ GateError::WrongAccount
    )]
    pub terms: Account<'info, Terms>,
    /// CHECK: the identity binding named by the terms; validated in `close_bundle`.
    #[account(mut)]
    pub binding: UncheckedAccount<'info>,
    /// CHECK: the wallet's affiliate-volume PDA; validated in `close_bundle`.
    #[account(mut)]
    pub volume: UncheckedAccount<'info>,
    /// CHECK: the pass owner's SAS identity attestation (read by `revoke_expired` only).
    pub identity_attestation: UncheckedAccount<'info>,
    /// CHECK: the pass owner's denial record (read by `revoke_denied` only).
    #[account(seeds = [DENY_SEED, config.mint.as_ref(), pass.owner.as_ref()], bump)]
    pub denied: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey)]
pub struct DenyWallet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    #[account(init, payer = authority, space = 8 + Denied::INIT_SPACE, seeds = [DENY_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub denied: Account<'info, Denied>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AllowWallet<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    #[account(mut, close = authority, constraint = denied.mint == config.mint @ GateError::WrongAccount)]
    pub denied: Account<'info, Denied>,
}

#[derive(Accounts)]
pub struct UpdateHookMetas<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(mint::token_program = TOKEN_2022_PROGRAM_ID)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump, has_one = authority @ GateError::Unauthorized)]
    pub config: Account<'info, GateConfig>,
    /// CHECK: the mint's extra-account-meta list, rewritten here.
    #[account(mut, seeds = [HOOK_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_metas: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenVolume<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub config: Account<'info, GateConfig>,
    #[account(
        seeds = [TERMS_SEED, config.mint.as_ref(), terms.owner.as_ref()],
        bump = terms.bump,
        constraint = terms.mint == config.mint @ GateError::WrongAccount
    )]
    pub terms: Account<'info, Terms>,
    /// CHECK: the wallet's affiliate-volume PDA, created by `init_volume`.
    #[account(mut, seeds = [VOLUME_SEED, config.mint.as_ref(), terms.owner.as_ref()], bump)]
    pub volume: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReserveAllocation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The cross. Only `cross_core` can sign for one of its accounts.
    pub cross: Signer<'info>,
    pub config: Account<'info, GateConfig>,
    #[account(
        seeds = [TERMS_SEED, config.mint.as_ref(), terms.owner.as_ref()],
        bump = terms.bump,
        constraint = terms.mint == config.mint @ GateError::WrongAccount
    )]
    pub terms: Account<'info, Terms>,
    /// CHECK: the allocation PDA `["alloc", cross, key]`; derived and validated in the handler.
    #[account(mut)]
    pub alloc: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleaseAllocation<'info> {
    /// The cross. Only `cross_core` can sign for one of its accounts.
    pub cross: Signer<'info>,
    /// CHECK: the allocation PDA `["alloc", cross, key]`; derived and validated in the handler.
    #[account(mut)]
    pub alloc: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(owner: Pubkey, amount: u64)]
pub struct ReceiveLocked<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The cross. Only `cross_core` can sign for one of its accounts.
    pub cross: Signer<'info>,
    pub config: Account<'info, GateConfig>,
    #[account(init_if_needed, payer = payer, space = 8 + Lock::INIT_SPACE, seeds = [LOCK_SEED, config.mint.as_ref(), owner.as_ref()], bump)]
    pub lock: Account<'info, Lock>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct RulesChanged {
    pub mint: Pubkey,
    pub rules: Rules,
}

#[event]
pub struct PassIssued {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub identity: [u8; 32],
    pub country: u16,
    pub tier: u8,
    pub flags: u8,
    pub cap: u64,
    pub expires_ts: i64,
    pub source: u8,
}

#[event]
pub struct TermsRefreshed {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub country: u16,
    pub tier: u8,
    pub flags: u8,
    pub cap: u64,
    pub expires_ts: i64,
}

/// `reason`: 0 authority, 1 expired, 2 no longer conforms, 3 denied, 4 attestation gone.
#[event]
pub struct PassClosed {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub reason: u8,
}

#[event]
pub struct WalletDenied {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub reason: u8,
    pub denied: bool,
}

#[event]
pub struct AllocationChanged {
    pub cross: Pubkey,
    pub key: [u8; 32],
    pub reserved: u64,
    pub cap: u64,
}
