# W2A-Q4: RPC failover and transaction landing

Date: 2026-10-13. Decision: ADR-0301. Code: `packages/reliability` (pool, failover, priority fees, landing, two devnet scripts). Tests: 25 (`test/reliability.test.ts`), `tsc` clean for source and tests.

## Tests (scripted network, injected clock)

Pool ordering by latency and reliability; rate-limit rest honouring `Retry-After`; one failure forgiven, repeated failures rest longer up to a cap and recover on a good answer; a lagging endpoint set aside. Failover on 429, 503, a dead connection, a timeout (the fake honours abort, like fetch), an unhealthy-node code and a missing-API-key reply; the cluster's own error returned without asking a second endpoint; a total outage mapped to 503 and a total rate limit to 429 for code that takes a fetch; read hedging, and sends never hedged. Landing: resends until seen; on-chain failure reported with the cluster's error; every route refusing the first send for a reason that cannot change; a node that has not seen a fresh blockhash does not end the attempt; expiry declared only after the height passes and a history look finds nothing; a transaction that landed just before the blockhash died is `landed`; rebuild doubles the fee up to the ceiling and a landed transaction is never rebuilt.

## Real devnet runs

1. `scripts/devnet-land.ts` with four endpoints, two unusable: `devnet.sonic.game` (empty reply) and `rpc.ankr.com/solana_devnet` (wants an API key), plus `api.devnet.solana.com` and OnFinality's public endpoint. The slot probe reported null for the two dead ones and 510692092 / 510692095 for the live ones; the fee estimate used 150 recent slots; a signed transfer with compute-budget instructions landed in 1.3 s at slot 510692100. Health afterwards: the dead endpoints 0 successes in 2 calls each, public devnet 7 calls with 0 failures (success rate 0.98, 132 ms), OnFinality 1 rate limit in 2 calls.
2. `scripts/devnet-expiry.ts`: a transaction built and held until its blockhash was dead (height 497916247 past 497916221, about 60 s). Landing it ended in `expired` after one send that no endpoint accepted; the retry path rebuilt at 10 micro-lamports per unit (from 5) with a fresh blockhash and landed it (signature `5BTk3kbd...CWAX`, slot 510692415).
3. Source of truth, read back with `getTransaction` on public devnet: the landed transaction has fee 5001 lamports (5000 base plus 1 priority), err null, 450 compute units; the expired transaction is not on the chain.

## Found while testing

My first version treated "Blockhash not found" as a reason to give up after the first send. A node that has not yet seen a fresh blockhash returns the same, so that would have failed good transactions on a lagging endpoint. It is no longer final; the block height decides. A provider's "Unauthorized" JSON-RPC reply was first returned to the caller as if it were the cluster's answer; it now moves the call to the next endpoint.

## Not covered

Priority fees on a congested cluster: devnet's recent fees were near zero, so the percentile and cap logic is tested with scripted fees, not seen under real contention. Staked connections and provider landing services (HUMAN, H7 and H26). Mainnet. The pool is not yet wired into the keeper, promiser, market maker or API `main.ts` files. Slot lag was observed as a few slots on devnet; the 40-slot rule was exercised only in tests.
