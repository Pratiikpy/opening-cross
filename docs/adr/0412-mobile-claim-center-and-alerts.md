# ADR-0412: Mobile: claim all in one wallet session, and an alert feed

Status: accepted (2026-10-13)

Rows X7, M9, Z6

## Context

The native app listed orders but could not claim them from the orders screen.

## Decision

The orders screen carries a claim center found the same way as the web's (index says open, cross settled, chain still holds the order and gives the nonce) and claims all of them in one Mobile Wallet Adapter session. An alerts screen reads `GET /v1/alerts/feed`. Phone push needs a Firebase credential and a development build and is not in this build; the screen says so. Nothing was run on a device or emulator (HUMAN_TASKS H19).
