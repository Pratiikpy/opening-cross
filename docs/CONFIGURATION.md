# Configuration

Every environment variable the shipped processes read, taken from their entry points (`services/*/src/main.ts`, `apps/web/src/lib`, `apps/mobile/src/lib/config.ts`). A process that needs a variable and does not find it exits with status 2 and names the missing one. Secrets (keypairs, RPC keys, database passwords) live outside the repository; see `ENGINEERING_PRINCIPLES.md` section 6.

## Services

| Process | Variable | Required | Default | Meaning |
|---|---|---|---|---|
| `services/indexer` | `DATABASE_URL` | yes | | Postgres the indexer writes and the API reads. Migrations run on start. |
| | `RPC_URL` | yes | | Solana RPC for the cluster being indexed (finalized commitment). |
| | `POLL_MS` | no | `5000` | Time between polls. |
| | `RECONCILE_EVERY` | no | `60` | Run the reconciler (indexed state against chain) every this many polls. Drift is recorded and shown on `/status`. |
| `services/api` | `DATABASE_URL` | yes | | The indexer's database. |
| | `RPC_URL` | yes | | Solana RPC used to read accounts and to fetch a blockhash for unsigned transactions. |
| | `NETWORK` | no | `devnet` | Cluster name reported by `/v1/stats` and used by the identity check (`mainnet-beta` enables it; any other value reports "not comparable"). |
| | `PROMISE_SIGNER` | no | unset | Public key of the promiser, published at `/v1/promises/signer`. |
| | `CORS_ORIGINS` | no | `*` | Comma-separated origins allowed to call the API from a browser. Set it to the web app's origin in production. |
| | `RATE_LIMIT_PER_MINUTE` | no | `600` | Requests one client address may make per minute; over the limit the API answers 429 with `Retry-After`. `0` turns it off. `/v1/health` and CORS preflights are never limited. Counters are per process. |
| | `TRUST_PROXY` | no | off | Set to `1` behind a reverse proxy so the limiter and logs see the client address from `X-Forwarded-For` instead of the proxy's. Leave it off when the API is reached directly: a client could otherwise choose its own address. |
| | `OWN_WALLETS` | no | empty | Comma or space separated addresses of wallets we operate (keeper, promiser, market maker, team). `/v1/metrics/external-flow` leaves their orders out of the external figures, on top of each cross's creator, proceeds recipient, integrator and fee recipient. `deploy/docker-compose.yml` passes it from `deploy/.env`. A value that is not an address stops the process. |
| | `PORT`, `HOST` | no | `8080`, `0.0.0.0` | Listen address. |
| `services/keeper` | `RPC_URL` | yes | | Solana RPC. Transactions land over plain HTTP; no WebSocket endpoint is needed. |
| | `KEEPER_KEYPAIR` | yes | | Path to a Solana CLI JSON keypair that pays fees. Keep it off the repository. |
| | `DATABASE_URL` | no | unset | When set, crosses are discovered from the indexer; otherwise by scanning the program's accounts. |
| | `KEEPER_CREATORS` | no | all | Comma-separated creator addresses; the keeper then acts only on their crosses. |
| | `PASS_MS` | no | `10000` | Time between passes. |
| `services/promiser` | `DATABASE_URL`, `RPC_URL` | yes | | As above. |
| | `NETWORK` | yes | | Cluster name recorded in every signed promise (`devnet`, `mainnet-beta`, `localnet`). |
| | `PROMISE_KEYPAIR` | yes | | Path to the Solana CLI JSON keypair that signs promises and pays the memo anchor fees. |
| | `ROUND_MS` | no | `10000` | Time between sign-and-grade rounds. |
| | `ANCHOR_EVERY_MS` | no | `600000` | Time between Merkle-root memo transactions. |
| `services/premium` | `DATABASE_URL` | yes | | Postgres for observations. |
| | `RPC_URL` | yes | | A Solana **mainnet** endpoint: the monitor measures mainnet liquidity. |
| | `NETWORK` | yes | | Must be `mainnet-beta`; the process refuses anything else. |
| | `ROUND_MS` | no | `300000` | Time between rounds. |
| | `UNIVERSE_MS` | no | `21600000` | Time between rebuilds of the measured universe. |
| | `SIZES` | no | `100,1000,10000` | Order sizes in USD. |
| | `PACE_MS` | no | `250` | Pause between quotes, to stay inside the quote API's rate limit. |
| | `TICKERS` | no | all routable | Comma list restricting the universe. |
| `services/mcp` | `OPENING_CROSS_API` | no | `http://localhost:8080` | Base URL of the API the MCP server reads from. It holds no key. |

## Off-chain services, batch 2 (workstream W2A)

Registered with one call, `registerW2A(app, deps, process.env)` from `services/api/src/routes/w2a.ts`; the optional services run from `deploy/docker-compose.yml` under profiles (`docker compose --profile stream --profile billing --profile ops --profile monitor up -d`) and none starts by default.

| Process | Variable | Required | Default | Meaning |
|---|---|---|---|---|
| `services/api` (W2A routes) | `RPC_URL` | yes | | A comma separated list is allowed: the routes use a pool that tries the best-scoring endpoint first, rests a rate-limited or failing one, and moves to the next (`packages/reliability`). |
| | `W2A_SKIP` | no | empty | Comma separated groups to leave out: `liquidity`, `paid`, `blinks`, `execute`, `fees`, `duplicates`, `integrity`, `presets`, `agents`, `dashboard`. An unknown name stops the process. |
| | `X402_ENABLED` | no | off | `1` turns pay-per-call on; then `X402_ASSET`, `X402_PAY_TO`, `X402_FEE_PAYER_KEYPAIR` and `X402_SECRET_FILE` are required, and a half-configured gate stops the process instead of leaving the routes silently off. Off: the paid routes answer 501 and name the free route. |
| | `X402_ASSET`, `X402_PAY_TO` | with `X402_ENABLED` | | The mint buyers pay with and the wallet that receives payment (its token account for the mint must exist). |
| | `X402_FEE_PAYER_KEYPAIR` | with `X402_ENABLED` | | Keypair file of the account that sponsors the fee of each payment transaction. It needs at least 0.005 SOL. |
| | `X402_SECRET_FILE` | with `X402_ENABLED` | | File holding at least 32 random bytes as hex; keys the payment challenges. |
| | `X402_RPC_URL`, `X402_CONFIRM_TIMEOUT_MS` | no | `RPC_URL`, `90000` | Endpoint used for settlement, and how long a settlement waits to confirm before telling the buyer to retry. |
| | `X402_MPP_REALM`, `X402_ASSET_DECIMALS`, `X402_TOKEN_PROGRAM` | no | | Also accept MPP charge credentials, challenged under this realm (the API's hostname); the mint's decimals (6) and token program (Token-2022 off mainnet, Token on it). |
| | `ATTESTATION_KEYPAIR` | no | unset | Keypair file whose key signs verification receipts, audit bundles and fee statements; published at `/v1/attestations/signer`. Unset: those documents are returned unsigned and say so. |
| | `PUBLIC_API_ORIGIN` | no | request host | Absolute origin used in payment `resource.url` values. |
| | `JUPITER_BASE` | no | `https://lite-api.jup.ag/swap/v1` | Jupiter swap API for `/v1/route/execute`. Jupiter serves mainnet only; elsewhere a DEX route is not offered. |
| | `BACKING_ATTESTERS` | no | empty | Comma separated addresses whose signed backing attestations count. With none, every token's backing reads "unverifiable". Choosing them is the operator's decision. |
| | `BACKING_MAX_AGE_SECS` | no | `604800` | Oldest a backing attestation may be before the token reads "stale". |
| | `INTEGRITY_SERVICE_FUNDERS` | no | empty | Comma separated addresses known to fund many unrelated wallets (an exchange, a faucet). Wallets sharing only such a funder are not linked. |
| | `INTEGRITY_SERVICE_FANOUT` | no | `25` | A funder that has funded this many wallets is treated as a service. |
| | `INTEGRITY_MAX_TRACE` | no | `24` | Wallet histories read per request when tracing who funded a bidder; the rest are traced on later requests and count as unknown until then. |
| | `AGENT_REGISTRY_RPC_URL` | no | `RPC_URL` | RPC for the Metaplex Agent Registry (program `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p`, same address on mainnet and devnet; the real agents are on mainnet). |
| `services/marketmaker` | `API_URL`, `RPC_URL` | yes | | The Opening Cross API and a Solana RPC. |
| | `MM_KEYPAIR` | yes | | Keypair file of the maker wallet. |
| | `MM_QUOTE_BUDGET`, `MM_BASE_BUDGET` | yes | | Atoms the bot may commit per cross on each side. Digits only. |
| | `NETWORK` | no | `devnet` | On `mainnet-beta` the bot refuses to start unless `MM_ALLOW_MAINNET=yes-i-understand-this-spends-real-money`. |
| | `MM_HALF_SPREAD_BPS`, `MM_LEVELS`, `MM_STEP_BPS` | no | `200`, `3`, `100` | Half-spread around the reference price, price levels per side, and the step between them. |
| | `MM_MIN_SECONDS_LEFT` | no | `45` | Does not quote a cross that closes sooner than this. |
| | `MM_CREATORS` | no | any | Comma separated creators the bot quotes into. |
| | `MM_KINDS` | no | `reopen,recurring,tender` | Cross kinds quoted into. Launches are left out by default: a house order should not be demand in someone else's price discovery. |
| | `MM_FAIR_VALUES` | no | empty | `mint=price` pairs: the operator's fair value in quote tokens per base token. Without one, the reference is the last print or the indicative price; the bot never invents a price. |
| | `MM_MAX_OPEN_CROSSES`, `MM_PASS_MS` | no | `3`, `15000` | Crosses quoted at once, and the time between passes. |
| | `MM_SEAL_SECRET_FILE` | no | unset | Hex file (32+ bytes) from which every salt of a sealed order is derived. Without it sealed crosses are skipped. |
| | `MM_STATE_FILE`, `MM_LOG_FILE`, `MM_DRY_RUN` | no | `marketmaker-state.json`, unset, off | State between passes, an optional log, and `1` to plan without sending (nothing is saved). |
| `services/monitor` | `RPC_URL` | yes | | Solana RPC (read only unless armed). |
| | `MONITOR_ARM` | no | unset | `yes` arms the pause: on a critical finding that persists `MONITOR_CONSECUTIVE` passes it sets the protocol paused with the guardian key. Unset is a dry run that says what it would have done. It never unpauses. |
| | `MONITOR_GUARDIAN_KEYPAIR` | when armed | | Keypair file of the protocol's guardian (or admin). |
| | `MONITOR_INTERVAL_MS`, `MONITOR_CONSECUTIVE` | no | `15000`, `3` | Time between passes, and passes in a row a critical finding must persist before acting. |
| | `MONITOR_EXPECT_ADMIN`, `MONITOR_EXPECT_GUARDIAN`, `MONITOR_EXPECT_FEE_RECIPIENT` | no | unset | Pin the protocol authorities; a different value is critical. |
| | `MONITOR_PROGRAM_PINS`, `MONITOR_PIN_STRICT` | no | unset | JSON file of per-program executable hash and upgrade authority (write one with `pnpm --filter @opening-cross/monitor pins`); `1` makes a changed executable critical instead of a warning. A changed upgrade authority is always critical. |
| | `MONITOR_WATCH` | no | unset | JSON file of watched wallets `[{ address, label, role, mints?, minAtoms? }]`; reports tokens they send. |
| | `MONITOR_BACKING_URL` | no | unset | An Opening Cross API base URL; real-asset tokens whose backing is not verified are reported as warnings (the program can only pause the whole protocol, so this check never pauses). |
| | `MONITOR_WEBHOOK_URL`, `MONITOR_LOG_FILE` | no | unset | Where findings and decisions go besides standard output. Point the webhook at the ops console: `/v1/ops/hooks/monitor/<OPS_WEBHOOK_SECRET>`. |
| `services/stream` | `DATABASE_URL` | yes | | The indexer's database. |
| | `STREAM_PORT`, `STREAM_HOST` | no | `50051`, `0.0.0.0` | Listen address of the gRPC event stream. |
| | `STREAM_TOKEN` | no | unset | Clients must send `authorization: Bearer <token>`. |
| | `STREAM_TLS_CERT`, `STREAM_TLS_KEY` | no | unset | PEM files; both or neither. Without them the server is plaintext, for use behind a proxy that terminates TLS. |
| `services/billing` | `DATABASE_URL`, `RPC_URL` | yes | | Database and RPC (a comma separated list is tried in order). |
| | `BILLING_MINT`, `REVENUE_WALLET` | yes | | The token subscriptions are paid in and the wallet that receives them. |
| | `BILLING_KEYPAIR` | no | unset | Keypair file that signs invoices (documents only, no funds). Without it `POST /v1/billing/invoices` is refused. |
| | `BILLING_PORT`, `BILLING_HOST` | no | `8791`, `127.0.0.1` | Listen address. |
| `services/ops` | `DATABASE_URL` | yes | | Database; the indexer's migrations create the tables. |
| | `OPS_TOKENS` | no | empty | JSON list of `{ "name", "role": "viewer", "reviewer" or "admin", "sha256": "<hex of the token>" }`. With none, every request is refused. |
| | `OPS_API_URL` | no | unset | The public API, where a reviewer's evidence is gathered from. |
| | `OPS_WEBHOOK_SECRET` | no | unset | Secret in the monitor webhook's path. Unset turns the webhook off. |
| | `OPS_KEYPAIR` | no | unset | Keypair file that signs the audit-log head (documents only, no funds). |
| | `OPS_PORT`, `OPS_HOST` | no | `8792`, `127.0.0.1` | Listen address. Not exposed through Caddy by default. |

## Rules, treasury and settlement layer (workstream W3A)

The off-chain layer under the Wave 2D programs. Nothing in it needs a new variable except the one below; the programs it builds for are not deployed on devnet until the operator funding step H27 (`docs/HUMAN_TASKS.md`), and every route says so where it matters. Reference for the screens built on it: [`docs/api/W3A-rules-treasury-settle.md`](api/W3A-rules-treasury-settle.md) (SDK builders, every route with its request and response, the indexer tables, the verifier). Decisions: ADR-0500 to ADR-0505. Evidence: `docs/evidence/W3A-offchain-layer.md`, `docs/evidence/W3A-builders-devnet.md`.

| Process | Variable | Required | Default | Meaning |
|---|---|---|---|---|
| `services/indexer` | `SETTLE_PROGRAMS` | no | the deployed `cross_settle` | Comma separated `cross_settle` program ids to follow, each with its own cursor (`rpc:<program>`). The devnet Raydium variant is a second program with the same events. |
| `services/indexer` | migrations `016_cross_rules.sql`, `017_treasury_ext.sql`, `018_settle.sql` | applied on start | | Additive and idempotent: they add tables and columns only, so the indexer can be upgraded before the programs are. A cross or treasury of the deployed programs has no row in them and reconciles as before. |
| `services/api` | (none) | | | Registers `registerRulesTx`, `registerRulesRead`, `registerTreasuryTx`, `registerSettleTx`. `registerRulesTx` also installs a hook that runs every request inside a chain reader (`src/chain-context.ts`), which the builders behind `POST /v1/tx/settle` and `/v1/tx/finalize` use to read a cross's rules tail. `@opening-cross/adapters` (Meteora's SDK) is loaded on the first use of a `cross_settle` route, not at start. |
| `packages/verifier` | `conformance/generate_v3.py` | | | `python packages/verifier/conformance/generate_v3.py` rewrites `conformance/v3.json`. Its values are computed with Python integers from the specification and the program source, not by running the Rust code. |

## The seven Wave 3D programs (workstream W4A)

The off-chain layer under `cross_mandate`, `cross_conviction`, `cross_basket`, `cross_listing`, `cross_bounty`, `cross_backing` and `cross_graduate` and the batch 2 upgrade of `cross_settle`. The programs are not deployed on devnet until the operator funding steps H27 and H43: every route refuses with `PROGRAM_NOT_DEPLOYED` until then, and the indexer and keeper find nothing. Reference: `docs/api/W4A-new-programs.md`.

| Process | Variable | Required | Default | Meaning |
|---|---|---|---|---|
| `services/indexer` | `WAVE3D_PROGRAMS` | no | all seven | Comma list of the programs to follow (`cross_mandate`, `cross_conviction`, `cross_basket`, `cross_listing`, `cross_bounty`, `cross_backing`, `cross_graduate`), each under its own cursor (`rpc:<program id>`); `none` turns them off. |
| `services/indexer` | migration `019_wave3d_programs.sql` | applied on start | | Additive and idempotent; eighteen tables. |
| `services/keeper` | `KEEPER_DUTIES` | no | `default` | Adds `graduation` and `backing` to `default`, and `listings` and `bounties`, which are named only (`all` includes them). `bounties` pays rewards to the keeper wallet; `listings` may pay the rent of a venue's slash account. |
| `services/backing-attester` | `RPC_URL` | yes | | Solana RPC. |
| | `ATTESTER_KEYPAIR` | yes | | Path to the keypair of the attester named in the assets' policies. Keep it off the repository. |
| | `ATTESTER_CONFIG` | yes | | Path to the JSON file naming each asset and its source (`token-accounts`, `http-json` over https, `file-json`). A header value written `env:NAME` is read from the environment. |
| | `PASS_MS` | no | `30000` | Time between passes. |
| | `ATTESTER_DRY_RUN` | no | unset | `1` plans and sends nothing. |
| `services/api`, `services/mcp` | (none) | | | `registerMandateTx`, `registerConvictionTx`, `registerBasketTx`, `registerListingTx`, `registerBountyTx`, `registerBackingTx`, `registerGraduateTx`, `registerSettleWave3dTx` are installed by the server; the MCP server holds no key. |

## Web app (`apps/web`)

These are inlined at build time: change one and rebuild.

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | The API. Every figure on the site comes from here or from the chain. |
| `NEXT_PUBLIC_RPC_URL` | `https://api.devnet.solana.com` | RPC the browser sends signed transactions to. |
| `NEXT_PUBLIC_CHAIN` | `solana:devnet` | Wallet Standard chain id the app asks wallets for (`solana:mainnet`, `solana:devnet`, `solana:localnet`). Wallets that do not list it are hidden. |
| `NEXT_PUBLIC_SITE_URL` | unset | Public address of this deployment, used for absolute URLs in metadata, the sitemap and robots. On Vercel the production URL is used when this is unset; with neither, absolute URLs are left out. |

## Mobile app (`apps/mobile`)

| Variable | Default | Meaning |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://10.0.2.2:8080` | The API (an Android emulator reaches the host at `10.0.2.2`). |
| `EXPO_PUBLIC_RPC_URL` | `https://api.devnet.solana.com` | RPC for sending and confirming. |
| `EXPO_PUBLIC_NETWORK` | `devnet` | Cluster the wallet is asked to authorise: `devnet`, `mainnet-beta` or `testnet`. |

## Holder side: alerts, sponsored orders, comments, support (`services/api`, routes in `src/routes/holder*.ts`)

Everything below is optional. A feature with no keys is reported as not enabled by its own endpoint (`GET /v1/alerts/config`, `/v1/sponsor`, `/v1/support/config`) and the web pages say so; nothing is faked.

| Variable | Needed for | Meaning |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Browser push | A VAPID key pair (`pnpm --filter @opening-cross/api exec web-push generate-vapid-keys`) and a `mailto:` or `https:` contact. |
| `SMTP_URL`, `MAIL_FROM`, `WEB_URL` | Email alerts and the support inbox | `smtps://user:pass@host:465`, the From address, and the public address of the web app (the base of every link in a mail). |
| `ALERT_SECRET` | Email | Signs the tokens in mails. Derived from the SMTP credentials when unset; set it so rotating the SMTP password does not invalidate old unsubscribe links. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | Telegram alerts | A bot made with @BotFather. The API reads the bot's updates itself, so no webhook is needed. |
| `SPONSOR_KEYPAIR` | Sponsored fees | Path to a Solana CLI keypair file kept outside the repository. It pays the network fee and the order-account deposit for wallets without SOL, within the daily limits `GET /v1/sponsor` reports. Fund it with a small amount. |
| `MODERATOR_TOKEN` | Hiding a comment | Bearer token for `POST /v1/comments/:id/hide`. With none set nothing can be hidden. |
| `SUPPORT_INBOX`, `SUPPORT_RESPONSE_HOURS`, `SUPPORT_TOKEN` | Support | Where requests are mailed, the response time the page may promise (leave unset to promise none), and the bearer token for answering. |
| `RPC_URL` | Balances, order terms, sponsorship | Already used by the other services; the holder routes read the first answering endpoint of the list. |

Web app: `NEXT_PUBLIC_HOLDER_API_URL` (default: `NEXT_PUBLIC_API_URL`) points the holder routes at another host for testing. `NEXT_PUBLIC_ONRAMP_URL`, `NEXT_PUBLIC_ONRAMP_KEY`, `NEXT_PUBLIC_ONRAMP_MINT` and `NEXT_PUBLIC_ONRAMP_CODE` switch on the card-purchase link on a mainnet deployment: the provider's widget address, its key, the one token's mint it sells here and the provider's code for it. Without all four no card button is shown.

The web app registers a service worker at `/sw.js` (`apps/web/public/sw.js`) only when a person turns notifications on.

## Tests and tooling

The test and proof scripts read their own variables (`DATABASE_URL` for the Postgres-backed suites, `RPC_URL` and `MAINNET_RPC_URL` for live reads, `AGAVE_BIN`, `CHROME` and `SEED` for the browser harness, `PYTH_API_KEY` for the oracle pull proof). Each is named at the top of the script that reads it and in the evidence file that records its run. `tests/e2e/run-all.sh` documents the browser harness.
