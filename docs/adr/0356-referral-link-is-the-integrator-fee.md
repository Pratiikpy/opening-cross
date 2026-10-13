# ADR-0356: A referral link routes the integrator fee, which the program already pays

Status: accepted (2026-10-13)

## Context

R5 asks for an issuer growth engine with referrals and an affiliate programme. `cross_core` already lets a cross name an integrator wallet and an integrator fee of up to 300 basis points, paid from the sale at finalize, and caps the protocol fee at a quarter of it (OCIP-1 section 7.6). The 10% referrer share in `packages/fees` exists in that accounting only; no program pays it.

## Decision

- An affiliate's link is `/issue?ref=<wallet>&fee=<bps>`. The wizard pre-fills the integrator wallet and fee from it, says in the fee panel that it did, and lets the issuer change or clear both before signing. The fee is on chain and fixed at creation, so the program pays the affiliate with no new code. A link with an invalid wallet or a fee above 300 is ignored, never half applied.
- No link for issuer-to-issuer referral is offered. A share of the protocol fee for bringing another issuer would need a program that pays it; the page says so (`docs/HUMAN_TASKS.md` records it with the other fee decisions).
- Contacts (the CRM) are wallets that bid in the issuer's crosses or soft-committed to its drafts, from public data, with private notes kept in the issuer's own browser. No names, emails or locations are held or inferred.
- Playbooks are short sequences built from what the product does. They promise no result and carry no figure.

## Consequences

- Whether an affiliate fee is a good idea for an issuer is theirs to judge; the page shows the total they will pay.
- Referral payouts to an issuer who referred another remain unbuilt and need a program change.
