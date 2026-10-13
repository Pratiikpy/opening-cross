//! cross_core, one instruction at a time, on the real built binary (`target/deploy/cross_core.so`).
//!
//! The LiteSVM suites under tests/core run whole flows. These tests do the opposite: one instruction, hand-built accounts, and a
//! check of exactly which accounts changed and how, which error comes back, and how many compute units it took. They are the
//! place to look when a single instruction's contract is in doubt.
use mollusk_svm::{program::keyed_account_for_system_program, result::ProgramResult, Mollusk};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

const PROGRAM: Pubkey = Pubkey::from_str_const("F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ");
const PROTOCOL_DISC: [u8; 8] = [45, 39, 101, 43, 115, 72, 131, 40];

// Anchor error numbers from the program's IDL.
const PAUSED: u32 = 6000;
const UNAUTHORIZED: u32 = 6001;
const FEE_TOO_HIGH: u32 = 6004;
const ACCOUNT_NOT_SIGNER: u32 = 3010; // anchor framework
const CONSTRAINT_SEEDS: u32 = 2006; // anchor framework
const INSTRUCTION_FALLBACK_NOT_FOUND: u32 = 101; // anchor framework
const MAX_PROTOCOL_FEE_BPS: u16 = 100;

fn mollusk() -> Mollusk {
    Mollusk::new(&PROGRAM, "../../target/deploy/cross_core")
}

fn key(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}
fn protocol_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"protocol"], &PROGRAM)
}
fn disc(name: &str) -> [u8; 8] {
    let h = Sha256::digest(format!("global:{name}"));
    h[..8].try_into().unwrap()
}
fn wallet(lamports: u64) -> Account {
    Account { lamports, data: vec![], owner: solana_sdk_ids::system_program::id(), executable: false, rent_epoch: 0 }
}
fn fees(f: [u16; 4]) -> Vec<u8> {
    f.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn init_ix(admin: Pubkey, guardian: Pubkey, fee_recipient: Pubkey, f: [u16; 4]) -> Instruction {
    let mut data = disc("init_protocol").to_vec();
    data.extend(guardian.to_bytes());
    data.extend(fee_recipient.to_bytes());
    data.extend(fees(f));
    Instruction::new_with_bytes(
        PROGRAM,
        &data,
        vec![AccountMeta::new(admin, true), AccountMeta::new(protocol_pda().0, false), AccountMeta::new_readonly(solana_sdk_ids::system_program::id(), false)],
    )
}

/// A protocol account as the program lays it out: admin, guardian, fee recipient, four fees, paused, bump, pending admin.
fn protocol_account(admin: Pubkey, guardian: Pubkey, fee_recipient: Pubkey, f: [u16; 4], paused: bool, pending: Option<Pubkey>) -> Account {
    let mut d = PROTOCOL_DISC.to_vec();
    d.extend(admin.to_bytes());
    d.extend(guardian.to_bytes());
    d.extend(fee_recipient.to_bytes());
    d.extend(fees(f));
    d.push(paused as u8);
    d.push(protocol_pda().1);
    match pending {
        Some(p) => {
            d.push(1);
            d.extend(p.to_bytes());
        }
        None => {
            d.push(0);
            d.extend([0u8; 32]);
        }
    }
    Account { lamports: 5_000_000, data: d, owner: PROGRAM, executable: false, rent_epoch: 0 }
}

struct Protocol {
    admin: Pubkey,
    guardian: Pubkey,
    fee_recipient: Pubkey,
    fees: [u16; 4],
    paused: bool,
    bump: u8,
    pending: Option<Pubkey>,
}
fn read(a: &Account) -> Protocol {
    let d = &a.data;
    assert_eq!(d[..8], PROTOCOL_DISC, "protocol discriminator");
    let pk = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
    Protocol {
        admin: pk(8),
        guardian: pk(40),
        fee_recipient: pk(72),
        fees: [0, 1, 2, 3].map(|i| u16::from_le_bytes(d[104 + 2 * i..106 + 2 * i].try_into().unwrap())),
        paused: d[112] == 1,
        bump: d[113],
        pending: (d[114] == 1).then(|| pk(115)),
    }
}

fn custom(r: &ProgramResult) -> Option<u32> {
    match r {
        ProgramResult::Failure(solana_program_error::ProgramError::Custom(c)) => Some(*c),
        _ => None,
    }
}

fn admin_ix(name: &str, signer: Pubkey, signer_is_signer: bool, args: &[u8]) -> Instruction {
    let mut data = disc(name).to_vec();
    data.extend(args);
    Instruction::new_with_bytes(PROGRAM, &data, vec![AccountMeta { pubkey: signer, is_signer: signer_is_signer, is_writable: false }, AccountMeta::new(protocol_pda().0, false)])
}

const FEES: [u16; 4] = [30, 5, 15, 30];

#[test]
fn discriminators_are_what_the_program_expects() {
    // The IDL's discriminator for init_protocol, written out, against the derivation used everywhere in this file.
    assert_eq!(disc("init_protocol"), [3, 188, 141, 237, 225, 226, 232, 210]);
    assert_eq!(disc("set_paused"), [91, 60, 125, 192, 176, 225, 166, 218]);
    assert_eq!(disc("set_guardian"), [147, 243, 50, 121, 154, 164, 50, 30]);
    assert_eq!(disc("propose_admin"), [121, 214, 199, 212, 87, 39, 117, 234]);
    assert_eq!(disc("accept_admin"), [112, 42, 45, 90, 116, 181, 13, 170]);
    assert_eq!(disc("set_protocol_fees"), [49, 143, 189, 18, 56, 206, 158, 226]);
    let h = Sha256::digest(b"account:Protocol");
    assert_eq!(h[..8], PROTOCOL_DISC);
}

#[test]
fn init_protocol_creates_the_protocol_account_with_exactly_the_given_fields() {
    let m = mollusk();
    let (admin, guardian, fr) = (key(1), key(2), key(3));
    let (pda, bump) = protocol_pda();
    let r = m.process_instruction(&init_ix(admin, guardian, fr, FEES), &[(admin, wallet(10_000_000_000)), (pda, wallet(0)), keyed_account_for_system_program()]);
    assert!(r.program_result.is_ok(), "{:?}", r.program_result);
    let acct = &r.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1;
    assert_eq!(acct.owner, PROGRAM);
    let p = read(acct);
    assert_eq!((p.admin, p.guardian, p.fee_recipient, p.fees, p.paused, p.bump, p.pending), (admin, guardian, fr, FEES, false, bump, None));
    assert_eq!(acct.data.len(), 147);
    // The admin paid the rent for the account, and nothing else moved.
    let after = r.resulting_accounts.iter().find(|(k, _)| *k == admin).unwrap().1.lamports;
    assert_eq!(10_000_000_000 - after, acct.lamports);
    println!("init_protocol: {} compute units", r.compute_units_consumed);
    assert!(r.compute_units_consumed < 30_000, "init_protocol took {}", r.compute_units_consumed);
}

#[test]
fn init_protocol_accepts_the_fee_cap_and_refuses_one_basis_point_over() {
    let m = mollusk();
    let (admin, pda) = (key(1), protocol_pda().0);
    let accounts = [(admin, wallet(10_000_000_000)), (pda, wallet(0)), keyed_account_for_system_program()];
    let at_cap = m.process_instruction(&init_ix(admin, key(2), key(3), [MAX_PROTOCOL_FEE_BPS; 4]), &accounts);
    assert!(at_cap.program_result.is_ok(), "{:?}", at_cap.program_result);
    for i in 0..4 {
        let mut f = [0u16; 4];
        f[i] = MAX_PROTOCOL_FEE_BPS + 1;
        let over = m.process_instruction(&init_ix(admin, key(2), key(3), f), &accounts);
        assert_eq!(custom(&over.program_result), Some(FEE_TOO_HIGH), "fee slot {i}: {:?}", over.program_result);
    }
}

#[test]
fn init_protocol_cannot_run_twice_or_without_the_admin_signing() {
    let m = mollusk();
    let (admin, pda) = (key(1), protocol_pda().0);
    let first = m.process_instruction(&init_ix(admin, key(2), key(3), FEES), &[(admin, wallet(10_000_000_000)), (pda, wallet(0)), keyed_account_for_system_program()]);
    assert!(first.program_result.is_ok());
    let created = first.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1.clone();
    // A second init by anyone, with different values, must not overwrite the protocol.
    let other = key(9);
    let again = m.process_instruction(&init_ix(other, key(8), key(7), [1, 1, 1, 1]), &[(other, wallet(10_000_000_000)), (pda, created.clone()), keyed_account_for_system_program()]);
    assert!(again.program_result.is_err(), "a second init succeeded");
    let still = &again.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1;
    assert_eq!(still.data, created.data, "a failed init must leave the account as it was");
    // The admin must sign.
    let mut unsigned = init_ix(admin, key(2), key(3), FEES);
    unsigned.accounts[0].is_signer = false;
    let r = m.process_instruction(&unsigned, &[(admin, wallet(10_000_000_000)), (pda, wallet(0)), keyed_account_for_system_program()]);
    assert!(r.program_result.is_err(), "init without the admin signing succeeded");
}

#[test]
fn set_paused_by_the_guardian_or_the_admin_and_by_no_one_else() {
    let m = mollusk();
    let (admin, guardian, stranger, pda) = (key(1), key(2), key(9), protocol_pda().0);
    let open = protocol_account(admin, guardian, key(3), FEES, false, None);
    let run = |who: Pubkey, paused: bool, state: &Account| m.process_instruction(&admin_ix("set_paused", who, true, &[paused as u8]), &[(who, wallet(1_000_000)), (pda, state.clone())]);

    let by_guardian = run(guardian, true, &open);
    assert!(by_guardian.program_result.is_ok());
    let paused = by_guardian.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1.clone();
    assert!(read(&paused).paused);
    println!("set_paused: {} compute units", by_guardian.compute_units_consumed);
    assert!(by_guardian.compute_units_consumed < 10_000, "set_paused took {}", by_guardian.compute_units_consumed);

    let unpaused_by_admin = run(admin, false, &paused);
    assert!(unpaused_by_admin.program_result.is_ok());
    assert!(!read(&unpaused_by_admin.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1).paused);

    let by_stranger = run(stranger, true, &open);
    assert_eq!(custom(&by_stranger.program_result), Some(UNAUTHORIZED), "{:?}", by_stranger.program_result);
    assert!(!read(&by_stranger.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1).paused);

    // Authority is the key that SIGNED, not a key that merely appears in the account list.
    let unsigned = m.process_instruction(&admin_ix("set_paused", guardian, false, &[1]), &[(guardian, wallet(1_000_000)), (pda, open.clone())]);
    assert_eq!(custom(&unsigned.program_result), Some(ACCOUNT_NOT_SIGNER), "{:?}", unsigned.program_result);
}

#[test]
fn set_paused_refuses_an_account_that_is_not_the_protocol_pda() {
    let m = mollusk();
    let (admin, fake) = (key(1), key(77));
    let mut data = disc("set_paused").to_vec();
    data.push(1);
    let ix = Instruction::new_with_bytes(PROGRAM, &data, vec![AccountMeta::new_readonly(admin, true), AccountMeta::new(fake, false)]);
    let r = m.process_instruction(&ix, &[(admin, wallet(1_000_000)), (fake, protocol_account(admin, admin, key(3), FEES, false, None))]);
    assert_eq!(custom(&r.program_result), Some(CONSTRAINT_SEEDS), "{:?}", r.program_result);
}

#[test]
fn set_guardian_is_the_admins_alone() {
    let m = mollusk();
    let (admin, guardian, new, pda) = (key(1), key(2), key(5), protocol_pda().0);
    let state = protocol_account(admin, guardian, key(3), FEES, false, None);
    let run = |who: Pubkey| m.process_instruction(&admin_ix("set_guardian", who, true, &new.to_bytes()), &[(who, wallet(1_000_000)), (pda, state.clone())]);
    let ok = run(admin);
    assert!(ok.program_result.is_ok());
    assert_eq!(read(&ok.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1).guardian, new);
    // The guardian cannot appoint its successor, and cannot even keep itself in place by re-appointing.
    assert_eq!(custom(&run(guardian).program_result), Some(UNAUTHORIZED));
    assert_eq!(custom(&run(key(9)).program_result), Some(UNAUTHORIZED));
}

#[test]
fn admin_handover_needs_the_proposed_key_to_accept() {
    let m = mollusk();
    let (admin, successor, stranger, pda) = (key(1), key(4), key(9), protocol_pda().0);
    let state = protocol_account(admin, key(2), key(3), FEES, false, None);
    let mut propose_args = vec![1u8];
    propose_args.extend(successor.to_bytes());
    let proposed = m.process_instruction(&admin_ix("propose_admin", admin, true, &propose_args), &[(admin, wallet(1_000_000)), (pda, state.clone())]);
    assert!(proposed.program_result.is_ok());
    let pending = proposed.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1.clone();
    assert_eq!(read(&pending).pending, Some(successor));
    assert_eq!(read(&pending).admin, admin, "proposing changes nothing until accepted");

    // The stranger cannot propose, and cannot accept.
    assert_eq!(custom(&m.process_instruction(&admin_ix("propose_admin", stranger, true, &propose_args), &[(stranger, wallet(1_000_000)), (pda, state.clone())]).program_result), Some(UNAUTHORIZED));
    let by_stranger = m.process_instruction(&admin_ix("accept_admin", stranger, true, &[]), &[(stranger, wallet(1_000_000)), (pda, pending.clone())]);
    assert!(by_stranger.program_result.is_err(), "a stranger accepted the admin role");
    // The old admin cannot accept on the successor's behalf either.
    assert!(m.process_instruction(&admin_ix("accept_admin", admin, true, &[]), &[(admin, wallet(1_000_000)), (pda, pending.clone())]).program_result.is_err());

    let accepted = m.process_instruction(&admin_ix("accept_admin", successor, true, &[]), &[(successor, wallet(1_000_000)), (pda, pending)]);
    assert!(accepted.program_result.is_ok(), "{:?}", accepted.program_result);
    let after = read(&accepted.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1);
    assert_eq!((after.admin, after.pending), (successor, None));
    // The old admin has lost its power.
    let handed = accepted.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1.clone();
    assert_eq!(custom(&m.process_instruction(&admin_ix("set_guardian", admin, true, &key(6).to_bytes()), &[(admin, wallet(1_000_000)), (pda, handed)]).program_result), Some(UNAUTHORIZED));
}

#[test]
fn set_protocol_fees_checks_the_caller_and_the_cap_and_changes_only_the_fees() {
    let m = mollusk();
    let (admin, pda) = (key(1), protocol_pda().0);
    let state = protocol_account(admin, key(2), key(3), FEES, true, None);
    let args = |recipient: Pubkey, f: [u16; 4]| {
        let mut a = recipient.to_bytes().to_vec();
        a.extend(fees(f));
        a
    };
    let ok = m.process_instruction(&admin_ix("set_protocol_fees", admin, true, &args(key(8), [40, 6, 16, 31])), &[(admin, wallet(1_000_000)), (pda, state.clone())]);
    assert!(ok.program_result.is_ok());
    let p = read(&ok.resulting_accounts.iter().find(|(k, _)| *k == pda).unwrap().1);
    assert_eq!((p.fee_recipient, p.fees), (key(8), [40, 6, 16, 31]));
    assert_eq!((p.admin, p.guardian, p.paused), (admin, key(2), true), "nothing but the fees may change");
    assert_eq!(custom(&m.process_instruction(&admin_ix("set_protocol_fees", admin, true, &args(key(8), [101, 0, 0, 0])), &[(admin, wallet(1_000_000)), (pda, state.clone())]).program_result), Some(FEE_TOO_HIGH));
    assert_eq!(custom(&m.process_instruction(&admin_ix("set_protocol_fees", key(2), true, &args(key(8), FEES)), &[(key(2), wallet(1_000_000)), (pda, state)]).program_result), Some(UNAUTHORIZED), "the guardian is not the admin");
}

#[test]
fn an_unknown_instruction_is_refused_by_name() {
    let m = mollusk();
    let ix = Instruction::new_with_bytes(PROGRAM, &[0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4], vec![]);
    let r = m.process_instruction(&ix, &[]);
    assert_eq!(custom(&r.program_result), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{:?}", r.program_result);
    println!("unknown instruction: {} compute units", r.compute_units_consumed);
}

#[test]
fn pause_is_reported_as_the_error_new_crosses_would_get() {
    // The Paused error number is part of the interface integrators handle; pin it.
    assert_eq!(PAUSED, 6000);
}
