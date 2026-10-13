# W2C-Z6 (with M7, T2, M5): post-trade notifications and the claim center, run for real

Outcome: **BUILT** for in-app, browser push and email, and a real signed Claim all on devnet. Telegram is built and unit-tested; it was not run against a real bot (HUMAN_TASKS HH1). Provider credentials for the deployed host are HH1.

Design: ADR-0400. Code: `services/api/src/routes/holder-alerts*.ts` (rules, store, channels, loop), `apps/web/public/sw.js`, `apps/web/src/components/alerts/*`, `apps/web/src/lib/holder-alerts.ts`.

## Tests

- `services/api/test/holder-alerts.test.ts`, 27 tests on a real Postgres (PGlite) carrying the indexer's own migrations: the event rules (closing, opening, claimable, market sessions, the lead window, one claimable item per cross), validation (push endpoints accepted only from the browser push services: 14 hostile endpoints refused, including `169.254.169.254`, `localhost`, look-alike hosts, user-info and ports), channel classification (gone versus retry), mail content (escaped, with unsubscribe), the routes, the delivery loop (exactly once, retry with back-off, a gone destination is deleted), double opt-in, Telegram linking by one-time code, the per-wallet cap, the in-app feed.
- Web and API suites at the end of the work: see the report.

## Browser runs (`apps/web/e2e/holder-alerts-flow.mjs`, output in this file's run log below)

Real Chrome 155 with a real profile (Chrome has no Push API in incognito, so a Playwright context cannot run this), against the holder API harness (`services/api/test/holder-harness.ts`: the holder routes on PGlite seeded from the live index, in front of the live API; a real Postgres, real devnet, a real SMTP sandbox):

```
PASS in-app feed: a cross closing on the wallet's order is listed with no subscription
PASS push: subscription created through the browser's push service (Notifications are on for this browser.)
PASS push: the server holds one confirmed subscription for the wallet (fcm.googleapis.com endpoint, wallet = the connected wallet)
PASS push: the notification was delivered to the browser and shown ("Cross Harn…1111 closes in 5 min", url /crosses/<cross>)
PASS push: one delivery recorded as sent
PASS push: later passes do not send it again
PASS email: the form answers that a link is on its way, not whether the address was known
PASS email: the SMTP sandbox accepted a confirmation mail (Confirm your Opening Bell alerts)
PASS email: nothing is active before the link is opened
PASS email: no alert mail is sent to an unconfirmed address, though a cross is closing
PASS email: opening the link alone confirms nothing (a mail scanner cannot confirm)
PASS email: the Confirm button confirms
PASS email: the closing reminder arrived once confirmed
PASS email: the unsubscribe link in the alert mail deletes the subscription
PASS email: using the link a second time says so
PASS push: Turn off deletes the subscription from the server
PASS alerts page after the flow: axe clean
PASS holder alerts: zero console errors, page errors, failed requests and HTTP errors
```

The push notification was read back from the service worker's `getNotifications()`, so it was received, not just accepted by the push service. The email went over SMTP to Ethereal (nodemailer's test service).

## Claim all on devnet (`apps/web/e2e/holder-claim-live.mjs`)

The run earlier recorded in FEATURE_STATUS ran into rate limits and covered one order. This one: wallet `Ao9ZJv…paFc` (the `live-buyer` test key) opened an escrow cross on devnet (`731MhbEAVQfmcnm4C7ynywJr5nbkW3zDKeYZrfzj5Ahw`), placed a buy and a sell of 3 tokens at 1.20 from the cross page, settled it from the cross page, and the claim center on `/orders` listed both orders.

```
PASS the cross settled and printed (Cleared, price 1200000, matched 3000000)
PASS the claim center lists 2 orders to claim
PASS Claim all asked the wallet to sign 2 claim transactions, one per order
  base before 600000000 after 600000000; quote before 9746386510 after 9746386510
PASS on chain: the wallet holds the same number of tokens (it bought 3 from itself and sold 3 to itself)
PASS on chain: the quote token is down only by the seller fee (0 atoms)
PASS orders page after claiming: axe clean
PASS claimant: zero console errors, page errors, failed requests and HTTP errors
```

(The cross charged no protocol fee: 0 bps. 429 answers from the shared public RPC were ignored by this run and counted separately, as in H26.) Screenshots read: `screens/w2c/claim-center-before-1440-light.png`, `claim-center-after-1440-light.png`.

Earlier attempts of the same script failed for faults of the script (an issuer console that changed under it, a click before hydration, a label match) and are not claims about the product; one earlier cross (`D6uC537hY4WERL1tL3gMWNxkq5j5BG4kyfPi93V5sLG5`) was left with one open order awaiting settlement.

## Not covered

Telegram against a real bot; email against a production SMTP account; push on Safari, Firefox and a phone; a notification clicked in the operating system (the click handler is a few lines and was not exercised); a Claim all of more than two orders; a claim of a sealed order never revealed in this run (covered by the existing unit tests and the earlier C2 run).
