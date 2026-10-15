//! cross_backing, one instruction at a time, with a real cross-program call: `check` halts an asset through `cross_core`'s own `set_halt`.
//!
//! Both binaries come from `target/deploy`. The protocol and the asset's halt state are created by `cross_core`'s own instructions, not
//! written by hand, so the halt state the watchdog acts on is exactly what the program produces. The mint is a classic SPL mint laid out
//! byte for byte (the program only reads its supply). Time is the chain clock, set by the test.
mod common;

use common::*;
use mollusk_svm::Mollusk;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

const BACKING: Pubkey = Pubkey::from_str_const("HThrduwqRFvjHKPiQiRitsSw5yuGkXmAPkykAvMRQYkp");

// BackingError numbers from the program's IDL.
const BAD_POLICY: u32 = 6000;
const WRONG_HALT: u32 = 6001;
const UNAUTHORIZED: u32 = 6002;
const WATCHDOG_NOT_VENUE_SIGNER: u32 = 6003;
const BACKED: u32 = 6004;
// Anchor framework errors.
const CONSTRAINT_SEEDS: u32 = 2006;
const CONSTRAINT_ADDRESS: u32 = 2012;
const ACCOUNT_NOT_INITIALIZED: u32 = 3012;

const MIN_AGE: i64 = 60;
const DAY: i64 = 86_400;
/// `HaltState`: discriminator, base mint, authority, then the venue signer as `Some(pubkey)`, then `halted`.
const HALTED_AT: usize = 8 + 32 + 32 + 33;

fn watchdog_of(mint: &Pubkey) -> Pubkey {
    pda(&[b"watchdog", mint.as_ref()], &BACKING)
}
fn policy_of(mint: &Pubkey) -> Pubkey {
    pda(&[b"policy", mint.as_ref()], &BACKING)
}
fn attestation_of(mint: &Pubkey) -> Pubkey {
    pda(&[b"attestation", mint.as_ref()], &BACKING)
}
fn halted(state: &State, mint: &Pubkey) -> bool {
    get(state, &halt_of(mint)).data[HALTED_AT] == 1
}

fn mollusk() -> Mollusk {
    let mut m = mollusk_with(&BACKING, "cross_backing");
    m.add_program(&CORE, &format!("{DEPLOY}/cross_core"));
    m.sysvars.clock.unix_timestamp = 1_800_000_000;
    m
}
fn mollusk_with(id: &Pubkey, so: &str) -> Mollusk {
    common::mollusk(id, so)
}

fn create_policy(authority: &Pubkey, mint: &Pubkey, attester: &Pubkey, coverage_bps: u16, max_age: i64) -> Instruction {
    let mut args = attester.to_bytes().to_vec();
    args.extend(coverage_bps.to_le_bytes());
    args.extend(max_age.to_le_bytes());
    ix(
        BACKING,
        "create_policy",
        &args,
        vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(halt_of(mint), false),
            AccountMeta::new_readonly(watchdog_of(mint), false),
            AccountMeta::new(policy_of(mint), false),
            AccountMeta::new_readonly(solana_sdk_ids::system_program::id(), false),
        ],
    )
}

fn attest(attester: &Pubkey, mint: &Pubkey, backing: u64) -> Instruction {
    ix(BACKING, "attest", &backing.to_le_bytes(), vec![AccountMeta::new(*attester, true), AccountMeta::new_readonly(policy_of(mint), false), AccountMeta::new(attestation_of(mint), false), AccountMeta::new_readonly(solana_sdk_ids::system_program::id(), false)])
}

fn check(mint: &Pubkey) -> Instruction {
    ix(
        BACKING,
        "check",
        &[],
        vec![AccountMeta::new_readonly(policy_of(mint), false), AccountMeta::new_readonly(*mint, false), AccountMeta::new_readonly(attestation_of(mint), false), AccountMeta::new_readonly(watchdog_of(mint), false), AccountMeta::new(halt_of(mint), false), AccountMeta::new_readonly(CORE, false)],
    )
}

struct World {
    m: Mollusk,
    state: State,
    admin: Pubkey,
    mint: Pubkey,
    attester: Pubkey,
}

/// A protocol, a mint with `supply`, the mint's halt state naming the watchdog as its venue signer, and a policy of `bps` coverage and `max_age` seconds.
fn world(supply: u64, bps: u16, max_age: i64) -> World {
    let (admin, mint, attester) = (key(1), key(0x10), key(0x20));
    let m = mollusk();
    let mut state: State = vec![(admin, wallet(100_000_000_000)), (attester, wallet(10_000_000_000)), (mint, mint_account(&admin, supply))];
    assert!(run(&m, &init_protocol(&admin), &mut state).program_result.is_ok());
    let h = run(&m, &init_halt_state(&admin, &mint, Some(watchdog_of(&mint))), &mut state);
    assert!(h.program_result.is_ok(), "init_halt_state: {:?}", h.program_result);
    let p = run(&m, &create_policy(&admin, &mint, &attester, bps, max_age), &mut state);
    assert!(p.program_result.is_ok(), "create_policy: {:?}", p.program_result);
    World { m, state, admin, mint, attester }
}

#[test]
fn a_policy_is_created_with_exactly_the_given_terms_and_cannot_be_replaced() {
    let w = world(1_000, 10_000, DAY);
    let p = get(&w.state, &policy_of(&w.mint));
    assert_eq!(p.owner, BACKING);
    let d = &p.data;
    assert_eq!(d[..8], disc("account", "Policy"));
    assert_eq!(&d[8..40], w.mint.as_ref());
    assert_eq!(&d[40..72], w.attester.as_ref());
    assert_eq!(u16::from_le_bytes(d[72..74].try_into().unwrap()), 10_000);
    assert_eq!(i64::from_le_bytes(d[74..82].try_into().unwrap()), DAY);
    assert_eq!(d[82], Pubkey::find_program_address(&[b"policy", w.mint.as_ref()], &BACKING).1);
    assert_eq!(d.len(), 8 + 32 + 32 + 2 + 8 + 1);

    // The terms are fixed for good: a second create_policy, even by the same authority with other terms, changes nothing.
    let mut state = w.state.clone();
    let again = run(&w.m, &create_policy(&w.admin, &w.mint, &key(0x77), 20_000, 3_600), &mut state);
    assert!(again.program_result.is_err(), "a policy was replaced");
    assert_eq!(get(&w.state, &policy_of(&w.mint)).data, get(&again.resulting_accounts, &policy_of(&w.mint)).data);
}

#[test]
fn create_policy_refuses_terms_outside_one_to_two_hundred_percent_and_one_minute_to_thirty_days() {
    let (admin, mint, attester) = (key(1), key(0x10), key(0x20));
    let m = mollusk();
    let mut base: State = vec![(admin, wallet(100_000_000_000)), (mint, mint_account(&admin, 1_000))];
    assert!(run(&m, &init_protocol(&admin), &mut base).program_result.is_ok());
    assert!(run(&m, &init_halt_state(&admin, &mint, Some(watchdog_of(&mint))), &mut base).program_result.is_ok());
    for (bps, age, what) in [(99u16, DAY, "coverage 99 bps"), (20_001, DAY, "coverage 20,001 bps"), (10_000, MIN_AGE - 1, "age 59 s"), (10_000, 30 * DAY + 1, "age over 30 days"), (0, 0, "all zero")] {
        let mut s = base.clone();
        let r = run(&m, &create_policy(&admin, &mint, &attester, bps, age), &mut s);
        assert_eq!(custom(&r.program_result), Some(BAD_POLICY), "{what}: {:?}", r.program_result);
    }
    // The limits themselves are accepted.
    for (bps, age) in [(100u16, MIN_AGE), (20_000, 30 * DAY)] {
        let mut s = base.clone();
        let r = run(&m, &create_policy(&admin, &mint, &attester, bps, age), &mut s);
        assert!(r.program_result.is_ok(), "{bps} bps, {age} s: {:?}", r.program_result);
    }
}

#[test]
fn only_the_halt_states_own_authority_can_opt_an_asset_in_and_only_with_the_watchdog_as_venue_signer() {
    let (admin, mint, attester, stranger) = (key(1), key(0x10), key(0x20), key(0x30));
    let m = mollusk();
    let mut base: State = vec![(admin, wallet(100_000_000_000)), (stranger, wallet(10_000_000_000)), (mint, mint_account(&admin, 1_000))];
    assert!(run(&m, &init_protocol(&admin), &mut base).program_result.is_ok());

    // A halt state whose venue signer is someone else, or nobody, can never be acted on by the watchdog: refused.
    for venue in [Some(key(0x55)), None] {
        let mut s = base.clone();
        assert!(run(&m, &init_halt_state(&admin, &mint, venue), &mut s).program_result.is_ok());
        let r = run(&m, &create_policy(&admin, &mint, &attester, 10_000, DAY), &mut s);
        assert_eq!(custom(&r.program_result), Some(WATCHDOG_NOT_VENUE_SIGNER), "venue {venue:?}: {:?}", r.program_result);
    }

    let mut s = base.clone();
    assert!(run(&m, &init_halt_state(&admin, &mint, Some(watchdog_of(&mint))), &mut s).program_result.is_ok());
    // Another signer, though funded and present, is not the halt state's authority.
    let r = run(&m, &create_policy(&stranger, &mint, &attester, 10_000, DAY), &mut s);
    assert_eq!(custom(&r.program_result), Some(UNAUTHORIZED), "{:?}", r.program_result);
    // The authority must sign.
    let mut unsigned = create_policy(&admin, &mint, &attester, 10_000, DAY);
    unsigned.accounts[0].is_signer = false;
    assert!(run(&m, &unsigned, &mut s).program_result.is_err());

    // A halt account that belongs to another program, or names another mint, is not this mint's halt state.
    let mut foreign = s.clone();
    let mut a = get(&foreign, &halt_of(&mint)).clone();
    a.owner = key(0x99);
    set(&mut foreign, halt_of(&mint), a);
    assert_eq!(custom(&run(&m, &create_policy(&admin, &mint, &attester, 10_000, DAY), &mut foreign).program_result), Some(WRONG_HALT));
    let mut other_mint = s.clone();
    let mut a = get(&other_mint, &halt_of(&mint)).clone();
    a.data[8..40].copy_from_slice(key(0x66).as_ref());
    set(&mut other_mint, halt_of(&mint), a);
    assert_eq!(custom(&run(&m, &create_policy(&admin, &mint, &attester, 10_000, DAY), &mut other_mint).program_result), Some(WRONG_HALT));
    // The halt account passed must be the PDA of this mint.
    let mut wrong_address = create_policy(&admin, &mint, &attester, 10_000, DAY);
    wrong_address.accounts[2].pubkey = halt_of(&key(0x11));
    assert_eq!(custom(&run(&m, &wrong_address, &mut s).program_result), Some(CONSTRAINT_SEEDS));
    // And it works for the authority, with the watchdog as venue signer.
    assert!(run(&m, &create_policy(&admin, &mint, &attester, 10_000, DAY), &mut s).program_result.is_ok());
}

#[test]
fn only_the_named_attester_can_attest_and_the_time_is_the_chains() {
    let mut w = world(1_000, 10_000, DAY);
    let (policy, att) = (policy_of(&w.mint), attestation_of(&w.mint));
    assert_eq!(custom(&run(&w.m, &attest(&w.admin, &w.mint, 5_000), &mut w.state).program_result), Some(UNAUTHORIZED), "the policy's creator is not its attester");
    let stranger = key(0x31);
    set(&mut w.state, stranger, wallet(10_000_000_000));
    assert_eq!(custom(&run(&w.m, &attest(&stranger, &w.mint, 5_000), &mut w.state).program_result), Some(UNAUTHORIZED));
    assert!(w.state.iter().all(|(k, a)| *k != att || a.data.is_empty()), "a refused attestation leaves nothing behind");
    let mut unsigned = attest(&w.attester, &w.mint, 5_000);
    unsigned.accounts[0].is_signer = false;
    assert!(run(&w.m, &unsigned, &mut w.state).program_result.is_err());

    let first = run(&w.m, &attest(&w.attester, &w.mint, 1_500), &mut w.state);
    assert!(first.program_result.is_ok(), "{:?}", first.program_result);
    println!("attest (first): {} compute units", first.compute_units_consumed);
    let a = get(&w.state, &att);
    assert_eq!((a.owner, a.data[..8].to_vec()), (BACKING, disc("account", "Attestation").to_vec()));
    assert_eq!(&a.data[8..40], w.mint.as_ref());
    assert_eq!(u64::from_le_bytes(a.data[40..48].try_into().unwrap()), 1_500);
    assert_eq!(i64::from_le_bytes(a.data[48..56].try_into().unwrap()), 1_800_000_000);

    // A later statement replaces the earlier one, stamped with the chain's new time.
    w.m.sysvars.clock.unix_timestamp = 1_800_000_500;
    assert!(run(&w.m, &attest(&w.attester, &w.mint, 900), &mut w.state).program_result.is_ok());
    let a = get(&w.state, &att);
    assert_eq!(u64::from_le_bytes(a.data[40..48].try_into().unwrap()), 900);
    assert_eq!(i64::from_le_bytes(a.data[48..56].try_into().unwrap()), 1_800_000_500);
    assert_eq!(get(&w.state, &policy).data[72..74], 10_000u16.to_le_bytes(), "attesting never touches the policy");
}

#[test]
fn check_halts_an_asset_with_no_attestation_through_cross_core() {
    let mut w = world(1_000, 10_000, DAY);
    assert!(!halted(&w.state, &w.mint));
    let r = run(&w.m, &check(&w.mint), &mut w.state);
    assert!(r.program_result.is_ok(), "{:?}", r.program_result);
    println!("check -> halt (no attestation): {} compute units", r.compute_units_consumed);
    assert!(halted(&w.state, &w.mint), "the watchdog's call did not halt the asset in cross_core");
    assert!(r.compute_units_consumed < 60_000, "check took {}", r.compute_units_consumed);
}

#[test]
fn check_is_refused_while_the_backing_is_fresh_and_covers_the_live_supply_and_changes_nothing() {
    let mut w = world(1_000, 10_000, DAY);
    assert!(run(&w.m, &attest(&w.attester, &w.mint, 1_000), &mut w.state).program_result.is_ok());
    let before = w.state.clone();
    let r = run(&w.m, &check(&w.mint), &mut w.state);
    assert_eq!(custom(&r.program_result), Some(BACKED), "{:?}", r.program_result);
    assert!(!halted(&w.state, &w.mint));
    for (k, a) in &before {
        assert_eq!(&get(&w.state, k).data, &a.data, "a refused check changed {k}");
    }
}

#[test]
fn coverage_and_age_are_exact_at_their_boundaries() {
    // Coverage: 150% of a supply of 1,000 needs 1,500 atoms of backing.
    for (backing, expect_halt) in [(1_500u64, false), (1_499, true), (u64::MAX, false), (0, true)] {
        let mut w = world(1_000, 15_000, DAY);
        assert!(run(&w.m, &attest(&w.attester, &w.mint, backing), &mut w.state).program_result.is_ok());
        let r = run(&w.m, &check(&w.mint), &mut w.state);
        assert_eq!(halted(&w.state, &w.mint), expect_halt, "backing {backing}: {:?}", r.program_result);
        assert_eq!(r.program_result.is_ok(), expect_halt, "backing {backing}");
    }
    // Age: a statement exactly `max_age` old is fresh; one second older is stale, even though it covers the supply.
    for (age, expect_halt) in [(0i64, false), (MIN_AGE, false), (MIN_AGE + 1, true)] {
        let mut w = world(1_000, 10_000, MIN_AGE);
        assert!(run(&w.m, &attest(&w.attester, &w.mint, 1_000), &mut w.state).program_result.is_ok());
        w.m.sysvars.clock.unix_timestamp += age;
        let r = run(&w.m, &check(&w.mint), &mut w.state);
        assert_eq!(halted(&w.state, &w.mint), expect_halt, "age {age}: {:?}", r.program_result);
    }
    // The live supply is what counts: backing that covered the supply an hour ago does not cover it after more is minted.
    let mut w = world(1_000, 10_000, DAY);
    assert!(run(&w.m, &attest(&w.attester, &w.mint, 1_000), &mut w.state).program_result.is_ok());
    set(&mut w.state, w.mint, mint_account(&w.admin, 1_001));
    assert!(run(&w.m, &check(&w.mint), &mut w.state).program_result.is_ok());
    assert!(halted(&w.state, &w.mint), "one atom of new supply left the asset covered");
}

#[test]
fn check_refuses_substituted_accounts() {
    let mut w = world(1_000, 10_000, DAY);
    // The program that gets the halt call must be cross_core itself.
    let mut fake_program = check(&w.mint);
    fake_program.accounts[5].pubkey = key(0x42);
    set(&mut w.state, key(0x42), wallet(1));
    assert_eq!(custom(&run(&w.m, &fake_program, &mut w.state).program_result), Some(CONSTRAINT_ADDRESS));
    // The watchdog, the policy and the halt state must be this mint's PDAs.
    // A policy of another mint does not exist, so the account is refused as uninitialised before its address is compared.
    for (slot, wrong, expected) in [(3usize, watchdog_of(&key(0x11)), CONSTRAINT_SEEDS), (0, policy_of(&key(0x11)), ACCOUNT_NOT_INITIALIZED), (4, halt_of(&key(0x11)), CONSTRAINT_SEEDS), (2, attestation_of(&key(0x11)), CONSTRAINT_SEEDS)] {
        let mut ix = check(&w.mint);
        ix.accounts[slot].pubkey = wrong;
        let r = run(&w.m, &ix, &mut w.state.clone());
        assert_eq!(custom(&r.program_result), Some(expected), "slot {slot}: {:?}", r.program_result);
    }
    assert!(!halted(&w.state, &w.mint));
}
