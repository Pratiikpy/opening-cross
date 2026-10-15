# ADR-0940: Alerts on insider, team and treasury movements

Status: accepted (2026-10-16). Builds on ADR-0400 (alerts) and ADR-0930 (the treasury movement read model).

## Context

Row F5 asked for alerts when someone tied to a token moves it, or when a treasury pays out. Alert delivery already existed (push, email, Telegram, an in-app feed, each event keyed once). It had no trigger about other people's movements, and the answer to "who is an insider" is not in one place: the mint authority is on the mint, creators are in the index, a cross can declare up to eight insiders in its rules, a treasury names its authority and up to four insiders, and an issuer may publish a signed team list.

## Decision

Three topics join `claimable`, `closing` and `opening`.

- `insider`: a wallet the chain or the issuer ties to a followed token holds less of it than before.
- `team`: the same, only for wallets in the issuer's signed team declaration (verified with `@opening-cross/integrity`). Every team wallet is also an insider, so a subscriber to `insider` hears about it once; a subscriber to `team` alone hears about no other wallet.
- `treasury`: value left a followed ownership-coin treasury, read from `treasury_movements` (ADR-0930): a spend, an executed proposal, a revenue tranche, a grant release or a sweep. A holder redeeming is not an alert. The counterparty is named when it is the treasury authority or a wallet already known as an insider of the coin; `teamOutflow` is stated as the program defines it, never inferred.

**Who is an insider** (`holder-alerts-watch.ts`, `insidersOf`), each with the fact that says so, up to 25 wallets, team first: the mint authority; the creator of a cross that sells the token; a wallet declared an insider in a cross's rules tail; the authority of a treasury of the token; a wallet named when a treasury was extended; a wallet in a verified signed team declaration. A wallet nobody declared is not found. That limit is stated on the page and in the API answer.

**What is observed.** Not transactions: balances. The scan reads each insider's balance of the token over RPC (all of its token accounts) and compares it with the last accepted baseline. A fall of at least 0.1% of supply (configurable, parts per million) is recorded once under a hash of wallet, balances and time. A smaller fall keeps the old baseline, so many small sales add up until they cross; a rise raises the baseline; a baseline older than a day is replaced, not compared, so a gap never alerts. The newest transaction on the wallet at the time is attached and labelled as that, not as the cause. The wording never says "sold" or implies intent: "this is a balance check, not proof of a sale".

**What follows what.** A followed cross covers its base token and that token's treasury; a followed treasury covers its coin's insiders; any other address is treated as a possible token mint and checked on chain. `GET /v1/alerts/subject?address=` tells a person, before anything is turned on, what an address is and which wallets following it would cover. A feed reader's tokens are scanned for an hour so the feed has something to show without a subscription.

**Honest availability.** `GET /v1/alerts/config` reports `available` per topic: insider and team need an RPC, treasury needs the migration that records treasury movements. A subscription to an unavailable topic is refused with the reason (422); nothing is accepted and then silent. A push is never sent for something that happened before the subscription began, nor older than six hours; the feed looks back a day.

**Web.** The Alerts page gains an "Insiders and treasuries" section: the three topics (disabled with the reason when unavailable), lookup of an address with the insider list, follow and unfollow, and movement items in the feed with their age. The web library `lib/holder-alerts.ts` types a topic as the first three; the new topics and follows live in `components/alerts/movement-alerts.ts` and are merged into the one topic and follow list the server takes. When the library learns the new topics that file shrinks to labels and the subject call.

## Alternatives considered

- Trace transactions (every transfer out of an insider wallet). More precise about destination and time, but it needs full history parsing, and a wallet that sells and re-buys inside one interval would still look flat. Balance checks are cheap, bounded per token, and honest about being balance checks. A trace is the next layer, not a replacement.
- Infer insiders from funding clusters or early buying. Rejected for alerts: a false accusation by notification is worse than a missed one. The funding analysis (F3, F8) stays evidence on its own pages.
- One topic for all three. Rejected: a holder who wants treasury payouts does not want every insider balance move.

## Consequences

- Insider alerts are as good as the declarations behind them. A token whose issuer declares nobody and creates no cross has no insider to watch, and the lookup says so.
- A transfer between two insider wallets of the same token shows as a fall in one; a transfer that is reversed between two scans shows as nothing.
- The scan costs about 2 + (crosses read, at most 5) + (treasuries) + (insiders) RPC calls per token per minute, only for tokens someone follows or looked at.
- The tables `alert_insider_balances` and `alert_movements` are created on first use (like the other alert tables) and pruned after seven days. They are derived and not backed up.

## Not covered

Telegram and email delivery of a movement alert were not run against a real provider here (the delivery path is the one ADR-0400 already proved; the item is a normal `AlertItem`). Mainnet tokens, Safari and Firefox, and a real signed team declaration from an issuer were not exercised.
