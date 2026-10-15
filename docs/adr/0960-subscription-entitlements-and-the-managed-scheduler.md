# ADR-0960: A subscription conditions the keeper's own spend, never the program and never a user's money

Status: accepted (2026-10-16) · Row Y8 · Builds on ADR-0304 (subscription billing), ADR-0456 (the series scheduler), ADR-0703 (keeper duties) · Code `services/keeper/src/entitlements.ts`, `services/keeper/src/keeper.ts` (`entitlementHold`), `services/billing/src/store.ts` · Evidence `W5-1G.md`

## Context

ADR-0304 made entitlement "a fact other services read" and recorded that the scheduler did not read it yet. The managed service an issuer pays for is the keeper spawning the next cross of their recurring series: `spawn_next` is permissionless, but whoever sends it pays the rent of every account of the cross it creates, and nothing returns that rent (ADR-0456). A keeper that spawns for everyone gives that service away.

Two facts found while building this change the design:

1. A cross made by `spawn_next` has the **series' address** as its creator, not the issuer's wallet. The billing usage count (`creator = issuer AND kind = 3`) therefore saw none of the crosses a subscriber's scheduler ran, and an issuer could never be shown, or invoiced for, the overage.
2. Every other thing the keeper does for a cross (clearing, claims, refunds, finalizing, lock releases) moves **users' money**, not the issuer's.

## Decision

1. The keeper takes an optional entitlement source (`KeeperDeps.entitlement`, built from `KEEPER_BILLING_URL` by `billingEntitlements`). When it is present, the `series` duty spawns a series' next cross only if the series authority has a paid period. Without it the keeper behaves as before.
2. **Only the keeper's own spend is conditioned.** Settling, claims, refunds, finalizing, lock releases, challenge expiry, halts, graduation and backing are never held back by a subscription, whoever the issuer is. The program stays permissionless: the skip says "`spawn_next` is permissionless, and anyone may send it" (`NOT_ENTITLED`).
3. The client asks the billing route with no time of its own, so the route's default applies: never earlier than the issuer's latest payment. An issuer whose payment's block time is ahead of the keeper's clock is entitled at once (the defect found on devnet in `W2A-Y8-billing.md`).
4. **Failure is a wait, not a guess.** A billing service that is down or answers the wrong shape gives `ENTITLEMENT_UNKNOWN` and nothing is spawned. An earlier answer stands in for up to 24 hours: a refusal as it was, an entitlement only until its own period ends. An issuer never seen while billing is down is not served.
5. Answers are cached for 60 s when entitled and 10 s when not, so an issuer who has just paid is served by the next pass.
6. `KEEPER_ENTITLEMENT_EXEMPT` lists series authorities served without a subscription (the operator's own).
7. Billing counts **the crosses of the issuer's series** as well as recurring crosses the wallet created: `creator IN (SELECT address FROM series WHERE authority = issuer)`, whatever the series' kind.

## Alternatives rejected

- Gating every duty on the subscription: strands a buyer's refund because the issuer did not renew. Users' money first.
- Reading the billing tables from the keeper's database connection: couples the keeper to billing's schema; the HTTP route is the contract other services are meant to read (ADR-0304).
- Failing open when billing is unreachable: an outage would make the rent-paying service free for everyone for its duration.
- Counting usage by wallet alone: invoices would never show the overage that the scheduler creates.

## Consequences

Prices are still the proposed rate card (HD1). There is no dunning, refund or cancellation. A series spawned while billing was unreachable and not entitled is spawned by the next pass after it recovers, or by anyone. Billing configuration is H35.

## Evidence

`services/keeper/test/entitlements.test.ts` (16): the HTTP client against a real server (caching, stale on error, lapse of a stale yes, malformed answers, timeouts), the series duty (subscriber, non-subscriber, unknown, exempt, no billing, no request when nothing is due) and the statement that clearing, claims, finalizing and lock releases are done for an unsubscribed issuer; mutation-checked. `services/billing/test/entitlements-consumer.test.ts` (8, Postgres): the keeper's client against the real billing routes, a payment read back from the chain double, an early second payment, lapse, the clock-ahead case, and the series' crosses counted by kind and period (4 of 8 inserted crosses counted; removing the series clause fails the test).
