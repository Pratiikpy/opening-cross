# W1 design tokens and W2 landing (2026-10-05)

`apps/web` (Next.js 16.3.8, React 19.3.0, Tailwind 4.3.3).

## W1: tokens
`src/app/globals.css` holds light and dark tokens taken from the Claude Design exports (Hanken
Grotesk, IBM Plex Mono, ink #0B0B0F, accent #E8430C). Two export colours fail WCAG AA in their
use, so each has an AA variant of the same hue:

- The orange as text on white is 4.01:1. Text uses `--accent-text` #C2380A (5.43:1), and
  button fills use `--accent-fill` #D63E0B with white text (4.61:1).
- Grey #8A8A93 as text is 3.42:1, so it is kept for control borders (≥3:1) and body text uses
  #5A5A62.

The theme follows the system and can be switched; the choice is applied before first paint.
`test/contrast.test.ts` checks 42 pairings: text ≥4.5:1 and UI ≥3:1, in both themes, all
passing.

## W2: landing
Every figure is live from the API's new `/v1/stats` endpoint (indexer totals, with the network
named) or visibly tagged "Illustration" or "Example". Export content that would be fabricated
proof was replaced:

- The $48.2M raised, the 184/61,204/1m40s figures and the issuer logos were dropped. The totals
  shown are live counts, currently devnet.
- "Two independent audits" now reads "No external audit yet", which is the truth (L2, H6).
- "A lottery decides" was rewritten as pro-rata allocation (decision 1).
- The "A cross is open now" pill shows only inside a cross's actual order window. Found while
  reviewing: devnet has a cross still marked Live long after its window closed.

`e2e/visual.mjs` runs every route in light and dark at 1440 and 390 px. It saves full-page
screenshots and fails on console errors, page errors, failed requests, horizontal overflow or
any axe-core WCAG 2.1 AA violation. All four passes are clean; screenshots are in
`docs/evidence/screens/home-{desktop,mobile}-{light,dark}.png`.

Fixed during that pass:

- The favicon returned 404.
- The dark-theme proof band flipped to light, and the orange eyebrow failed contrast.
- The code block was not keyboard-scrollable.
- The chart labels collided with the lines.

Lighthouse 12 (`next start` against the live API):

```
mobile:  performance=97 accessibility=100 best-practices=100 seo=100
desktop: performance=100 accessibility=100 best-practices=100 seo=100
```

API stream fix found in the same session: event delivery over WebSocket could reorder events,
because each notification's row read was asynchronous. Delivery is now serialized, and the
contract test passed 3/3 consecutive runs.
