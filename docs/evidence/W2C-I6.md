# W2C-I6 (with S14, I4, I5): paying with what a holder has

Outcomes: **I6 and S14 BUILT** (sponsored fees, two-tap order from the ticket); **I4 and I5 HUMAN** (card and onramp need a provider account and a mainnet deployment; the quote-token swap is a hand-off to Jupiter's own page on mainnet). Designs: ADR-0403, ADR-0405.

## Sponsored orders: a wallet with tokens and no SOL placed an order on devnet

Code: `services/api/src/routes/holder-sponsor.ts` (`POST /v1/tx/place-order-sponsored`, `GET /v1/sponsor`), `components/cross/holder-readiness.tsx`, `order-ticket.tsx`.

The server builds the whole transaction (a system transfer that tops the owner up to the order account's deposit, and the same `commit_order` the app builds, sponsor as fee payer), signs only that message, and returns it for the owner to sign. An order the program would refuse is refused first, because the sponsor pays the fee of a failed transaction.

Run `apps/web/e2e/holder-sponsor-live.mjs`, devnet, wallet `7Fp2…TRGV` (0 SOL, 50 quote tokens, no other source of funds), sponsor `5nUv…KfMB`:

```
PASS before: 0 lamports and 50000000 quote atoms in the wallet
PASS readiness: no SOL is reported, with the sponsor offered as the way through
PASS ticket: the sponsor choice is shown and on
PASS a wallet with no SOL placed an order; the wallet signed a transaction the sponsor had already signed as fee payer
  wallet SOL 0 -> 0; sponsor 150000000 -> 148613320; wallet quote 50000000 -> 47600000
PASS on chain: 2.4 quote moved into escrow from the wallet
PASS on chain: the sponsor paid (1386680 lamports: the order deposit and the fee)
PASS on chain: the wallet kept nothing it did not need (0 lamports after the deposit)
PASS the sponsor reports what it spent today
PASS blink: the action endpoint built a bid transaction
PASS wallet without SOL: zero console errors, page errors, failed requests and HTTP errors
```

The deposit (about 0.0016 SOL) returns to the wallet when the order is claimed or cancelled. One check in that run, the matcher for the readiness line "You hold N of the quote token", raced the balance read; the line is in the screenshot (`screens/w2c/final-window-coarse-1440-light.png`: "You hold 47.6 of the quote token") and the matcher was changed to wait for it. That run was not repeated: it costs a cross's rent.

Tests: `services/api/test/holder-actions.test.ts` (sponsored part, 10 tests): the signed transaction is decoded and its instructions read (sponsor fee payer, the exact advance, `commit_order`, the owner's slot empty); the advance is only the shortfall; refusals (off-grid price, zero quantity, bad side, bad nonce, the sponsor itself, no tokens, more than the wallet holds, unknown cross, closed or not-yet-open cross); per-wallet and daily limits; a nearly empty sponsor. The ledger table is created on first use.

Honest limit: the right fix is a separate rent payer in `commit_order`, a program change; the advance works with the deployed program.

## I4, I5: what exists

The readiness checklist reads the wallet's SOL and quote-token balance through the API and says what is missing. Where the quote token is missing, a mainnet deployment shows a Jupiter swap page link with the quote token prefilled and, only when four provider settings are present, a link to the provider's own widget with the wallet and token filled in and locked (`lib/holder-pay.ts`, 5 tests including a hostile address). On devnet the checklist says no market exists to swap into a test token. The provider widget parameters used are the ones in the provider's published query-parameter reference; no provider account exists, so no widget was opened (HH5).
