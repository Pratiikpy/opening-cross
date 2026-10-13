# R5 issuer growth engine (2026-10-13)

Outcome: BUILT for the playbooks, the contacts, and the referral link. NEEDS-PROGRAM for issuer-to-issuer referral rewards.

## What exists

`/issuer/growth` (`components/issuer/growth.tsx`, `lib/issuer-growth.ts`, ADR-0356): four playbooks (before, during, after, if it does not print) built from what the product does and promising no result; contacts from public activity (wallets that bid in the issuer's crosses or soft-committed to its drafts, with crosses, fills and commits), private notes kept in the issuer's own browser and a CSV with notes; a referral link `/issue?ref=<wallet>&fee=<bps>`.

The referral link works because the program already pays an integrator fee: the wizard pre-fills the integrator wallet and fee, says it did, and lets the issuer change or clear both.

## Checks

`apps/web/test/issuer-growth.test.ts` (8): contacts (sellers ignored, fills and commits counted, an unknown decimal never guessed), CSV quoting, the link round-trips to the same wallet and fee, a bad wallet or a fee over 300 is refused and ignored by the reader, playbook links point at real pages and promise no result. Browser: the link names the connected wallet and fee 20; the holder who soft-committed is a contact, shown by wallet; opening `/issue?ref=<wallet>&fee=40` pre-fills 40 and shows the note. Screen: `console-09-growth.png`.

## Needs a program

The 10% referrer share of the protocol fee exists in `packages/fees` accounting only; no program pays it. The page says so and offers no such link. An affiliate programme beyond the integrator fee needs that program and a fee decision (HD1).

## Not covered

An affiliate's earnings view (the fee is paid at finalize and is visible on chain; the page does not total it); email or any contact channel (the chain holds none).
