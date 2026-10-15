# @opening-cross/fees

The fee rules of `cross_core` as integer functions, and what is built on them: the revenue ledger entry, the external-flow scorecard, referral documents and payout lines, rate cards and invoices, signed statements, and the fee model. No I/O. Design: [ADR-0317](../../docs/adr/0317-fee-ledger-three-sources-and-accounting-only-shares.md); the model's output is [`docs/economics/FEE_MODEL.md`](../../docs/economics/FEE_MODEL.md).

```ts
import { PROPOSED_SCHEDULE, protocolFeeBps, expectedFinalizeFees, ledgerEntry } from '@opening-cross/fees';

protocolFeeBps(PROPOSED_SCHEDULE, 'launch', 120);          // 30: min(schedule, floor(120 / 4))
expectedFinalizeFees({ supplyMode: 'mint', protocolBps: 5, integratorBps: 20, buyerPaid: 2_400_000_000n, feesAccrued: 0n });
// { total: 6000000n, protocol: 1200000n, integrator: 4800000n }
```

`ledgerEntry(facts, recorded, tx)` compares three sources (the cross's counters through the fee rules, the `CrossFinalized` event, the finalize transaction's token balances) and returns `MATCH`, `MISMATCH` with the reason, or `UNVERIFIED` when the transaction is unavailable.

**Referrals.** A cross can name a referrer in its rules (ADR-0460): `finalize` pays it `floor(protocol fee x share / 10,000)` out of the protocol fee, and the fee recipient receives the rest. Put `referrer` and `referralShareBps` (from `CrossExt.referral`) in the facts and the entry expects that transfer: `referralShare`, `distributeFees` and `expectedFinalizeDistribution` give the amounts, `entry.referral` is what the referrer was owed, `totalsByMint` keeps the gross protocol fee and `referralFee` apart, and a finalize that paid the fee recipient the whole fee is a `MISMATCH` naming it. `statementFromEntries(..., 'referrer', ...)` is the referrer's statement of these payments, one line per cross; the `protocol` statement shows what the fee recipient was paid, net of the referral; `referrerStatementWithRouter` adds the off-chain router's per-order payouts, which are never owed on a cross that names a referrer on chain (`ReferralCross.referralShareBps`). ADR-0962.

`pnpm --filter @opening-cross/fees model` regenerates the tables of `docs/economics/FEE_MODEL.md`; a test fails if the document differs from what the model renders.
