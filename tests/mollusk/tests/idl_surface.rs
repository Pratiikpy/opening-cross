//! The whole instruction surface of the deployed binaries, from their IDLs: 12 programs and every instruction in them.
//!
//! What a single instruction does with real accounts is for the suites beside this one. What is checked here is the part that is
//! cheap and that breaks quietly: that each IDL's discriminators are the ones the program dispatches on, that every instruction
//! routes to a handler (and nothing else answers to an unknown discriminator), that the IDL's address is the id the binary was built
//! for, and what every instruction costs to refuse an empty call.
mod common;

use common::*;
use mollusk_svm::result::ProgramResult;
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;

struct Program {
    name: &'static str,
    so: &'static str,
    idl: &'static str,
}

const PROGRAMS: [Program; 12] = [
    Program { name: "cross_core", so: "cross_core", idl: "../../packages/cross-core-client/idl/cross_core.json" },
    Program { name: "cross_gate", so: "cross_gate", idl: "../../packages/cross-gate-client/idl/cross_gate.json" },
    Program { name: "cross_settle", so: "cross_settle", idl: "../../packages/cross-settle-client/idl/cross_settle.json" },
    Program { name: "cross_calendar", so: "cross_calendar", idl: "../../packages/cross-calendar-client/idl/cross_calendar.json" },
    Program { name: "treasury", so: "treasury", idl: "../../idls/treasury.json" },
    Program { name: "cross_mandate", so: "cross_mandate", idl: "../../packages/cross-mandate-client/idl/cross_mandate.json" },
    Program { name: "cross_conviction", so: "cross_conviction", idl: "../../packages/cross-conviction-client/idl/cross_conviction.json" },
    Program { name: "cross_basket", so: "cross_basket", idl: "../../packages/cross-basket-client/idl/cross_basket.json" },
    Program { name: "cross_listing", so: "cross_listing", idl: "../../packages/cross-listing-client/idl/cross_listing.json" },
    Program { name: "cross_bounty", so: "cross_bounty", idl: "../../packages/cross-bounty-client/idl/cross_bounty.json" },
    Program { name: "cross_backing", so: "cross_backing", idl: "../../packages/cross-backing-client/idl/cross_backing.json" },
    Program { name: "cross_graduate", so: "cross_graduate", idl: "../../packages/cross-graduate-client/idl/cross_graduate.json" },
];

/// Instructions whose discriminator is defined by an interface the program implements, not derived from the name by Anchor: Token ACL's
/// `can_thaw_permissionless` and `can_freeze_permissionless`, and the transfer-hook interface's `execute` and its account-list initialiser.
/// They are still dispatched (the next test proves it); they only do not follow `sha256("global:<name>")`.
const INTERFACE_DISCRIMINATORS: [(&str, &str); 4] = [
    ("cross_gate", "can_freeze_permissionless"),
    ("cross_gate", "can_thaw_permissionless"),
    ("cross_gate", "execute"),
    ("cross_gate", "init_hook_metas"),
];

/// What the IDLs list but the binary in `target/deploy` does not route. Empty since `cross_gate.so` was rebuilt on 2026-10-16: it had been built before 17 instructions
/// were added to the program and its IDL, and routed 17 of the 34. The mechanism stays so that a stale binary is found again the day it happens: the test compares the
/// instructions a binary does not route with this list in both directions, so an IDL that runs ahead of its binary fails here until the binary is rebuilt (or the instruction
/// is listed on purpose), and a binary that learns an instruction fails here until the list shrinks.
const UNROUTED_BY_THE_BUILT_BINARY: [(&str, &str); 0] = [];

fn idl(p: &Program) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(p.idl).unwrap_or_else(|e| panic!("{}: {e}", p.idl))).unwrap()
}
fn address(v: &serde_json::Value) -> Pubkey {
    Pubkey::from_str_const(v["address"].as_str().expect("an IDL names its program address"))
}
fn bytes8(v: &serde_json::Value) -> [u8; 8] {
    let a: Vec<u8> = v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
    a.try_into().unwrap()
}
fn names(v: &serde_json::Value, key: &str) -> Vec<(String, [u8; 8])> {
    v[key].as_array().map(|a| a.iter().map(|x| (x["name"].as_str().unwrap().to_string(), bytes8(&x["discriminator"]))).collect()).unwrap_or_default()
}
fn snake_to_camel(s: &str) -> String {
    s.split('_').map(|w| w[..1].to_uppercase() + &w[1..]).collect()
}
fn call(id: &Pubkey, data: &[u8]) -> Instruction {
    Instruction::new_with_bytes(*id, data, vec![])
}

#[test]
fn every_discriminator_in_every_idl_is_the_one_anchor_derives_from_the_name() {
    let mut checked = 0;
    for p in &PROGRAMS {
        let v = idl(p);
        for (name, d) in names(&v, "instructions") {
            let interface = INTERFACE_DISCRIMINATORS.contains(&(p.name, name.as_str()));
            if interface {
                assert_ne!(d, disc("global", &name), "{}::{name} now follows Anchor's derivation: take it off the interface list", p.name);
            } else {
                assert_eq!(d, disc("global", &name), "{}: instruction {name}", p.name);
            }
            checked += 1;
        }
        for (name, d) in names(&v, "accounts") {
            assert_eq!(d, disc("account", &name), "{}: account {name}", p.name);
            checked += 1;
        }
        for (name, d) in names(&v, "events") {
            assert_eq!(d, disc("event", &name), "{}: event {name}", p.name);
            checked += 1;
        }
    }
    println!("{checked} discriminators agree with their names");
    assert!(checked > 300, "only {checked} discriminators were checked");
}

#[test]
fn every_instruction_of_every_program_reaches_its_handler_and_refuses_an_empty_call() {
    let mut total = 0;
    for p in &PROGRAMS {
        let v = idl(p);
        let id = address(&v);
        let m = mollusk(&id, p.so);
        let mut worst = 0u64;
        let mut count = 0;
        let mut unrouted: Vec<String> = vec![];
        for (name, d) in names(&v, "instructions") {
            // The discriminator alone: no arguments, no accounts. Reaching the handler's own checks is the point; what comes back is
            // one of the framework's refusals of an incomplete call, never the "no such instruction" answer and never success.
            let r = m.process_instruction(&call(&id, &d), &[]);
            let code = custom(&r.program_result);
            assert!(!matches!(r.program_result, ProgramResult::Success), "{}::{name} succeeded with no accounts", p.name);
            if code == Some(INSTRUCTION_FALLBACK_NOT_FOUND) {
                unrouted.push(name);
                continue;
            }
            assert!(
                matches!(code, Some(INSTRUCTION_DID_NOT_DESERIALIZE) | Some(ACCOUNT_NOT_ENOUGH_KEYS)) || code.is_some_and(|c| c >= 6000),
                "{}::{name}: unexpected result {:?}",
                p.name,
                r.program_result
            );
            worst = worst.max(r.compute_units_consumed);
            count += 1;
        }
        let pinned: Vec<&str> = UNROUTED_BY_THE_BUILT_BINARY.iter().filter(|(prog, _)| *prog == p.name).map(|(_, n)| *n).collect();
        unrouted.sort();
        assert_eq!(unrouted.iter().map(String::as_str).collect::<Vec<_>>(), pinned, "{}: the instructions the binary does not route are not the pinned list", p.name);
        println!("{}: {count} of {} instructions dispatch ({} unrouted by the built binary); the most an empty call costs is {worst} compute units", p.name, count + unrouted.len(), unrouted.len());
        total += count;
    }
    println!("{total} instructions in all");
    assert!(total >= 150, "only {total} instructions were exercised");
}

#[test]
fn an_unknown_discriminator_and_a_call_too_short_to_hold_one_are_refused_by_name() {
    for p in &PROGRAMS {
        let v = idl(p);
        let id = address(&v);
        let m = mollusk(&id, p.so);
        let known: Vec<[u8; 8]> = names(&v, "instructions").into_iter().map(|(_, d)| d).collect();
        let unknown = disc("global", "this_instruction_does_not_exist");
        assert!(!known.contains(&unknown));
        let r = m.process_instruction(&call(&id, &unknown), &[]);
        assert_eq!(custom(&r.program_result), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{}: {:?}", p.name, r.program_result);
        // The IDL's account discriminators are not instruction discriminators: an account's name must not dispatch as an instruction.
        for (name, d) in names(&v, "accounts") {
            if known.contains(&d) {
                continue;
            }
            let r = m.process_instruction(&call(&id, &d), &[]);
            assert_eq!(custom(&r.program_result), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{}: account {name} dispatched as an instruction", p.name);
        }
        // Fewer than eight bytes cannot hold a discriminator at all: Anchor 1.0 answers these with the same "no such instruction" error.
        for len in [0usize, 1, 7] {
            let r = m.process_instruction(&call(&id, &vec![0xab; len]), &[]);
            assert_eq!(custom(&r.program_result), Some(INSTRUCTION_FALLBACK_NOT_FOUND), "{}: {len} bytes: {:?}", p.name, r.program_result);
        }
    }
}

#[test]
fn each_binary_is_built_for_the_address_its_idl_names() {
    for p in &PROGRAMS {
        let v = idl(p);
        let id = address(&v);
        // Loaded at its own address, a call is refused for its content; loaded anywhere else, the program's declared id check refuses it first.
        let elsewhere = key(0xee);
        assert_ne!(id, elsewhere);
        let m = mollusk(&elsewhere, p.so);
        let first = names(&v, "instructions").remove(0).1;
        let r = m.process_instruction(&call(&elsewhere, &first), &[]);
        assert_eq!(custom(&r.program_result), Some(DECLARED_PROGRAM_ID_MISMATCH), "{} runs at an address other than the one in its IDL: {:?}", p.name, r.program_result);
        let at_home = mollusk(&id, p.so).process_instruction(&call(&id, &first), &[]);
        assert_ne!(custom(&at_home.program_result), Some(DECLARED_PROGRAM_ID_MISMATCH), "{} refuses to run at the address in its own IDL", p.name);
    }
}

#[test]
fn instruction_names_and_error_numbers_are_unique_in_every_idl() {
    for p in &PROGRAMS {
        let v = idl(p);
        let mut seen = std::collections::HashSet::new();
        let mut camel = std::collections::HashSet::new();
        for (name, _) in names(&v, "instructions") {
            assert!(seen.insert(name.clone()), "{}: instruction {name} appears twice", p.name);
            // The camel-case form is what a client library calls an instruction; two names that collapse to one would collide there.
            assert!(camel.insert(snake_to_camel(&name)), "{}: {name} collides with another instruction once camel-cased", p.name);
        }
        let mut codes = std::collections::HashSet::new();
        for e in v["errors"].as_array().cloned().unwrap_or_default() {
            let code = e["code"].as_u64().unwrap();
            assert!(code >= 6000, "{}: custom error {} below 6000 would shadow a framework error", p.name, e["name"]);
            assert!(codes.insert(code), "{}: error code {code} is used twice", p.name);
        }
    }
}
