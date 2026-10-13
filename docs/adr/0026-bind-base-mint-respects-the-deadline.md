# ADR-0026: `bind_base_mint` is refused from `settle_deadline_ts` on

Status: accepted (2026-10-13)

## Context

A deferred-mint cross (ADR-0006) is settled by a registered settler that binds the base mint it
created. If it does not bind by `settle_deadline_ts`, anyone may call `abandon_settlement` and every
order is refunded. `abandon_settlement` is allowed from `now >= settle_deadline_ts`, but
`bind_base_mint` checked no time at all. After the deadline, whichever of the two transactions
landed first decided the outcome, so a settler could bind after bidders had already seen the
deadline pass, and a bidder or keeper could not rely on the deadline to get a refund.
`tests/core/test/deferred.test.ts` reproduced this on LiteSVM: a bind sent at the deadline succeeded.

ADR-0006 says refunds "remain available through the no-print path if settlement is abandoned past a
deadline" and that a stalled settlement "can be resumed by anyone" until then. Nothing in it permits a
bind after the deadline.

## Decision

`bind_base_mint` requires `now < settle_deadline_ts`; otherwise it fails with the new error
`SettlementDeadlinePassed` (code 6037). The deadline then splits time exactly: before it only a bind
can end the wait, from it on only `abandon_settlement` can. The check comes after the `NotSettler`
check, so the existing errors keep their precedence.

- No account layout, discriminator or argument changes. The error is appended to the enum.
- `create_cross` already requires the deadline to be later than `reveal_end_ts`, so a settler always
  has a window between the clear and the deadline.
- The `cross_settle` DBC adapter reaches `bind_base_mint` by CPI and inherits the check; its
  settlement must finish before the deadline.

## Consequences

- A settler that is late loses the launch to a full refund, which is what the deadline is for.
- Crosses created before the upgrade get the new behavior as soon as `cross_core` is upgraded.
