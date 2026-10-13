# Reference adapters

Examples of an integrator deciding when and how to open a cross for its own market, and of an aggregator and a market maker plugging in. Each one **plans from live facts, explains the plan in plain sentences, and simulates before it sends**.

```
pnpm --filter @opening-cross/example-adapters exec tsx src/cli.ts <adapter> [options]
```

| Adapter | Plans |
|---|---|
| `reopen` | A reopen that closes before the market trades again, leaving time to clear and reveal, on a grid centred on the reference price |
| `halt-resume` | After a halt lifts, a short sealed call on a wider grid: trading resumes through a cross, not through the first trade that prints |
| `tender` | A sealed, gated offer to named holders with a floor, a minimum fill and a minimum window; prints the allowlist root the gate needs |
| `block-sale` | A sealed sale with the reserve as the lowest price; for a multisig, the unsigned create transaction and the sell order to place after it |
| `aggregator` | The ranked quote, then the winning venue's unsigned transaction |
| `rfq-maker` | A signed quote pointing at a resting order |

**Shadow mode is the default**: the cluster simulates the transactions and nothing is sent. `--send` is explicit and needs `--keypair`. A tender refuses to plan until you pass `--ack-not-legal-advice` (whether an offering may be made to a given buyer is a question for counsel). Shadow mode reports the transactions it cannot check before the cross exists as inconclusive, not failed.

These are examples, not a library to depend on: copy what you need. Tests cover the planners (`pnpm --filter @opening-cross/example-adapters test`, 15 tests). Evidence and the devnet shadow runs: `docs/evidence/W2A-W15-adapters.md`; design: `docs/adr/0321-reference-adapters-shadow-mode-first.md`.
