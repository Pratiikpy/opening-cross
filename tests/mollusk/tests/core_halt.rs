//! cross_core's halt machinery, one instruction at a time on the real binary: who may register a halt state, who may halt, how a paused
//! Token-2022 mint is copied in, and how the oracle circuit breaker decides on two verified Pyth updates.
//!
//! Accounts are built byte for byte as their owners lay them out: a classic SPL mint, a Token-2022 mint with the pausable extension, and a
//! Pyth `PriceUpdateV2`. The halt state itself is only ever written by the program (`init_halt_state`), then read back field by field.
mod common;

use common::*;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

// CrossError numbers from the program's IDL.
const UNAUTHORIZED: u32 = 6001;
const INVALID_PARAMS: u32 = 6002;
const WRONG_MINT: u32 = 6027;
const HALT_MISMATCH: u32 = 6040;
const ORACLE_UNAVAILABLE: u32 = 6043;
const ACCOUNT_ALREADY_IN_USE: u32 = 0; // the system program's own error when a PDA account exists

const TOKEN_2022: Pubkey = Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PYTH_RECEIVER: Pubkey = Pubkey::from_str_const("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const PYTH_RECEIVER_UPGRADED: Pubkey = Pubkey::from_str_const("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
const PRICE_UPDATE_V2: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
const NOW: i64 = 1_800_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reason {
    None,
    IssuerPause,
    VenueHalt,
    CircuitBreaker,
    CorporateAction,
}

#[derive(Debug)]
struct Breaker {
    feed_id: [u8; 32],
    window_slots: u32,
    move_bps: u32,
    last_price: i64,
    last_exponent: i32,
    last_slot: u64,
    last_publish_ts: i64,
}

#[derive(Debug)]
struct Halt {
    base_mint: Pubkey,
    authority: Pubkey,
    venue_signer: Option<Pubkey>,
    halted: bool,
    reason: Reason,
    corporate_action: bool,
    since_ts: i64,
    since_slot: u64,
    issuer_unpaused: bool,
    breaker: Option<Breaker>,
}

/// Reads a halt state the way Borsh writes it, field by field.
fn read(a: &Account) -> Halt {
    assert_eq!(a.data[..8], disc("account", "HaltState"), "discriminator");
    let d = &a.data;
    let mut at = 8;
    let pk = |at: &mut usize| {
        let v = Pubkey::new_from_array(d[*at..*at + 32].try_into().unwrap());
        *at += 32;
        v
    };
    let u8_ = |at: &mut usize| {
        *at += 1;
        d[*at - 1]
    };
    let i64_ = |at: &mut usize| {
        *at += 8;
        i64::from_le_bytes(d[*at - 8..*at].try_into().unwrap())
    };
    let u64_ = |at: &mut usize| {
        *at += 8;
        u64::from_le_bytes(d[*at - 8..*at].try_into().unwrap())
    };
    let u32_ = |at: &mut usize| {
        *at += 4;
        u32::from_le_bytes(d[*at - 4..*at].try_into().unwrap())
    };
    let base_mint = pk(&mut at);
    let authority = pk(&mut at);
    let venue_signer = (u8_(&mut at) == 1).then(|| pk(&mut at));
    let halted = u8_(&mut at) == 1;
    let reason = match u8_(&mut at) {
        0 => Reason::None,
        1 => Reason::IssuerPause,
        2 => Reason::VenueHalt,
        3 => Reason::CircuitBreaker,
        4 => Reason::CorporateAction,
        n => panic!("unknown halt reason {n}"),
    };
    let corporate_action = u8_(&mut at) == 1;
    let since_ts = i64_(&mut at);
    let since_slot = u64_(&mut at);
    let issuer_unpaused = u8_(&mut at) == 1;
    let breaker = (u8_(&mut at) == 1).then(|| {
        let feed_id: [u8; 32] = d[at..at + 32].try_into().unwrap();
        at += 32;
        let window_slots = u32_(&mut at);
        let move_bps = u32_(&mut at);
        let last_price = i64_(&mut at);
        let last_exponent = u32_(&mut at) as i32;
        let last_slot = u64_(&mut at);
        let last_publish_ts = i64_(&mut at);
        Breaker { feed_id, window_slots, move_bps, last_price, last_exponent, last_slot, last_publish_ts }
    });
    Halt { base_mint, authority, venue_signer, halted, reason, corporate_action, since_ts, since_slot, issuer_unpaused, breaker }
}

fn mollusk() -> Mollusk {
    let mut m = common::mollusk(&CORE, "cross_core");
    m.sysvars.clock.unix_timestamp = NOW;
    m.sysvars.clock.slot = 1_000;
    m
}

/// A Token-2022 mint with the pausable extension (extension type 26): the 82-byte base, zero padding to 165, the account-type byte (1 = mint),
/// then one TLV entry: type, length 33, the pause authority (all zeros: none) and the paused flag.
fn pausable_mint(authority: &Pubkey, paused: bool) -> Account {
    let mut d = mint_account(authority, 1_000).data;
    d.resize(165, 0);
    d.push(1);
    d.extend(26u16.to_le_bytes());
    d.extend(33u16.to_le_bytes());
    d.extend([0u8; 32]);
    d.push(paused as u8);
    Account { lamports: 2_000_000, data: d, owner: TOKEN_2022, executable: false, rent_epoch: 0 }
}

fn halt_ix(name: &str, signer: &Pubkey, mint: &Pubkey, args: &[u8]) -> Instruction {
    ix(CORE, name, args, vec![AccountMeta::new_readonly(*signer, true), AccountMeta::new(halt_of(mint), false)])
}
fn sync_pause(mint: &Pubkey, mint_account_key: &Pubkey) -> Instruction {
    ix(CORE, "sync_pause", &[], vec![AccountMeta::new(halt_of(mint), false), AccountMeta::new_readonly(*mint_account_key, false)])
}
fn observe(mint: &Pubkey, update: &Pubkey) -> Instruction {
    ix(CORE, "observe_price", &[], vec![AccountMeta::new(halt_of(mint), false), AccountMeta::new_readonly(*update, false)])
}
fn init_with_breaker(authority: &Pubkey, mint: &Pubkey, venue: Option<Pubkey>, feed: [u8; 32], window_slots: u32, move_bps: u32) -> Instruction {
    let mut args = vec![];
    match venue {
        Some(v) => {
            args.push(1);
            args.extend(v.to_bytes());
        }
        None => args.push(0),
    }
    args.push(1);
    args.extend(feed);
    args.extend(window_slots.to_le_bytes());
    args.extend(move_bps.to_le_bytes());
    let mut i = init_halt_state(authority, mint, None);
    i.data = [disc("global", "init_halt_state").to_vec(), args].concat();
    i
}

/// A Pyth `PriceUpdateV2` as the receiver writes it (`full` = fully verified), owned by `owner`.
fn price_update(owner: Pubkey, feed: [u8; 32], price: i64, exponent: i32, publish_time: i64, full: bool) -> Account {
    let mut d = PRICE_UPDATE_V2.to_vec();
    d.extend([0u8; 32]); // write authority
    if full {
        d.push(1);
    } else {
        d.extend([0, 5]); // Partial { num_signatures: 5 }
    }
    d.extend(feed);
    d.extend(price.to_le_bytes());
    d.extend(100u64.to_le_bytes()); // conf
    d.extend(exponent.to_le_bytes());
    d.extend(publish_time.to_le_bytes());
    d.extend((publish_time - 1).to_le_bytes()); // prev publish time
    d.extend(price.to_le_bytes()); // ema price
    d.extend(100u64.to_le_bytes()); // ema conf
    d.extend(1u64.to_le_bytes()); // posted slot
    Account { lamports: 1_000_000, data: d, owner, executable: false, rent_epoch: 0 }
}

struct World {
    m: Mollusk,
    state: State,
    admin: Pubkey,
    authority: Pubkey,
    venue: Pubkey,
    mint: Pubkey,
}

/// A protocol, a mint whose authority is `authority`, and a registered halt state with a venue signer.
fn world() -> World {
    let (admin, authority, venue, mint) = (key(1), key(0x21), key(0x22), key(0x10));
    let m = mollusk();
    let mut state: State = vec![(admin, wallet(100_000_000_000)), (authority, wallet(10_000_000_000)), (venue, wallet(10_000_000)), (mint, mint_account(&authority, 1_000))];
    assert!(run(&m, &init_protocol(&admin), &mut state).program_result.is_ok());
    let r = run(&m, &init_halt_state(&authority, &mint, Some(venue)), &mut state);
    assert!(r.program_result.is_ok(), "{:?}", r.program_result);
    World { m, state, admin, authority, venue, mint }
}

#[test]
fn a_halt_state_starts_clear_and_names_who_registered_it() {
    let w = world();
    let a = get(&w.state, &halt_of(&w.mint));
    assert_eq!(a.owner, CORE);
    let h = read(a);
    assert_eq!((h.base_mint, h.authority, h.venue_signer), (w.mint, w.authority, Some(w.venue)));
    assert_eq!((h.halted, h.reason, h.corporate_action, h.since_ts, h.since_slot, h.issuer_unpaused), (false, Reason::None, false, 0, 0, false));
    assert!(h.breaker.is_none());
}

#[test]
fn only_the_mint_authority_or_the_protocol_admin_registers_a_halt_state_for_a_token_mint() {
    let w = world();
    let (stranger, mint2) = (key(0x31), key(0x11));
    let mut s = w.state.clone();
    set(&mut s, stranger, wallet(10_000_000_000));
    set(&mut s, mint2, mint_account(&w.authority, 5));
    // A stranger, funded and signing, is neither.
    assert_eq!(custom(&run(&w.m, &init_halt_state(&stranger, &mint2, None), &mut s).program_result), Some(UNAUTHORIZED));
    assert!(s.iter().all(|(k, a)| *k != halt_of(&mint2) || a.data.is_empty()), "a refused registration created an account");
    // The protocol admin may, and becomes the halt state's authority.
    let by_admin = run(&w.m, &init_halt_state(&w.admin, &mint2, None), &mut s);
    assert!(by_admin.program_result.is_ok(), "{:?}", by_admin.program_result);
    assert_eq!(read(get(&s, &halt_of(&mint2))).authority, w.admin);
    // The mint authority may.
    let mint3 = key(0x12);
    set(&mut s, mint3, mint_account(&stranger, 5));
    assert!(run(&w.m, &init_halt_state(&stranger, &mint3, None), &mut s).program_result.is_ok());
    // It must sign.
    let mint4 = key(0x13);
    set(&mut s, mint4, mint_account(&stranger, 5));
    let mut unsigned = init_halt_state(&stranger, &mint4, None);
    unsigned.accounts[0].is_signer = false;
    assert!(run(&w.m, &unsigned, &mut s).program_result.is_err());
    // An account that is not a token mint at all is refused, whoever signs.
    let not_a_mint = key(0x14);
    let mut junk = mint_account(&w.admin, 5);
    junk.owner = key(0x99);
    set(&mut s, not_a_mint, junk);
    assert_eq!(custom(&run(&w.m, &init_halt_state(&w.admin, &not_a_mint, None), &mut s).program_result), Some(WRONG_MINT));
    // A mint without an authority leaves only the admin.
    let frozen = key(0x15);
    let mut f = mint_account(&w.authority, 5);
    f.data[0..4].copy_from_slice(&0u32.to_le_bytes());
    set(&mut s, frozen, f);
    assert_eq!(custom(&run(&w.m, &init_halt_state(&w.authority, &frozen, None), &mut s).program_result), Some(UNAUTHORIZED));
    assert!(run(&w.m, &init_halt_state(&w.admin, &frozen, None), &mut s).program_result.is_ok());
}

#[test]
fn a_halt_state_cannot_be_registered_twice_and_the_first_is_left_alone() {
    let w = world();
    let before = get(&w.state, &halt_of(&w.mint)).data.clone();
    let mut s = w.state.clone();
    let again = run(&w.m, &init_halt_state(&w.admin, &w.mint, Some(key(0x77))), &mut s);
    assert!(again.program_result.is_err(), "a second registration succeeded");
    assert_eq!(get(&s, &halt_of(&w.mint)).data, before);
}

#[test]
fn a_breaker_needs_a_window_and_a_bound_and_is_recorded_empty() {
    let w = world();
    let feed = [7u8; 32];
    for (window, bps, what) in [(0u32, 500u32, "no window"), (10, 0, "no bound")] {
        let mut s = w.state.clone();
        let mint2 = key(0x11);
        set(&mut s, mint2, mint_account(&w.authority, 5));
        let r = run(&w.m, &init_with_breaker(&w.authority, &mint2, None, feed, window, bps), &mut s);
        assert_eq!(custom(&r.program_result), Some(INVALID_PARAMS), "{what}: {:?}", r.program_result);
    }
    let mut s = w.state.clone();
    let mint2 = key(0x11);
    set(&mut s, mint2, mint_account(&w.authority, 5));
    assert!(run(&w.m, &init_with_breaker(&w.authority, &mint2, None, feed, 25, 500), &mut s).program_result.is_ok());
    let b = read(get(&s, &halt_of(&mint2))).breaker.unwrap();
    assert_eq!((b.feed_id, b.window_slots, b.move_bps, b.last_price, b.last_slot, b.last_publish_ts), (feed, 25, 500, 0, 0, 0));
}

#[test]
fn the_issuer_and_the_venue_may_halt_a_stranger_may_not_and_the_first_reason_stands() {
    let mut w = world();
    let stranger = key(0x31);
    set(&mut w.state, stranger, wallet(10_000_000));
    assert_eq!(custom(&run(&w.m, &halt_ix("set_halt", &stranger, &w.mint, &[]), &mut w.state).program_result), Some(UNAUTHORIZED));
    assert!(!read(get(&w.state, &halt_of(&w.mint))).halted);
    let mut unsigned = halt_ix("set_halt", &w.venue, &w.mint, &[]);
    unsigned.accounts[0].is_signer = false;
    assert_eq!(custom(&run(&w.m, &unsigned, &mut w.state).program_result), Some(ACCOUNT_NOT_SIGNER));

    // The venue halts first: reason, time and slot are recorded.
    let by_venue = run(&w.m, &halt_ix("set_halt", &w.venue, &w.mint, &[]), &mut w.state);
    assert!(by_venue.program_result.is_ok(), "{:?}", by_venue.program_result);
    println!("set_halt: {} compute units", by_venue.compute_units_consumed);
    let h = read(get(&w.state, &halt_of(&w.mint)));
    assert_eq!((h.halted, h.reason, h.since_ts, h.since_slot), (true, Reason::VenueHalt, NOW, 1_000));
    // A later halt by the issuer succeeds and changes nothing: the first reason and time stand.
    w.m.sysvars.clock.unix_timestamp += 60;
    w.m.sysvars.clock.slot += 150;
    assert!(run(&w.m, &halt_ix("set_halt", &w.authority, &w.mint, &[]), &mut w.state).program_result.is_ok());
    let h = read(get(&w.state, &halt_of(&w.mint)));
    assert_eq!((h.reason, h.since_ts, h.since_slot), (Reason::VenueHalt, NOW, 1_000));

    // The issuer halting a clear asset is recorded as the issuer's pause.
    let mut fresh = world();
    assert!(run(&fresh.m, &halt_ix("set_halt", &fresh.authority, &fresh.mint, &[]), &mut fresh.state).program_result.is_ok());
    assert_eq!(read(get(&fresh.state, &halt_of(&fresh.mint))).reason, Reason::IssuerPause);
}

#[test]
fn a_corporate_action_is_the_issuers_to_flag_and_flagging_halts_but_unflagging_does_not_lift() {
    let mut w = world();
    let flag = |on: bool| [on as u8];
    assert_eq!(custom(&run(&w.m, &halt_ix("set_corporate_action", &w.venue, &w.mint, &flag(true)), &mut w.state).program_result), Some(UNAUTHORIZED), "the venue is not the issuer");
    assert!(!read(get(&w.state, &halt_of(&w.mint))).corporate_action);
    assert!(run(&w.m, &halt_ix("set_corporate_action", &w.authority, &w.mint, &flag(true)), &mut w.state).program_result.is_ok());
    let h = read(get(&w.state, &halt_of(&w.mint)));
    assert_eq!((h.corporate_action, h.halted, h.reason, h.since_ts), (true, true, Reason::CorporateAction, NOW));
    // Clearing the flag does not resume trading: only a printing resume cross does.
    assert!(run(&w.m, &halt_ix("set_corporate_action", &w.authority, &w.mint, &flag(false)), &mut w.state).program_result.is_ok());
    let h = read(get(&w.state, &halt_of(&w.mint)));
    assert_eq!((h.corporate_action, h.halted, h.reason), (false, true, Reason::CorporateAction));
}

#[test]
fn a_paused_token_2022_mint_is_copied_in_by_anyone_and_an_unpause_only_marks_the_halt_resumable() {
    let mut w = world();
    let t22 = key(0x40);
    // A halt state registered for a Token-2022 mint with the pausable extension.
    set(&mut w.state, t22, pausable_mint(&w.authority, false));
    assert!(run(&w.m, &init_halt_state(&w.authority, &t22, None), &mut w.state).program_result.is_ok());
    // Not paused: nothing happens, and anyone may ask.
    assert!(run(&w.m, &sync_pause(&t22, &t22), &mut w.state).program_result.is_ok());
    assert!(!read(get(&w.state, &halt_of(&t22))).halted);
    // Paused: the asset halts as the issuer's pause, at the chain's time and slot.
    set(&mut w.state, t22, pausable_mint(&w.authority, true));
    let r = run(&w.m, &sync_pause(&t22, &t22), &mut w.state);
    assert!(r.program_result.is_ok(), "{:?}", r.program_result);
    println!("sync_pause (paused): {} compute units", r.compute_units_consumed);
    let h = read(get(&w.state, &halt_of(&t22)));
    assert_eq!((h.halted, h.reason, h.since_ts, h.since_slot, h.issuer_unpaused), (true, Reason::IssuerPause, NOW, 1_000, false));
    // Unpaused again: the halt stays, and is marked so a keeper knows to schedule the resume cross.
    set(&mut w.state, t22, pausable_mint(&w.authority, false));
    assert!(run(&w.m, &sync_pause(&t22, &t22), &mut w.state).program_result.is_ok());
    let h = read(get(&w.state, &halt_of(&t22)));
    assert_eq!((h.halted, h.reason, h.issuer_unpaused), (true, Reason::IssuerPause, true));
    // A classic SPL mint has no pause: syncing it never halts.
    assert!(run(&w.m, &sync_pause(&w.mint, &w.mint), &mut w.state).program_result.is_ok());
    assert!(!read(get(&w.state, &halt_of(&w.mint))).halted);
    // The mint passed must be the one the halt state is for.
    let wrong = run(&w.m, &sync_pause(&w.mint, &t22), &mut w.state);
    assert_eq!(custom(&wrong.program_result), Some(HALT_MISMATCH), "{:?}", wrong.program_result);
}

struct Oracle {
    w: World,
    update: Pubkey,
    feed: [u8; 32],
}

/// A halt state with a breaker on `feed` (window 25 slots, bound 5%).
fn oracle() -> Oracle {
    let mut w = world();
    let (mint, feed, update) = (key(0x50), [9u8; 32], key(0x51));
    set(&mut w.state, mint, mint_account(&w.authority, 5));
    assert!(run(&w.m, &init_with_breaker(&w.authority, &mint, None, feed, 25, 500), &mut w.state).program_result.is_ok());
    w.mint = mint;
    Oracle { w, update, feed }
}
impl Oracle {
    fn post(&mut self, owner: Pubkey, feed: [u8; 32], price: i64, exponent: i32, publish_time: i64, full: bool) {
        set(&mut self.w.state, self.update, price_update(owner, feed, price, exponent, publish_time, full));
    }
    fn observe(&mut self) -> mollusk_svm::result::InstructionResult {
        let i = observe(&self.w.mint, &self.update);
        run(&self.w.m, &i, &mut self.w.state)
    }
    fn halt(&self) -> Halt {
        read(get(&self.w.state, &halt_of(&self.w.mint)))
    }
}

#[test]
fn the_breaker_records_the_first_update_and_halts_on_a_move_past_its_bound_inside_the_window() {
    let mut o = oracle();
    o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, true);
    let first = o.observe();
    assert!(first.program_result.is_ok(), "{:?}", first.program_result);
    println!("observe_price (first): {} compute units", first.compute_units_consumed);
    let b = o.halt().breaker.unwrap();
    assert_eq!((b.last_price, b.last_exponent, b.last_slot, b.last_publish_ts), (10_000, -2, 1_000, NOW - 5));
    assert!(!o.halt().halted, "one observation cannot trip the breaker");

    // Exactly at the bound (5%) does not trip it; one tick past does.
    o.w.m.sysvars.clock.slot = 1_010;
    o.w.m.sysvars.clock.unix_timestamp = NOW + 10;
    o.post(PYTH_RECEIVER_UPGRADED, o.feed, 10_500, -2, NOW + 5, true);
    assert!(o.observe().program_result.is_ok());
    assert!(!o.halt().halted, "a 5.00% move is within a 5% bound");
    o.w.m.sysvars.clock.slot = 1_020;
    o.w.m.sysvars.clock.unix_timestamp = NOW + 20;
    o.post(PYTH_RECEIVER, o.feed, 11_026, -2, NOW + 15, true); // 11,026 vs 10,500: 5.0095%
    let tripped = o.observe();
    assert!(tripped.program_result.is_ok(), "{:?}", tripped.program_result);
    let h = o.halt();
    assert_eq!((h.halted, h.reason, h.since_ts, h.since_slot), (true, Reason::CircuitBreaker, NOW + 20, 1_020));
    println!("observe_price (trips): {} compute units", tripped.compute_units_consumed);
}

#[test]
fn a_move_down_trips_it_too_and_a_move_outside_the_window_or_across_exponents_is_not_compared() {
    // Down: 10,000 to 9,499 is 5.01%.
    let mut o = oracle();
    o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, true);
    assert!(o.observe().program_result.is_ok());
    o.w.m.sysvars.clock.slot = 1_005;
    o.post(PYTH_RECEIVER, o.feed, 9_499, -2, NOW - 1, true);
    assert!(o.observe().program_result.is_ok());
    assert_eq!(o.halt().reason, Reason::CircuitBreaker);

    // Outside the 25-slot window: recorded, not compared.
    let mut o = oracle();
    o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, true);
    assert!(o.observe().program_result.is_ok());
    o.w.m.sysvars.clock.slot = 1_000 + 26;
    o.post(PYTH_RECEIVER, o.feed, 20_000, -2, NOW - 1, true);
    assert!(o.observe().program_result.is_ok());
    assert!(!o.halt().halted, "a doubling 26 slots later was compared across a 25-slot window");
    assert_eq!(o.halt().breaker.unwrap().last_price, 20_000);

    // A different exponent is a different unit: not compared either.
    let mut o = oracle();
    o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, true);
    assert!(o.observe().program_result.is_ok());
    o.w.m.sysvars.clock.slot = 1_005;
    o.post(PYTH_RECEIVER, o.feed, 20_000, -4, NOW - 1, true);
    assert!(o.observe().program_result.is_ok());
    assert!(!o.halt().halted);
    assert_eq!(o.halt().breaker.unwrap().last_exponent, -4);
}

#[test]
fn an_update_that_is_not_what_the_breaker_trusts_is_refused_and_changes_nothing() {
    let cases: [(&str, Box<dyn Fn(&mut Oracle)>); 8] = [
        ("another feed", Box::new(|o| o.post(PYTH_RECEIVER, [8u8; 32], 10_000, -2, NOW - 5, true))),
        ("not fully verified", Box::new(|o| o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, false))),
        ("not written by a Pyth receiver", Box::new(|o| o.post(key(0x99), o.feed, 10_000, -2, NOW - 5, true))),
        ("older than 120 seconds", Box::new(|o| o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 121, true))),
        ("a price of zero", Box::new(|o| o.post(PYTH_RECEIVER, o.feed, 0, -2, NOW - 5, true))),
        ("a negative price", Box::new(|o| o.post(PYTH_RECEIVER, o.feed, -5, -2, NOW - 5, true))),
        ("malformed data", Box::new(|o| {
            let mut a = price_update(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, true);
            a.data.truncate(60);
            set(&mut o.w.state, o.update, a);
        })),
        ("a different account type", Box::new(|o| {
            let mut a = price_update(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, true);
            a.data[..8].copy_from_slice(&[1; 8]);
            set(&mut o.w.state, o.update, a);
        })),
    ];
    for (what, make) in cases {
        let mut o = oracle();
        make(&mut o);
        let before = get(&o.w.state, &halt_of(&o.w.mint)).data.clone();
        let r = o.observe();
        assert_eq!(custom(&r.program_result), Some(ORACLE_UNAVAILABLE), "{what}: {:?}", r.program_result);
        assert_eq!(get(&o.w.state, &halt_of(&o.w.mint)).data, before, "{what}: a refused update changed the halt state");
    }
    // 120 seconds old exactly is still accepted.
    let mut o = oracle();
    o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 120, true);
    assert!(o.observe().program_result.is_ok());
}

#[test]
fn an_update_can_never_be_replayed_and_an_older_one_cannot_follow_a_newer() {
    let mut o = oracle();
    o.post(PYTH_RECEIVER, o.feed, 10_000, -2, NOW - 5, true);
    assert!(o.observe().program_result.is_ok());
    // The same update again, and an older one, are refused: a stale price must not be able to trip the breaker.
    assert_eq!(custom(&o.observe().program_result), Some(ORACLE_UNAVAILABLE), "the same update twice");
    o.post(PYTH_RECEIVER, o.feed, 20_000, -2, NOW - 6, true);
    assert_eq!(custom(&o.observe().program_result), Some(ORACLE_UNAVAILABLE), "an older update");
    assert!(!o.halt().halted);
    o.post(PYTH_RECEIVER, o.feed, 10_100, -2, NOW - 4, true);
    assert!(o.observe().program_result.is_ok(), "a newer one is accepted");
}

#[test]
fn observing_a_price_for_an_asset_with_no_breaker_is_refused() {
    let mut w = world(); // registered without a breaker
    set(&mut w.state, key(0x51), price_update(PYTH_RECEIVER, [9u8; 32], 10_000, -2, NOW - 5, true));
    let r = run(&w.m, &observe(&w.mint, &key(0x51)), &mut w.state);
    assert_eq!(custom(&r.program_result), Some(INVALID_PARAMS), "{:?}", r.program_result);
}

#[test]
fn the_system_program_refuses_to_create_the_halt_account_twice() {
    // Documented from the error itself: the second registration fails inside the system program, not in cross_core's own checks.
    let w = world();
    let mut s = w.state.clone();
    let r = run(&w.m, &init_halt_state(&w.authority, &w.mint, Some(w.venue)), &mut s);
    assert_eq!(custom(&r.program_result), Some(ACCOUNT_ALREADY_IN_USE), "{:?}", r.program_result);
}
