# ADR-0903: Jurisdiction presets and resale locks

Date: 2026-10-16 · Status: accepted · Rows G2, V6

## Decision

`packages/cross-gate-client/src/presets.ts` ships rule templates for Regulation D 506(c), Regulation S, Regulation CF, MiCA, VARA and an open screened gate. A preset is data: country policy, tier, flags, per-person default cap, resale-lock length and notes with primary sources. Every preset requires counsel (`requiresCounsel: true`) and **ships no embargo list**; the issuer supplies `restrictedCountries`, and the gate page and issuer form say so.

| Preset | Rules | Resale lock |
|---|---|---|
| Reg D 506(c) | accredited tier, accredited + KYC + sanctions flags, one identity one pass | 365 days (Rule 144(d), non-reporting issuer) |
| Reg S | deny US, KYC + sanctions | 365 days (conservative; the real period depends on issuer category) |
| Reg CF | allow US only, default cap 2,500 quote tokens | 365 days (17 CFR 227.501) |
| MiCA | allow the 30 EEA states | none |
| VARA | allow AE | none |

Locks are applied after a gated cross pays out, by `receive_locked` when `cross_core` calls it, or by a keeper named `lock_delegate` that calls `set_lock` (`resaleLock()` in the client computes amount and end so a keeper never weakens a running lock). `cross_core` does not call `receive_locked` yet; that is a change outside this package (see the evidence file).

## Not verified

The legal content. The cited rules (17 CFR 230.144(d), 230.901 to 230.905, 227.100 and 227.501, Regulation (EU) 2023/1114) were not re-read against primary text this session (the scraper was unauthorised). The templates are starting points for counsel, not advice. Reg CF limits are per investor across all offerings and need an aggregator the code does not provide; Reg S turns on facts (US person, location at order) that an attestation can only assert.
