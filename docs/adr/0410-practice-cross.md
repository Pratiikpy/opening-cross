# ADR-0410: A practice cross with play money

Status: accepted (2026-10-13)

Row S11

## Context

Learning by doing needs a cross that cannot lose money.

## Decision

`/practice`: a 60-second call, simulated seller and nine simulated bidders drawn from a seeded generator, play money, the same clearing rule as a real cross (checked against the verifier's reference over eight seeds), the same book chart, a banner that nothing touches a wallet or the chain, and a debrief with three questions answered from the run itself. Everything simulated is labelled.
