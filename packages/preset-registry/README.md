# @opening-cross/preset-registry

An open registry of cross presets. A preset is a document signed by its author, versioned, setting only the create-cross fields (kind, disclosure, supply mode, price levels, step, windows, order cap) and never a price, supply or raise.

A cross is attributed to a preset by a memo in its creation transaction:

```ts
import { presetMemo } from '@opening-cross/preset-registry';
presetMemo(author, 'sealed-24h', 3); // "oc-preset:1:<author>/sealed-24h@3"  -> add as a memo instruction next to create_cross
```

The API (`GET /v1/presets`, `/:author/:id`, `/:author/:id/:version/use`, `/:author/:id/performance`, `POST /v1/presets`) reads each creation transaction once and reports the outcomes of the crosses that carried the memo: print rate with an interval, medians, and how many had only the issuer's own bidders. No headline below the minimum sample; no ranking; no causal claim. A royalty an author declares is a claim, and **nothing pays it**.

Evidence: `docs/evidence/W2A-L2-presets.md` (including a real devnet run: the cross with the memo was attributed, the one without was not); decision: `docs/adr/0308-preset-registry-memo-attribution.md`.
