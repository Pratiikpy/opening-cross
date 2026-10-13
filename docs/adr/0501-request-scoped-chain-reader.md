# ADR-0501: A chain reader that follows the request

Status: accepted (2026-10-14).

## Context

`POST /v1/tx/settle` and `POST /v1/tx/finalize` are handlers in `services/api/src/server.ts` that call `settleTxs(cross, payer, lt, oracle)` and `finalizeTx(cross, payer, lt)` with a decoded `Cross` and no reader. A cross with rules needs its rules tail to build either (the ending buckets to merge, the referrer to pay), and the tail is not in the decoded struct. The other handlers pass a `fetch` and can read it. The rules-layer work was not to change `server.ts` beyond registering its routes.

## Decision

`registerRulesTx` installs an `onRequest` hook that runs the request inside an `AsyncLocalStorage` holding the server's chain reader and clock (`services/api/src/chain-context.ts`). `settleTxs` and `finalizeTx` read the cross's account through it when it is set and otherwise build for the cross as given. The context belongs to the request, so two servers in one process (the tests start several) never read each other's chain, and a library caller outside a request gets exactly the old behaviour. The hook is registered before the other routes so that it covers them; a test starts the whole server and settles a cross with an ending through the old route.

## Alternatives

Passing `fetchOwned` to the two functions at their call sites is a two-line change and is the cleaner answer; it needs an edit to `server.ts` handlers that this work did not make. When that file is next open for edit the context can be deleted and the parameter passed.

## Evidence

`services/api/test/rules-tx.test.ts`: "the old settle route (server.ts) reads the rules tail", "settle refuses, naming the reason, while a draw is owed", "the old finalize route (server.ts) passes the referrer account".
