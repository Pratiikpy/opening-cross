# X6, Y7, P6: the integration tests that need Postgres and a validator

Run: 2026-10-13, Windows 11 host with WSL2 (Ubuntu 22.04, mirrored networking). Result: **all pass; 0 product defects, 0 harness defects, 1 external flake (Jupiter HTTP 429, passed on re-run)**.

## What was skipped before, and where it lives

`docs/FEATURE_STATUS.md` said "the 54 integration tests that need Postgres and a validator were skipped here". They are the 54 tests of `packages/x402/test/payments.test.ts`, which `describe.skipIf(!up)` unless a validator answers on `X402_TEST_RPC` (default `127.0.0.1:8940`) and which opens a Postgres schema through `DATABASE_URL` (default `postgres://postgres:oc@localhost:55432/postgres`). Other suites also skip without `DATABASE_URL` (`tests/core` api, indexer, premium, promiser; `services/api` metrics-http and order-terms); they were run too.

## Environment

| Part | What |
|---|---|
| Validator | `solana-test-validator 3.1.14` (Agave, from `~/.local/share/solana/install/releases/stable-*`), `--reset --rpc-port 8940`, in WSL. Reached from the Windows test process on `127.0.0.1:8940` |
| Postgres | Docker `postgres:17` (container `ocpg17`, `-c max_connections=400`) on `127.0.0.1:55440`. The default port 55432 was held by a stale listener, so `DATABASE_URL=postgres://postgres:oc@127.0.0.1:55440/postgres` was set |
| x402, services/api | Windows Node 22.17, pnpm 10.32.1, `vitest 5.0.3` |
| tests/core | WSL Node 22.23.2 (`litesvm` ships no Windows binary): `cd tests/core && node node_modules/vitest/vitest.mjs run` with the same `DATABASE_URL` |
| MPP interop | `@solana/mpp@0.7.0`, `@solana/kit@6`, `mppx@0.13.4` installed outside the repository; `MPP_INTEROP_DIR` points at it |

## Results

| Package | Command | Files | Tests |
|---|---|---|---|
| `@opening-cross/x402` | `pnpm test`, validator and Postgres up, `MPP_INTEROP_DIR` set | 5 passed | **105 passed, 0 skipped** |
| `@opening-cross/x402` without `MPP_INTEROP_DIR` | same | 5 passed | 103 passed, 2 skipped (the MPP interop test, once per token program) |
| `services/api` | `DATABASE_URL=… pnpm exec vitest run` | 8 passed | 71 passed |
| `tests/core` (LiteSVM, WSL), the four database suites | `vitest run api indexer premium promiser` | 4 passed | 18 passed (premium 3, indexer 6, api 3, promiser 6) |
| `tests/core`, whole suite with `DATABASE_URL` | `vitest run` | 27 passed, 1 failed | 134 passed, 1 failed |
| `tests/core` `router.test.ts` re-run | `vitest run router` | 1 passed | 2 passed |

Per file in `packages/x402` (counted from the verbose run): `payments.test.ts` 54, `verify.test.ts` 15, `wire.test.ts` 13, `mpp-wire.test.ts` 21, `public-facilitator.test.ts` 2 (this one reaches `https://x402.org/facilitator` and ran). The 54 payment tests are the 54 the status row counted, 27 for each of SPL Token and Token-2022, including the MPP charge over the same route and the official `@solana/mpp` client paying a server that has never seen it.

Excerpt of the x402 run (real mint, token accounts, fee payer, Postgres ledger, Fastify route; outcomes read back from token balances and fee payer lamports):

```
 ✓ test/payments.test.ts > x402 exact on SPL Token > sells the response for exactly the price, settles on chain and records the payment 819ms
 ✓ ... > refuses the same payment again, on the same request and on another, without moving funds 373ms
 ✓ ... > lets exactly one of two concurrent requests with one payment succeed 484ms
 ✓ ... > records the signature before broadcast and reconciles a payment a crash left pending 472ms
 ✓ ... > refuses to spend a fee payer that is nearly empty 541ms
 ✓ ... > MPP charge over the same route > accepts the compute-budget order of the official client (price, then limit, 200000 units), which x402 refuses 477ms
 Test Files  5 passed (5)
      Tests  105 passed (105)
```

## Triage

| Finding | Class | Detail |
|---|---|---|
| `tests/core/test/router.test.ts` "predicts the cross outcome exactly and compares it with a live route at the same moment" failed in the first whole-suite run | **External flake** | `Error: Jupiter answered HTTP 429: Rate limit exceeded, please try again later.` at `router.test.ts:92`. The same test passed on the next run (2 of 2, 1.5 s). The test calls Jupiter live by design |
| Port 55432 refused `docker start ocpg` ("address already in use") | Environment | A stale listener holds the port inside WSL. Worked around with a new container on 55440; the listener was not killed because it is not ours |
| `litesvm` has no Windows binding (`Cannot find module 'litesvm-win32-x64-msvc'`) when `tests/core` is run from Windows | Known (README) | Run `tests/core` in WSL; the Linux bindings are already installed by `supportedArchitectures` in `pnpm-workspace.yaml` |

No harness bug and no product defect surfaced, so no source was changed for this task.

## Not covered

- `pnpm -r test` across every other workspace package with the database and validator up was not run; only the packages that skip without them were.
- The x402 suite was run against Agave 3.1.14. The repository pins Agave 4.0.2 for program builds (ADR-0001); the x402 tests do not load repository programs, but they were not run on 4.0.2.
- Payments were made only against a local validator. The public facilitator's `/verify` and `/supported` were exercised; no payment settled through it.
- The `x402` package is still not wired into the API or MCP server; this run does not change that row's other gaps.

## Reproduce

```sh
# WSL
docker run -d --name ocpg17 -e POSTGRES_PASSWORD=oc -p 127.0.0.1:55440:5432 postgres:17 -c max_connections=400
solana-test-validator --reset --rpc-port 8940 --ledger ~/tv/ledger --bind-address 127.0.0.1
# repository root
export DATABASE_URL=postgres://postgres:oc@127.0.0.1:55440/postgres
pnpm --filter @opening-cross/x402 test
# WSL, for LiteSVM
cd tests/core && node node_modules/vitest/vitest.mjs run
```
