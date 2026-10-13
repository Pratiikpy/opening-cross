# ADR-0301: RPC failover and transaction landing

Status: accepted, 2026-10-13. Row: Q4. Package: `packages/reliability`.

## Decision

1. Several endpoints sit behind one client. Each call goes to the endpoint with the best score (an exponentially weighted success rate over latency); the first URL listed breaks ties, since it is the one the operator trusts most. A rate-limited endpoint rests for as long as it asked (`Retry-After`), else one second doubling to a minute; an endpoint that fails twice in a row rests for two seconds doubling to a minute. An endpoint that a slot probe finds more than 40 slots behind is used only when nothing else is available.
2. An answer is final when it is the cluster's own: a failed simulation or a missing account is returned as it is, and no other endpoint is asked the same wrong question. What moves a call to the next endpoint is a 429, a 5xx, a timeout, a dead connection, a body that is not JSON, an "unhealthy node" JSON-RPC code, and a provider telling us we lack an API key.
3. Reads may be hedged (`hedgeAfterMs`): if the first endpoint has not answered, the second is asked too and the first answer wins. A send is never hedged by that route.
4. A transaction is landed by sending the same signed bytes to every live endpoint, resending every two seconds (the repeats skip preflight, since the first send already ran it), and watching its signature and the cluster's block height. Only when the height passes `lastValidBlockHeight`, after one last look through signature history, is it called expired. "Blockhash not found" is not treated as final, because a node that has not yet seen a fresh blockhash says the same.
5. A transaction that expired is rebuilt with a fresh blockhash and a higher fee (doubling to a ceiling the caller sets). It is never rebuilt while it might still land, so the rebuild cannot execute twice.
6. The priority fee is a percentile (default 0.75) of what the cluster charged recently for the accounts the transaction writes to, floored, and capped so one transaction's whole priority fee cannot exceed a stated number of lamports (default 100,000). With no data it pays the floor.

## Why

A public endpoint answers a burst with 429, and the hosted stack has met this repeatedly (H26). One dedicated key is the real remedy and stays a human step; until then a pool turns a hard failure into a slower success. Landing is separate from failover because the failure it covers is different: a node can accept a transaction and a leader still drop it, which only resending and watching the blockhash can resolve.

## Consequences

`FailoverRpc.asFetch()` lets `createRpcClient` in `@opening-cross/client` run over the pool without a change to the client. The services still read `RPC_URL` as before; moving the keeper, promiser and market maker onto the pool is a wiring change in each `main.ts`, not made here. Staked connections (priority delivery to leaders) need a provider account and stay HUMAN (H7, H26).
