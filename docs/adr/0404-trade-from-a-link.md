# ADR-0404: Trade from a link: Solana Actions

Status: accepted (2026-10-13)

Row S10

## Context

Bidding from a feed, a wallet or a chat needs a link that carries the action.

## Decision

Solana Actions (https://solana.com/docs/advanced/actions): `GET /v1/actions/crosses/:address` answers the action (title, description, a two-parameter bid form, disabled with the reason when a cross is sealed, not open or settled) and `POST .../bid?price=&quantity=` with `{ account }` answers the order transaction the app itself builds, so a bid from a link has the same escrow and refund as one from the page. Errors use the spec's `{ message }` shape. Sealed crosses are not offered: a sealed bid needs its salt kept on the bidder's device, which a link cannot do. The cross page shows the `solana-action:` link and a check of what the endpoint answers.

Not done: an `actions.json` at the web root (the action link names the API directly, which the spec allows), a webhook product (L6), and a run in a blink client (no wallet extension or feed renderer was available here).
