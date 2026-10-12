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

## Tests and tooling

The test and proof scripts read their own variables (`DATABASE_URL` for the Postgres-backed suites, `RPC_URL` and `MAINNET_RPC_URL` for live reads, `AGAVE_BIN`, `CHROME` and `SEED` for the browser harness, `PYTH_API_KEY` for the oracle pull proof). Each is named at the top of the script that reads it and in the evidence file that records its run. `tests/e2e/run-all.sh` documents the browser harness.
