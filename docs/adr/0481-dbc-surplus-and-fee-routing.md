# ADR-0481: Where each DBC partner payout goes

Status: accepted (2026-10-13) · Rows D7, D4 · Builds on ADR-0480

## Decision

| Payout | Destination | Why |
|---|---|---|
| Partner trading fees | owner `Cross.fee_recipient` | A fee is the protocol's revenue (PRODUCT_FEATURES [W6], fee model P2). |
| Partner migration fee | owner `Cross.fee_recipient` | Same: it is a fee on the migration, set in the config the issuer chose and published. |
| Pool-creation fee | `Cross.fee_recipient` wallet | A fee paid to the partner. |
| Partner surplus | owner `Cross.proceeds_to` | The quote above the migration threshold is the issuer's raise, not a fee. The greenshoe (D4) and the treasury (X2) need it where the issuer's treasury can reach it. |
| Fees of the protocol-owned liquidity position (ADR-0482) | owner `Cross.proceeds_to` | The liquidity was bought with the issuer's raise; its fees are the issuer's, who may route them onward through a fee-sharing vault (ADR-0024). |

`proceeds_to` and `fee_recipient` are the two payout addresses a cross already carries and snapshots; no new authority or address is introduced, and a destination is accepted only if the token account's owner equals it.

## Alternatives rejected

- Letting the caller pass any destination and checking a signature: turns permissionless cranks into authority-gated ones with no gain.
- Sending surplus to the fee recipient: takes issuer capital as protocol revenue.
- Making the fee-sharing vault the DBC claimer: the vault then holds all of the partner's money and the protocol has no way to take its fee off the top.
