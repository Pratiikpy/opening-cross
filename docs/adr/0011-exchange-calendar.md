# ADR-0011: Exchange calendar with timelocked administration

Date: 2026-10-05 · Status: accepted · Implements PRD [W5]

## Decision
`cross_calendar` holds, per calendar, up to 64 upcoming sessions as UTC instants and up to 8 approved Pyth feed ids. Every change — sessions, feeds and the admin itself — is proposed, waits out the calendar's timelock (minimum seven days, enforced on creation), can be cancelled by the admin during the wait, and is then applied by anyone. In production the admin is a Squads multisig (L3).

`cross_core` lets a cross bind to a calendar: creation then requires the cross to close exactly at one of the calendar's session starts (the reopen moment) and, if the cross has an oracle guard, its feed to be on the calendar's approved list. The binding is recorded on the cross for indexers and the verifier.

## Evidence
`tests/core/test/calendar.test.ts`: timelock under seven days rejected; overlapping sessions rejected; update not applicable one second before the timelock and applicable by a stranger after it; cancellation; time-locked admin handover; calendar crosses off-session or with an unapproved feed refused.

## Consequences
Weekly reopen crosses are scheduled from a public, week-ahead schedule that no single key can change at short notice. Halt-resume crosses (W11) are not calendar-bound; they are triggered by events.
