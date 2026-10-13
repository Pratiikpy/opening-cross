# W2C-T2 (with M7): calendar reminders from the server, and alerts

Outcomes: **T2 BUILT** (server-side reminders by browser push and email, verified end to end; the provider credentials for the deployed host are HH1), **M7 BUILT** for in-app, push and email, with Telegram HUMAN (HH1).

What changed on the calendar: every upcoming cross row and every market session now has Follow beside Add to calendar and Notify me (`components/calendar/*`, `components/alerts/follow-button.tsx`). Following a cross or a market adds it to the browser's follow list and to every push or Telegram subscription the browser manages; the server sends a reminder 10 minutes before a followed cross opens or closes or a followed market session starts (`services/api/src/routes/holder-alerts-core.ts`, `itemsFor`). The page text that used to say "We send no email and no push notification" now says what Notify me (this browser only) and Follow (a channel from the Alerts page) each do. `/alerts` has the in-app feed, the follow list, the three channels, and the topics.

Evidence is the same run as Z6 (W2C-Z6.md): a real push through Google's push service to real Chrome, shown by the service worker, once; an email double opt-in against a real SMTP sandbox with confirm and unsubscribe from the mails' links. The market-session reminder is covered by the route test `follows a market calendar and a cross with no wallet at all` (a calendar row in the real indexer schema), not by a browser run, because no calendar session was within ten minutes during the run; `docs/evidence/W5-calendar-live.md` shows the live devnet calendars.

The earlier calendar check `apps/web/e2e/w5-calendar-live-check.mjs` asserted the old sentence and now asserts the new one.

Not covered: a push or an email for a market session in a real browser; Safari and Firefox; email clients' rendering of the HTML part; the provider-hosted deployment (HH1).
