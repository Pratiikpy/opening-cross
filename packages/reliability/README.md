# @opening-cross/reliability

RPC failover with health scoring, and transaction landing.

```ts
import { FailoverRpc, estimatePriorityFee, computeBudgetInstructions, landWithRetries } from '@opening-cross/reliability';

const rpc = new FailoverRpc(['https://staked.example', 'https://api.devnet.solana.com'], { rounds: 3 });
await rpc.call('getSlot');                       // best-scoring endpoint first; a 429, 5xx, timeout or missing-key reply moves to the next
const createRpcClientFetch = rpc.asFetch();      // for code that takes a fetch, such as @opening-cross/client's createRpcClient({ url, fetch })

const fee = await estimatePriorityFee(rpc, [payer, ...writableAccounts], { percentile: 0.75, maxTotalLamports: 100_000n });
const result = await landWithRetries(rpc, (microLamports) => buildAndSign(microLamports), { microLamports: fee.microLamports, maxMicroLamports: 50_000n });
// result.status is 'landed', 'failed' (with the cluster's error) or 'expired'
```

What it does and does not do: an answer that is the cluster's own (a failed simulation, a missing account) is returned as it is and never retried elsewhere. A transaction is sent by every live endpoint, resent every two seconds, and called expired only after the block height passes `lastValidBlockHeight` and one last look through signature history finds nothing; it is rebuilt with a fresh blockhash and a higher fee only after that, so it cannot execute twice. It does not give staked delivery (that needs a provider plan).

Run on devnet with two unusable endpoints and two live: `scripts/devnet-land.ts` landed a transfer in 1.3 s; `scripts/devnet-expiry.ts` held a transaction until its blockhash died, saw it expire, rebuilt at a higher fee and landed it. Evidence: `docs/evidence/W2A-Q4-reliability.md`; decision: `docs/adr/0301-rpc-failover-and-transaction-landing.md`.
