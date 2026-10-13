# ADR-0319: Blinks follow the Solana Actions specification as published

Status: accepted (2026-10-13) · Rows X6, S10 · Code `services/api/src/routes/blinks.ts` · Evidence `W2A-X6-blinks.md`

## Decision

1. **A cross is one URL a wallet or a link unfurler can read** (`GET /v1/blinks/cross/:address`) and one POST that returns an unsigned transaction (`.../order`), plus `/actions.json` rules for the site that maps a page's path to it. The response shapes, the `OPTIONS` headers and the error form `{ message }` follow the Solana Actions page read on 2026-10-13.
2. **No field the specification does not define is added.** Linked actions and POST responses carry no `type`; an error is `{ message }`.
3. **The description says what the buyer will pay and what comes back**: they pay the clearing price at most their limit; the rest returns; if too little crosses everyone is refunded; anyone can recompute. The transaction message states the amount that leaves the wallet now.
4. **What a Blink cannot do is shown as disabled with the reason.** A gated cross (claim a pass in the app first), a sealed cross (a sealed bid needs a secret only the signer may keep: bid in the app), and a closed or not yet open cross each return a disabled action and a message; a POST to a closed or gated cross is refused with a 409 and nothing is built.
5. **The Blink is a front door only.** The order is the same order a wallet sends from the app.

## Alternatives rejected

- A custom link format: no wallet would understand it.
- Hiding the rules in the page: the text a user reads is the text they sign under.

## Consequences

Whether a given Blink client unfurls the link is a property of that client and of the domain's registration with it; one was not tested (HUMAN_TASKS). The web app needs a `public/actions.json`.
