# ADR-0924: Pool routes of the API (D9, A10, X8, K5, Z1, W9)

Status: accepted (2026-10-16).

## Decision

`services/api/src/routes/pools.ts` (one registration, `registerPools`) serves `GET /v1/pools/:address`, `/v1/pools?base&quote`, `/v1/pools/route`, `/v1/pools/by-cross/:address`, `/v1/pools/summary`, `/v1/depth/cross/:address` and `POST /v1/pools/swap-tx`. Everything is read from chain at the request through the API's account reader, with the Clock sysvar as the time (slot for slot-activated pools, unix time otherwise, epoch for transfer fees). The API holds no key; the swap comes back unsigned with the trader as fee payer, after checks that can be made from chain state (open, balance, hook, pause, enough liquidity, minimum below quote), each with a stable `reason`.

Discovery looks only at the addresses the adapters open a pair at (the customizable DAMM pool and the DLMM pair of the two mints). Other pools for the pair exist and cannot be listed without scanning the programs; `pool=` names one. Said in every response.

Persistence is observed since the process first read the pool and is labelled so; it is not durable.

`/v1/dashboard` gains a `liquidity` section (the summary route) only when the pool routes are mounted, so a deployment without them is not shown a section that can only say it is missing.

## Integration (outside this change)

`registerPools(app, { account, lifetime, db, network, clock })` must be called from `server.ts`; the web client needs `/pools` in the navigation.
