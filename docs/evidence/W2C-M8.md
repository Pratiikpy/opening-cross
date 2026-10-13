# W2C-M8: holder-weighted comments

Outcome: **BUILT**. Design: ADR-0406. Code: `services/api/src/routes/holder-social.ts`, `components/cross/comments-tab.tsx`, `lib/holder-comments.ts`.

Tests (`services/api/test/holder-social.test.ts`, comment part, 8 tests, real Ed25519 signatures and a real Postgres): the body rules (links, control and direction characters, length); the weight; a holder is weighted by the share of the matched amount (2,500 bps for a quarter); a bidder with no tokens may comment with weight 0 and is listed after the holder; a stranger with no order and no tokens is refused; a forged signature, a signature for another cross, a signature by another key, a stale or future time, a malformed signature, a link and a junk address are refused; one comment a minute and twenty a day; hiding needs the moderator token and removes the comment from the list.

Browser run (`holder-pages-flow.mjs`) with a wallet that has real orders in the cross: it signed the exact text shown (`Opening Bell comment`, cross, time, body), the comment was posted and listed with its role; a link was refused before the wallet was asked; declining in the wallet said nothing was posted. Zero console errors.

Not covered: replies and reactions (not built); a comment from a wallet that holds the token but never bid; moderation by a person (HH7).
