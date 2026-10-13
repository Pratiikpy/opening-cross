# ADR-0405: Sponsored fees: the server builds and signs only its own transaction

Status: accepted (2026-10-13)

Rows I6, S14

## Context

A holder with tokens and no SOL cannot place an order: the network fee and the 0.0016 SOL deposit for the order account are paid by the owner.

## Decision

`POST /v1/tx/place-order-sponsored` builds the whole transaction itself: at most a system transfer that tops the owner up to the order account's rent, and the same `commit_order` instruction the app builds, with the sponsor as fee payer. It signs that message and returns it for the owner to sign. The sponsor never signs a client-supplied transaction. An order the program would refuse (off-grid price, unfunded escrow, used nonce, closed cross) is refused before signing, because the sponsor pays the fee for a failed transaction. Limits: five sponsored orders per wallet per UTC day and a daily total, both reported by `GET /v1/sponsor`. The rent advance is a gift: it returns to the owner when the order is claimed or cancelled.

A real fix would add a separate rent payer to `commit_order`; that is a program change and is reported as such, but the advance works today with the deployed program.

## Verification

Route tests decode the signed transaction and read its instructions; a devnet run with a wallet that held tokens and no SOL (docs/evidence/W2C-I6.md).
