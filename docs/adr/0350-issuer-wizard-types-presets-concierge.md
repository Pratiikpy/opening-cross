# ADR-0350: The issuer wizard starts from a listing type, reads the token, and its concierge is a checklist

Status: accepted (2026-10-13)

## Context

PRODUCT_FEATURES A1, A9, T5 and T6 ask for listing types, one-click presets per asset type, auto-fill and a concierge that gets a first draft done quickly. The console had five format presets that lived in the web app, no way to say what is being listed, and no help beyond a readiness list. `/issue` showed nothing at all until a wallet was connected (I1), and the first-draft target in the design brief (10 minutes) was not measurable.

## Options

1. A chatbot concierge with a language model filling the form. Rejected: it cannot be tested against the chain, it invents numbers unless forbidden from doing so, and nothing in the repository holds a model key or a policy for one.
2. A checklist concierge: an ordered list of steps, each judged from the form and from chain reads, that says what to do next and why. Chosen.
3. Keep the presets in the web app. Rejected: the specification puts preset definitions in `packages/presets`, where they are tested on their own and the API and the mobile app can use them.

## Decision

- `packages/presets/src/launch.ts` (export `@opening-cross/presets/launch`) holds the five format presets, the eight listing types, the auto-fill rules and the quote-mint ranking, with 27 tests. The web app imports it as a workspace dependency (`transpilePackages` in `next.config.ts`).
- A preset never carries a price, a supply or a raise target. It also names optional modules (treasury, gate, oracle guard) as advice, never switching one on.
- A listing type is available or `needs-partner`. Tokenized stock issuance, pre-IPO exposure and real-world-asset yield need a licensed partner and counsel that this product does not have, so the wizard says exactly that and keeps Create off. A stock token a licensed tokenizer already issued can run a reopening auction today (an escrow cross), and the picker says so.
- Auto-fill reads the token from the chain (decimals, supply, authorities, extensions, Token-2022 metadata) and proposes the supply mode, format and listing type that follow from its authorities, each with the fact behind it. It applies only on request and never overwrites a choice already made. It does not extract anything from a website or a deck: that needs a model and an external fetch and is not built.
- The concierge (`lib/issuer-concierge.ts`) marks a step done only when the form or the chain shows it. It is not a chat and has no human behind it, and the page says so. The only time shown is how long the draft has been open, which is measured. The 10-minute target is not claimed: a scripted run takes seconds and is not a user study.
- The draft is saved in this browser only and restored on return; the page says so.
- Everything before signing works without a wallet. Creating a cross asks for no identity check, and the page says that a gate decides who may bid and does not verify the issuer.

## Consequences

- Listing types that need a partner are visible but inert. Unblocking them is a business step (H2, HG4), not code.
- A new preset or type is one edit in `packages/presets` and one test.
- The wizard carries a dependency on the workspace package; the Vercel staging script already copies `packages/`.
