# ADR-0403: Paying with what a holder has: quote token, sponsored fees, onramp link, mainnet swap

Status: accepted (2026-10-13)

Rows I4, I5, I6, S14

## Context

A cross is paid in one quote token. Holders hold other tokens, no SOL, or only a card.

## Decision

- The readiness checklist on a cross reads the wallet's SOL and quote-token balance and says exactly what is missing.
- No SOL: sponsored orders (ADR-0405).
- Another token: swapping into the quote token needs a market for the pair. Jupiter routes exist on mainnet only, so on devnet the checklist says so. On mainnet the checklist hands off to Jupiter's own swap page with the quote token prefilled; the person signs the swap there. An in-app swap before the order was not built: it cannot be verified without mainnet funds.
- Card, Apple Pay and Google Pay: an onramp link built from a provider's documented widget parameters, shown only when a provider key is configured (`NEXT_PUBLIC_ONRAMP_KEY`). No provider account exists, so the control is absent today and the page does not pretend otherwise.

## Not done

A payment provider account and a mainnet launch are founder steps (HUMAN_TASKS). Nothing here moves fiat.
