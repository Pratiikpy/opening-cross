# ADR-0961: The keeper claims the protocol's DBC partner fees on a schedule

Status: accepted (2026-10-16) · Row P2 · Builds on ADR-0480, ADR-0481 (the settler PDA is the DBC partner; where each payout goes), ADR-0703 · Code `services/keeper/src/partner-fees.ts` · Evidence `W5-1G.md`

## Context

`cross_settle::claim_partner_fee` pays the partner's accrued trading fees to token accounts owned by `Cross.fee_recipient` and refuses any other destination, so anyone may send it (ADR-0480). Nothing sent it. The fee accrues in the DBC pool account until someone does.

## Decision

1. A keeper duty `partner-fees`, **done only when named** in `KEEPER_DUTIES`. It costs the keeper transaction fees and, once per cross, the rent of the fee recipient's two token accounts, so a third party running a keeper never subsidises the protocol's revenue by default.
2. **On a schedule, not every pass.** A pool is read at most once per `KEEPER_PARTNER_FEE_EVERY_SECS` (default 3,600), and a claim is sent only when the partner's accrued quote fee reaches `KEEPER_MIN_PARTNER_QUOTE` or the base fee reaches `KEEPER_MIN_PARTNER_BASE` (both default 1). The time of the last look is kept in the keeper's memory; a restarted keeper looks once more, which costs one read. A failed claim is retried at the next interval, not the next pass.
3. **The pool is read from its account bytes**, at offsets taken from Meteora's IDL (`partner_base_fee` 264, `partner_quote_fee` 272 after the 8-byte discriminator; the account is 8 + 416 bytes). The offsets, the size and both pool discriminators (`VirtualPool`, `TransferHookPool`) are asserted against the IDL file in a test, and Anchor's IDL-driven decoder reads the same values out of bytes laid out as the keeper expects. A claim is built only if bytes are a pool of either kind.
4. Candidates are the crosses that have cleared with a bound base mint, finalized ones included (a pool earns long after its cross is finalized); the pool address is derived (`continuationAddresses`), and a cross whose pool does not exist costs one read per interval and nothing else.
5. The claim transaction opens the fee recipient's quote and base token accounts (idempotent, paid by the keeper) and sends `claim_partner_fee` for everything that has accrued. The destinations are the cross's `fee_recipient`, never the keeper.
6. The adapters package, which carries the instruction builder, is loaded when the duty first has a cross to look at, not at start-up.

## Not claimed by this duty

The partner's migration fee, partner surplus and pool-creation fee are one-off payouts whose state is not in the pool's trading counters; the creator's share of trading fees is the issuer's to claim with DBC's own instruction (ADR-0481). They are left to a person or a later duty.

## Alternatives rejected

- Claiming on every pass: one RPC read and, at a 15 s pass, 240 reads an hour per cross for fees that change slowly.
- Claiming without a minimum: dust claims cost more in fees than they move; the operator sets the floor.
- Decoding the pool with the Meteora SDK: it brings web3.js and a second account decoder into the keeper's hot path for two integers; the IDL check gives the same assurance.
- Default-on: spends a stranger's money on the protocol's accounts.

## Consequences

Needs the upgraded `cross_settle` (H27 on devnet). Exactly what was proved, and what was not, is in `W5-1G.md`.
