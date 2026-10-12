# @opening-cross/fees

The fee rules of `cross_core` as integer functions, and what is built on them: the revenue ledger entry, the external-flow scorecard, referral documents and payout lines, rate cards and invoices, signed statements, and the fee model. No I/O. Design: [](../../docs/adr/0160-revenue-ledger-and-billing.md); the model's output is [`docs/economics/FEE_MODEL.md`](../../docs/economics/FEE_MODEL.md).

```ts
import { PROPOSED_SCHEDULE, protocolFeeBps, expectedFinalizeFees, ledgerEntry } from '@opening-cross/fees';

protocolFeeBps(PROPOSED_SCHEDULE, 'launch', 120);          // 30: min(schedule, floor(120 / 4))
expectedFinalizeFees({ supplyMode: 'mint', protocolBps: 5, integratorBps: 20, buyerPaid: 2_400_000_000n, feesAccrued: 0n });
// { total: 6000000n, protocol: 1200000n, integrator: 4800000n }
```

`ledgerEntry(facts, recorded, tx)` compares three sources (the cross's counters through the fee rules, the `CrossFinalized` event, the finalize transaction's token balances) and returns `MATCH`, `MISMATCH` with the reason, or `UNVERIFIED` when the transaction is unavailable.

`pnpm --filter @opening-cross/fees model` regenerates the tables of `docs/economics/FEE_MODEL.md`; a test fails if the document differs from what the model renders.
