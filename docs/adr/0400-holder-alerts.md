# ADR-0400: Alerts: browser push, email and Telegram from one delivery loop

Status: accepted (2026-10-13)

Rows M7, Z6, T2, I3

## Context

Holders need to be told when an order can be claimed and before a cross or market they follow opens or closes. The in-browser reminders (`calendar/reminders.tsx`) only work while a page is open.

Options considered:

| Option | Why not |
|---|---|
| A vendor push service (OneSignal, Firebase) | Needs a vendor account and puts a third party between us and the holder; browsers already give us push for free |
| Poll from the page only | Nothing reaches a person who has closed the tab, which is the whole point |
| One loop, three channels: web push (VAPID), email (SMTP, double opt-in), Telegram (bot) | Chosen |

## Decision

`services/api/src/routes/holder-alerts*.ts`. A subscription is a channel, a destination (a push endpoint, an address or a chat), an optional public wallet address, topics (`claimable`, `closing`, `opening`) and a list of followed crosses and market calendars. Events are derived from the indexer tables on every pass, never stored on their own; each delivery is recorded under a stable key before it is sent, so an event is sent at most once. A failed send is retried after a back-off; a destination the push service or mail server says is gone is deleted. The loop starts only when a channel is configured, and a channel without keys is reported as not enabled, never faked.

- Push endpoints are accepted only from the browsers' push services (an allowlist of hosts): the endpoint comes from the visitor, and an open one would make the server fetch any URL.
- Email is double opt-in. The subscribe answer is the same whether or not the address is known. Nothing is sent before the confirm button is pressed (the link alone confirms nothing, so a mail scanner cannot), unconfirmed requests are deleted after a day, and every mail carries a one-click way out. The token in a mail is an HMAC of the subscription id, so a mail can repeat it without the server storing it.
- Telegram links through a one-time code sent to the bot; the loop reads the bot's updates, so no public webhook is needed.
- Privacy: a subscription stores the public wallet address it watches and nothing else about a person, and deleting it deletes its delivery record. The page says so.

## Verification

Unit and route tests on a real Postgres (PGlite) with the indexer's tables; in a real browser, real Chrome registered with Google's push service, a notification was delivered to the service worker and shown, and the email path ran against a real SMTP sandbox (docs/evidence/W2C-Z6.md). Not run against a real Telegram bot or a production SMTP account (HUMAN_TASKS).
