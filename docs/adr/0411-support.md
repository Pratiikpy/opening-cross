# ADR-0411: Support that reaches a person, and says what it promises

Status: accepted (2026-10-13)

Rows N1, N2

## Context

"Reachable human support with an SLA" cannot be built by code alone: an SLA is a staffing promise.

## Decision

`/v1/support` stores a request, mails an operator inbox when one is configured, and returns a reference and a token to read the reply. The page states the response time only when `SUPPORT_RESPONSE_HOURS` is set and otherwise says no time is committed; it says when no inbox is connected. The identity status (N1) sits beside the form: which gates the wallet holds a pass for, and that the devnet attester verifies nobody. The human steps are naming the inbox and the response time.
