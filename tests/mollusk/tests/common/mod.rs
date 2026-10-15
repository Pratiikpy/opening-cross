//! Helpers shared by the instruction-level suites: program loading, account builders, discriminators and error readers.
#![allow(dead_code)]
use mollusk_svm::{program::create_program_account_loader_v3, program::keyed_account_for_system_program, result::InstructionResult, result::ProgramResult, Mollusk};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

pub const CORE: Pubkey = Pubkey::from_str_const("F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ");
pub const DEPLOY: &str = "../../target/deploy";
pub const SPL_TOKEN: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Anchor framework error numbers.
pub const INSTRUCTION_MISSING: u32 = 100;
pub const INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101;
pub const INSTRUCTION_DID_NOT_DESERIALIZE: u32 = 102;
pub const ACCOUNT_NOT_ENOUGH_KEYS: u32 = 3005;
pub const ACCOUNT_NOT_SIGNER: u32 = 3010;
pub const DECLARED_PROGRAM_ID_MISMATCH: u32 = 4100;

pub fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

/// A program as built in `target/deploy`, loaded at `id`.
pub fn mollusk(id: &Pubkey, so: &str) -> Mollusk {
    Mollusk::new(id, &format!("{DEPLOY}/{so}"))
}

/// `sha256("<namespace>:<name>")[..8]`: how Anchor derives instruction ("global"), account ("account") and event ("event") discriminators.
pub fn disc(namespace: &str, name: &str) -> [u8; 8] {
    Sha256::digest(format!("{namespace}:{name}"))[..8].try_into().unwrap()
}

pub fn wallet(lamports: u64) -> Account {
    Account { lamports, data: vec![], owner: solana_sdk_ids::system_program::id(), executable: false, rent_epoch: 0 }
}

/// An account that does not exist yet (what a PDA that is about to be created looks like).
pub fn empty() -> Account {
    wallet(0)
}

pub fn custom(r: &ProgramResult) -> Option<u32> {
    match r {
        ProgramResult::Failure(solana_program_error::ProgramError::Custom(c)) => Some(*c),
        _ => None,
    }
}

pub fn account_in<'a>(accounts: &'a [(Pubkey, Account)], key: &Pubkey) -> &'a Account {
    &accounts.iter().find(|(k, _)| k == key).unwrap_or_else(|| panic!("{key} is not among the resulting accounts")).1
}

// ---------------------------------------------------------------------------------------------- cross_core fixtures

pub type State = Vec<(Pubkey, Account)>;

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
pub fn halt_of(mint: &Pubkey) -> Pubkey {
    pda(&[b"halt", mint.as_ref()], &CORE)
}
pub fn protocol() -> Pubkey {
    pda(&[b"protocol"], &CORE)
}


/// A classic SPL mint: authority, supply, decimals, initialised, no freeze authority (82 bytes).
pub fn mint_account(authority: &Pubkey, supply: u64) -> Account {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(authority.as_ref());
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = 6;
    d[45] = 1;
    Account { lamports: 1_461_600, data: d, owner: SPL_TOKEN, executable: false, rent_epoch: 0 }
}
pub fn program_account(id: &Pubkey) -> (Pubkey, Account) {
    (*id, create_program_account_loader_v3(id))
}

pub fn ix(program: Pubkey, name: &str, args: &[u8], metas: Vec<AccountMeta>) -> Instruction {
    let mut data = disc("global", name).to_vec();
    data.extend(args);
    Instruction::new_with_bytes(program, &data, metas)
}

pub fn init_protocol(admin: &Pubkey) -> Instruction {
    let mut args = key(2).to_bytes().to_vec();
    args.extend(key(3).to_bytes());
    for f in [30u16, 5, 15, 30] {
        args.extend(f.to_le_bytes());
    }
    ix(CORE, "init_protocol", &args, vec![AccountMeta::new(*admin, true), AccountMeta::new(protocol(), false), AccountMeta::new_readonly(solana_sdk_ids::system_program::id(), false)])
}

pub fn init_halt_state(authority: &Pubkey, mint: &Pubkey, venue_signer: Option<Pubkey>) -> Instruction {
    let mut args = vec![];
    match venue_signer {
        Some(v) => {
            args.push(1);
            args.extend(v.to_bytes());
        }
        None => args.push(0),
    }
    args.push(0); // no circuit breaker
    ix(
        CORE,
        "init_halt_state",
        &args,
        vec![AccountMeta::new(*authority, true), AccountMeta::new_readonly(*mint, false), AccountMeta::new_readonly(protocol(), false), AccountMeta::new(halt_of(mint), false), AccountMeta::new_readonly(solana_sdk_ids::system_program::id(), false)],
    )
}


/// Runs an instruction against `state` plus the programs and system accounts every call needs, and folds the resulting accounts back into `state`.
pub fn run(m: &Mollusk, instruction: &Instruction, state: &mut State) -> InstructionResult {
    let mut accounts: State = state.clone();
    for extra in [keyed_account_for_system_program(), program_account(&CORE), program_account(&instruction.program_id)] {
        if !accounts.iter().any(|(k, _)| *k == extra.0) {
            accounts.push(extra);
        }
    }
    for meta in &instruction.accounts {
        if !accounts.iter().any(|(k, _)| *k == meta.pubkey) {
            accounts.push((meta.pubkey, empty()));
        }
    }
    let r = m.process_instruction(instruction, &accounts);
    if r.program_result.is_ok() {
        for (k, a) in &r.resulting_accounts {
            match state.iter_mut().find(|(sk, _)| sk == k) {
                Some(slot) => slot.1 = a.clone(),
                None => state.push((*k, a.clone())),
            }
        }
    }
    r
}

pub fn set(state: &mut State, k: Pubkey, a: Account) {
    match state.iter_mut().find(|(sk, _)| *sk == k) {
        Some(slot) => slot.1 = a,
        None => state.push((k, a)),
    }
}
pub fn get<'a>(state: &'a State, k: &Pubkey) -> &'a Account {
    account_in(state, k)
}

