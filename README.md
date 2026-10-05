# Opening Cross

One fair price for every new market on Solana.

Opening Cross is an open call-auction protocol: orders collect during a call period, then every filled order clears at a single uniform price. It is used for launches, reopens after weekends and halts, unlocks, tenders and recurring crosses. **Opening Bell** is the app built on it.

> Status: early development on devnet. Nothing here is deployed to mainnet, and nothing here is an offer of securities.

## Packages

| Path | What it is |
|---|---|
| `packages/token-safety` | Reads a mint's Token-2022 extensions and reports issuer powers (pause, permanent delegate, display multiplier, transfer hooks, fees) that affect escrowed or pooled balances. |

## Develop

```sh
pnpm install
pnpm -r typecheck
pnpm -r test                                  # unit tests
pnpm --filter @opening-cross/token-safety test:mainnet   # live mainnet reads
```

Engineering rules: [`ENGINEERING_PRINCIPLES.md`](ENGINEERING_PRINCIPLES.md). Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md). Decisions: [`docs/adr`](docs/adr).

## Licence

Apache-2.0.
