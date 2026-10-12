# W2 live deployment: web on Vercel, backend on a VM (devnet)

Run: 2026-10-12. Status: **BLOCKED on the VM. Everything else is built, and the whole stack was proven on a Docker rehearsal of the same compose file against real devnet.**

## What is live and what is not

| Part | State |
|---|---|
| Web app on Vercel | Deployed: project `opening-bell` (team `pratiikpys-projects`), root directory `apps/web`, build proven on Vercel's own pnpm monorepo install. URL https://opening-bell-psi.vercel.app. Its `NEXT_PUBLIC_API_URL` still points at a temporary tunnel that is gone, so the pages render their "API unreachable" states until the backend has a permanent address and `sh deploy/vercel-deploy.sh --prod` runs again with the project env set. |
| Backend VM | **Not created.** The Azure subscription is disabled (below). No other cloud account was used. |
| Backend stack | `deploy/` is complete and was run end to end locally from the same files (`docker compose build`, `up`, Caddy, migrations, indexer backfill from devnet, API, keeper, promiser, premium). |

### Why there is no VM

Everything tried, in order:

1. `az account show` reports "Azure for Students", state Enabled (the CLI's cached value).
2. `az group create -n opening-bell-rg -l centralindia` failed: `ReadOnlyDisabledSubscription: The subscription '63b25567-...' is disabled and therefore marked as read only.`
3. `az rest GET /subscriptions/63b25567-...` returns `"state": "Disabled"`, `quotaId AzureForStudents_2018-01-01`, `spendingLimit: On` (the student credit is spent or expired). `az account list --all` shows no other subscription. A different region or size cannot help: no write is allowed anywhere on a disabled subscription. (The `Allowed resource deployment regions` policy would have allowed centralindia, malaysiawest, eastasia, austriaeast, uaenorth.)
4. Other providers on this machine: the AWS CLI profile `default` has an expired session; profile `horos` is valid (root of account 700800569846, the account that hosts Horos). Not used: it spends real money outside the stated Azure plan and sits in the account of a listed ASP. DigitalOcean: no `doctl`, only the key for the Aletheia droplet (listed ASP, not touched). Railway: not logged in.

To finish: re-enable the Azure subscription in the portal (remove the spending limit or upgrade) and run `sh deploy/provision-azure.sh` (not run: NOT VERIFIED), or approve a VM on another account. Then `sh deploy/ship.sh <user>@<ip>` and `sh deploy/vercel-deploy.sh --prod`. `deploy/.env` and `deploy/.secrets/{promiser,keeper}.json` are already prepared (git-ignored; devnet throwaway keys; `SITE_HOST` is the one value that needs the IP).

## What was built (all under `deploy/`)

`Dockerfile` (one image, Node 22, pnpm workspace install, `node --import tsx`), `docker-compose.yml` (postgres:17, one-shot `migrate`, indexer, api, keeper, promiser, premium, caddy; read-only containers, caps dropped, log rotation, healthcheck on the API), `Caddyfile` (automatic HTTPS for `<ip-with-dashes>.sslip.io`; WebSocket upgrade works through `reverse_proxy`), `.env.example`, `migrate.ts`, `pack.sh` (tracked and non-ignored files only, so secrets cannot be included), `ship.sh` (copy, install Docker, build, start; idempotent), `provision-azure.sh`, `vercel-deploy.sh` (the repository is far over Vercel's 15 000-file upload limit, so it stages only the workspace files the web build needs), `README.md`. `.gitignore` gained `!/deploy/` (it is an allowlist). The API runs with `TRUST_PROXY=1` behind Caddy so the rate limiter counts real clients.

## Verified (rehearsal: same compose, real devnet, `RPC_URL=https://api.devnet.solana.com`)

| Check | Result |
|---|---|
| `docker compose build` and `up` from a packed tree | PASS: `migrate` exits 0 (10 tables), all services up, 0 restarts after 2 h |
| Indexer backfill from empty | PASS: 48 crosses, 33 printed, equal to `T-trust-devnet.md`; `/v1/health` `recentDriftAlerts: 0`. It took about 45 minutes on the public endpoint |
| API reads | `/v1/health`, `/v1/stats`, `/v1/crosses`, `/v1/crosses/:a`, `/book`, `/proof` (`verified`), `/promise`, `/v1/accuracy`, `/v1/premium/summary` and `/latest`, `/v1/promises/signer`: all 200 with real data; `/v1/crosses/nonsense` 400; unknown account 404; unknown route 404 |
| Token identity | Hosted API follows devnet, so the registry answers `comparable:false` for a mainnet mint (by design). With a second API process on `NETWORK=mainnet-beta`: TSLAx `XsDoVfqe...` and NVDAx `Xsc9qvGR...` are `GENUINE`, `1111...1111` is `NOT_A_MINT`, `not-a-mint` and a 60-character string are 400 |
| CORS | `access-control-allow-origin: *` seen with an `Origin: https://opening-bell.vercel.app` request |
| WebSocket | `wss://.../v1/stream` through an HTTPS tunnel: `subscribed` frame, then 17 real `OrderClaimed`/`CrossFinalized` events in 60 s while the indexer committed |
| Vercel build | PASS: pnpm monorepo install and `next build` on Vercel from the staged tree |
| Pages on the Vercel URL (tunnelled API) | `visual.mjs`: 9 routes x desktop/mobile x light/dark, 36 of 36 PASS (zero console errors, failed requests, overflow, axe) at the time. Later passes on a local build of the same code against the final data: 8 routes x 4, all PASS. Screenshots read: home, status, cross, track record, premium |
| Figures equal the API | Home "38 printed, 38 filled, 51 total, 0 no-print" equals `/v1/stats` (after the page's 15 s revalidation) |
| MCP | `services/mcp` is stdio-only by design (ADR-0019 non-goal: a hosted endpoint needs rate limits and an abuse policy), so it is **not hosted**. Driven as a real client over stdio against the stack: 17 tools listed; 12 reads answered with the untrusted-content envelope; bad arguments, unknown tool and a missing field refused with typed errors and no request |
| **Full user lifecycle on devnet** (`apps/web/e2e/live-devnet.mjs`) | PASS: issuer opens a cross from the console (cross `7E53LcNrf6hH6qHURV9ys1SGYnLTqo7sFn51fFhq8vWW`, base mint authority moved to it on chain); a buyer places 600 at 1.30 (780 quote into escrow, read from chain); the promiser signs a band while the call is open and the page shows it; after the close the deployed keeper clears, claims and finalizes at 1.20 with nobody pressing anything; the buyer holds 600 base tokens on chain; the band is graded `SCORED`, error 0 ticks; a stranger's `verify --rpc` passes all four checks |
| Keeper on old crosses | After the fixes below the keeper finalized crosses that had been stuck since the harness runs (`CYg6wA...`, `5fxcGk...` among them): 30 to 47 Finalized across the day |
| Promiser | 2 anchor Memo transactions recorded, 5 bands signed and graded |

Screenshots of the lifecycle: `docs/evidence/screens/w2-live/`.

## Defects found by running it live, and fixed

1. **A cross could not be finalized unless someone had pre-created the fee accounts.** `finalize` pays the protocol fee, integrator fee and proceeds into token accounts that must exist; on a quote mint the fee recipient had never held, the keeper failed forever (`AccountNotInitialized fee_recipient_quote`). Fix: `buildFinalizeWithAccounts` in `packages/sdk/src/index.ts` creates any missing accounts idempotently, and the keeper (`services/keeper/src/keeper.ts`) and the API (`services/api/src/tx.ts`) use it. Proven live on the old stuck crosses and on the new one.
2. **`create_cross` reads the creator's quote account**, so an issuer with none got "The program expected this account to be already initialized". `buildCreateCross` now also returns `ensureCreatorQuote`, sent first by the API. The creator also pays a small dust bond in the quote token (`maxOrders x highest price`, 2 950 atoms for the console defaults), so an issuer must hold a few quote atoms; the console does not say so (see below).
3. **The browser reported failure when the public RPC answered 429.** `apps/web/src/lib/tx.ts` threw "Too many requests for a specific RPC call" while confirming, after the create transaction had landed but before the shard transactions were sent, stranding a cross with partly initialized shards. `rpc()` now retries 429 with backoff (shared file; minimal edit).
4. **The API turned an upstream RPC failure into a bare 500 and logged nothing.** `services/api/src/server.ts` now logs 5xx causes and answers 503 with `Retry-After` when the cause is the RPC endpoint (shared file; minimal edit).
5. Regression test `tests/core/test/fresh-accounts.test.ts`: new mints, an issuer with no quote account, a fee recipient with none; the plain `finalize` fails with `AccountNotInitialized`, `buildFinalizeWithAccounts` finishes the cross. Core suite on LiteSVM in WSL: 124 of 125 pass, the one failure is a live Jupiter call answered 503.

## Found, not fixed (not mine to change: `apps/web/src` is under another agent's review, or it needs a decision)

- **The public devnet RPC is the bottleneck.** With the indexer, keeper, promiser and a browser all on one IP it answers 429 constantly; API reads that check chain took 10 to 19 s at worst. A dedicated devnet endpoint in `RPC_URL` and `NEXT_PUBLIC_RPC_URL` is needed for a usable deployment (HUMAN H20).
- **Creating a cross is not atomic in the console.** The create transaction and the shard transactions are separate; a failure between them leaves a Live cross with missing shards that no keeper can clear (two such crosses exist from my failed attempts: `ESK7WLwL...`, and the one for mint `75bTi5vv...`).
- **The console does not say what creating costs.** About 0.2 SOL of rent for the cross, book and four shards, plus the quote bond; the failure for lack of SOL read "custom program error: 0x1".
- **`/status` shows "All systems normal" while the indexer is hours behind** (it checks that the database answers, and says so in small print). An indexer heartbeat would make it honest.
- **Premium monitor values are not filtered for plausibility**: the overnight session shows medians such as 883 806 % for IRENx. They are measured Jupiter quotes against the reference, but a reader cannot tell a broken route from a real premium.
- The hosted API follows devnet, so the token identity panel always says "not comparable" for the mainnet registry.
- Keeper scope: 26 harness creators are in `KEEPER_CREATORS`; crosses opened by anyone else are not cranked by this keeper.

## Not covered

- The VM itself: provisioning, Let's Encrypt issuance on a public host, `ship.sh` and `provision-azure.sh` (both unrun, NOT VERIFIED), SSH hardening, a reboot, cost in practice.
- Vercel production against a permanent API, CORS from the real Vercel origin to the real API (the header was seen with a made-up `Origin`; the browser flows ran against a local build of the same code), `wss` from the Vercel page.
- Sealed crosses, cancel, reveal and the other order flows on the live stack (covered on a local validator in `T-trust-e2e.md`), the mobile app, the premium monitor outside the `closed`/overnight sessions, a calibrated (non-provisional) band, a multi-day run.
- A test of what happens to the rehearsal stack under a dedicated RPC; none was available.

## Cost

Azure `Standard_B2s` (2 vCPU, 4 GiB) in centralindia: about 35 USD per month, plus 64 GiB StandardSSD (about 5) and a static IP (about 4): roughly 45 USD per month, against the student credit. Vercel Hobby: 0. The same sizing on AWS (`t3.medium`) is about 35 USD per month. Memory use of the stack was not measured, so 4 GiB is a safe guess, not a measured minimum (NOT VERIFIED); a 2 GiB size was not tried.
