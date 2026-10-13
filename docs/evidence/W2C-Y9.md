# W2C-Y9 (with M6): holdings and portfolio

Outcome: **BUILT**. Design: ADR-0401. Code: `apps/web/src/app/portfolio`, `components/portfolio/portfolio-page.tsx`, `lib/holder-value.ts`, `lib/holder-portfolio-load.ts`, `lib/holder-chain.ts`; API `GET /v1/balances/:owner`; `/rights` (`components/portfolio/rights-view.tsx`).

What it shows, for the connected wallet: what needs it (claimable orders and crosses closing, from the alerts feed); one card per token it bought or sold through crosses, with what it holds now (read from chain through the API), the last price the token cleared at and the day, the value at that price, the average price paid, and the result against that cost only for tokens bought through crosses and still held, with a sign and an arrow, never colour alone; the token's next cross with a Follow button and a "Compare with selling now" button that asks the router (on devnet it answers that no DEX route exists, and the page says there is no market); for an ownership coin, its treasury state, the number of rights the program enforces and does not provide, the exact redemption a liquidating treasury would pay (snapshot vault times coins over snapshot supply, rounded down) and redemptions this wallet already received; identity status; the passkey wallet card.

No price other than a cross's own clearing price is used anywhere, and amounts in different quote tokens are never added.

## Tests

`apps/web/test/holder-value.test.ts`, 15 tests: the latest print per token, the mark from a cross's price scale and decimals, a holding's value and result (partial holdings, mixed quote tokens, a loss shown with its sign, no balance, no mark, tokens that arrived another way), the next cross, the exact redemption, the cohort index. `services/api/test/holder-balances.test.ts`, 5 tests.

## Browser run

`apps/web/e2e/holder-look.mjs` with the real wallet `Ao9ZJv…paFc`, which has ten real fills on devnet: ten token cards (600 tokens each, last cross price 1.2, worth 720 quote, average paid 1.2, result 0), at 1440 and 390, light and dark: axe (WCAG 2.2 AA tag set) clean on all four, zero console errors. Screenshots read: `screens/w2c/look-portfolio-1440-light.png` and the other three. The screenshot shows a long page of near-identical cards for this test wallet, which is the data (ten tokens bought the same way), not a layout fault.

Not covered: a wallet that holds an ownership coin of a treasury (no test wallet holds one: the two liquidating devnet treasuries are fully redeemed, vault 1 atom), so the entitlement and "received" lines are covered by unit tests and by reading the live treasury API, not by a browser run on a holder; the redeem transaction itself (the program's redeem needs a transaction builder in the API, which is not in this work: the view says what the payout would be, and the treasury page is where the existing flows live); a selling-now comparison on mainnet.
