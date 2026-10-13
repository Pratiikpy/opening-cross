# ADR-0304: A subscription is a transfer the chain proves, and entitlement never gates the program

Status: accepted (2026-10-13) · Row Y8 · Builds on `packages/fees` rate card · Code `services/billing` · Evidence `W2A-Y8-billing.md`

## Decision

1. **A plan is bought with an ordinary token transfer** to the revenue wallet, in the same transaction as a memo `oc-sub:1:<plan>`. The service builds the unsigned transaction (the issuer is the only signer and the fee payer) and later reads the payment back from the chain.
2. **The chain, not the request, says what was paid.** The amount is the change in the revenue token account's balance; the payer is the authority of the transfer into that account; the plan is the memo. A figure written in an instruction's text is not trusted.
3. **A payment is recorded once, by signature.** A repeat report changes nothing. A payment below the plan price, or for a plan that does not exist, buys nothing and is listed as rejected.
4. **A payment buys one period; paying early extends the running period** (`entitlementPeriods` from `packages/fees`). The period begins at the payment's block time.
5. **Entitlement is a fact other services read.** The program stays permissionless: anyone can create a cross, and the protocol fee is charged either way. A subscription buys the managed service (scheduler, keeper, hosted API, signed bands).
6. **Invoices are signed documents** (ADR-0318). A finished period's invoice is dated its end, so issuing it twice gives the same document, kept once; an open period's invoice is a preview and is not kept.
7. **The default "now" is never earlier than the issuer's latest payment**: this machine's clock can run behind the chain's block time, and a payer must not be told "not entitled" about a period that started a second ago.

## Alternatives rejected

- Paying through the x402 gate: a plan is a 30-day entitlement tied to a payer wallet, which a direct transfer proves more simply; x402 serves per-call products.
- A card processor or invoice in fiat: needs a legal entity and an account (HUMAN); the chain path works now.
- Trusting the client to report amount and payer: the instruction text can say anything.

## Consequences

Prices are the proposed rate card until HD1. There is no dunning, refund or cancellation. The scheduler does not yet read entitlements.
