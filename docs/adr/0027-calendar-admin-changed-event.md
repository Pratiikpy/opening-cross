# ADR-0027: the calendar's admin event is named `CalendarAdminChanged`

Status: accepted (2026-10-13)

## Context

Anchor derives an event discriminator from the event name alone: `sha256("event:<Name>")[..8]`.
`cross_core` and `cross_calendar` both emitted an event called `AdminChanged`, with different fields
and the same discriminator `e8221fe23e121372`. A consumer that decodes a `Program data:` line without
first attributing it to the right program would read one as the other. OCIP-1 had to tell indexers to
attribute events by invoke stack for this reason (section 12.3), and no other pair of events in the
five programs collides.

## Decision

The event in `cross_calendar` (emitted by `apply_admin`) is renamed `CalendarAdminChanged`, with the
same fields (`calendar: Pubkey`, `admin: Pubkey`). Its discriminator becomes `7b06056a7d8ef04b`.
`cross_core` keeps `AdminChanged`.

- Account sizes, account layouts, instruction discriminators and argument encodings do not change.
  Only the event's name, and so its discriminator, changes; the `Calendar` account is untouched.
- The IDL (`packages/cross-calendar-client/idl/cross_calendar.json`) and the generated client
  (`packages/cross-calendar-client`) are regenerated. No indexer, API, SDK, keeper or app decodes the
  calendar's event, so nothing else consumes the old name.
- `docs/spec/OCIP-1.md` lists the new event and drops the collision note; invoke-stack attribution
  stays required because it also rejects look-alike payloads from foreign programs.
- `tests/core/test/calendar.test.ts` asserts that `apply_admin` emits the new discriminator and that
  the event discriminators of `cross_core` and `cross_calendar` are disjoint.

## Consequences

- Calendar admin events emitted before the upgrade carry the old discriminator and cannot be told
  apart from `cross_core`'s by discriminator alone; a reader of history must still attribute by
  program for those.
- Requires a program upgrade of `cross_calendar`.
