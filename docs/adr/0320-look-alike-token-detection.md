# ADR-0320: Duplicate and look-alike tokens are warnings from declared metadata, not verdicts

Status: accepted (2026-10-13) · Row F7 · Code `packages/authenticity/src/duplicates.ts`, `services/api/src/routes/duplicates.ts`

## Decision

1. **A token's declared name and symbol are compared with every other token listed on this deployment and with the issuers' own lists.** A match is a warning that two tokens share, resemble or nearly share a ticker or name, with the reason; it does not say either token is false. Images are not compared.
2. **Look-alike characters are folded** before comparing, so a ticker written with a zero for an O or a Cyrillic letter reads as its look-alike.
3. **One edit apart counts only for symbols of at least five characters, and at most five near matches are listed**: for four-letter tickers the rule produced seven irrelevant matches in testing.
4. **Third-party text is data.** Names and symbols are returned as data and wrapped by any consumer that shows them to an agent.
5. **Labels are read once and kept** (`token_labels`), with a per-request budget of fresh reads; mints not yet read are reported as unchecked.

## Alternatives rejected

- A blacklist of known scam names: stale on arrival.
- Blocking a listing on a match: two honest tokens can share a ticker; the decision is a person's (ADR-0305 queue).

## Consequences

It cannot see a duplicate of a token that is not listed here. The comparison list grows with listings, so the read budget matters at scale.
