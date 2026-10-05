//! The bindings must describe the programs exactly: same IDs, same seeds, same derivations.
use anchor_lang::prelude::Pubkey;
use opening_cross_cpi::{cross_core, cross_gate, pda};

#[test]
fn program_ids_match() {
    assert_eq!(cross_core::ID, core_program::ID);
    assert_eq!(cross_gate::ID, gate_program::ID);
}

#[test]
fn seeds_match() {
    use core_program::state as s;
    assert_eq!(pda::PROTOCOL_SEED, s::PROTOCOL_SEED);
    assert_eq!(pda::CROSS_SEED, s::CROSS_SEED);
    assert_eq!(pda::BOOK_SEED, s::BOOK_SEED);
    assert_eq!(pda::SHARD_SEED, s::SHARD_SEED);
    assert_eq!(pda::ORDER_SEED, s::ORDER_SEED);
    assert_eq!(pda::QUOTE_VAULT_SEED, s::QUOTE_VAULT_SEED);
    assert_eq!(pda::BASE_VAULT_SEED, s::BASE_VAULT_SEED);
    assert_eq!(pda::GATE_CONFIG_SEED, gate_program::CONFIG_SEED);
    assert_eq!(pda::GATE_PASS_SEED, gate_program::PASS_SEED);
}

#[test]
fn derivations_are_program_addresses() {
    let creator = Pubkey::new_unique();
    let (cross, _) = pda::cross(&creator, 7);
    let expect = Pubkey::find_program_address(
        &[b"cross", creator.as_ref(), &7u64.to_le_bytes()],
        &core_program::ID,
    )
    .0;
    assert_eq!(cross, expect);
    let owner = Pubkey::new_unique();
    assert_eq!(
        pda::order(&cross, &owner, 3).0,
        Pubkey::find_program_address(
            &[
                b"order",
                cross.as_ref(),
                owner.as_ref(),
                &3u64.to_le_bytes()
            ],
            &core_program::ID
        )
        .0
    );
    assert_eq!(pda::shard_index_for(5, 2), 1);
}

#[test]
fn account_types_round_trip() {
    // An Order serialised by the program decodes into the binding's type field for field.
    use anchor_lang::{AccountDeserialize, AccountSerialize};
    use core_program::state::{Order, OrderSide, OrderState};
    let order = Order {
        cross: Pubkey::new_unique(),
        owner: Pubkey::new_unique(),
        nonce: 42,
        index: 9,
        side: OrderSide::Sell,
        state: OrderState::Revealed,
        commitment: [7; 32],
        price: 1_300_000,
        quantity: 2_000_000_000,
        escrow: 2_000_000_000,
        bump: 254,
    };
    let mut bytes = Vec::new();
    order.try_serialize(&mut bytes).unwrap();
    let decoded = cross_core::accounts::Order::try_deserialize(&mut bytes.as_slice()).unwrap();
    assert_eq!(
        (decoded.cross, decoded.owner, decoded.nonce, decoded.index),
        (order.cross, order.owner, 42, 9)
    );
    assert_eq!(
        (
            decoded.price,
            decoded.quantity,
            decoded.escrow,
            decoded.commitment,
            decoded.bump
        ),
        (1_300_000, 2_000_000_000, 2_000_000_000, [7; 32], 254)
    );
    assert!(matches!(decoded.side, cross_core::types::OrderSide::Sell));
    assert!(matches!(
        decoded.state,
        cross_core::types::OrderState::Revealed
    ));
}
