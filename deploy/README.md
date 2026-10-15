# Deploying the Opening Cross backend

The backend is five Node services, Postgres 17 and Caddy, started by one `docker-compose.yml`. The web app (`apps/web`) is a separate Vercel project that talks to it over HTTPS and WSS.

| Service | What it does | Needs |
|---|---|---|
| `db` | Postgres 17 (volume `pgdata`, not published) | `POSTGRES_PASSWORD` |
| `migrate` | one-shot, applies `services/indexer/migrations` before anything else starts | |
| `indexer` | follows `cross_core` on the cluster, writes events, reconciles against chain | `RPC_URL` |
| `api` | REST and `/v1/stream` WebSocket, behind Caddy | `PROMISE_SIGNER`, `CORS_ORIGINS` |
| `keeper` | clears, claims, refunds and finalizes crosses made by `KEEPER_CREATORS` and by the recurring series those creators are the authority of; optional duties below | `.secrets/keeper.json` (fee payer) |
| `promiser` | signs, grades and anchors price bands | `.secrets/promiser.json` (signer and fee payer) |
| `premium` | measures mainnet stock-token liquidity on a schedule | `PREMIUM_RPC_URL` (mainnet) |
| `caddy` | automatic HTTPS (Let's Encrypt) for `SITE_HOST`, proxies HTTP and WebSocket to `api`; also serves the `docs` and `ops` hostnames below once they are chosen | ports 80 and 443 |

Optional services run under compose profiles and none starts by default: `stream`, `billing`, `ops`, `monitor`, `gate` (the gate keeper, which closes the `cross_gate` passes anyone may close; it does nothing until a gate has rules) and `docs`. The promiser signs and anchors shared receipts when `RECEIPT_URL` is set.

All services run one image (`Dockerfile`: Node 22, pnpm workspace install, `node --import tsx src/main.ts`). The workspace packages are TypeScript source, so there is no build step. Containers run as the image's `node` user with a read-only root filesystem, all capabilities dropped and `no-new-privileges`.

## 1. A server

Any Ubuntu 22.04 or 24.04 host with 2 vCPU and 4 GiB, ports 22, 80 and 443 open, key-only SSH. On Azure, `sh deploy/provision-azure.sh` creates one (resource group `opening-bell-rg`, `Standard_B2s`, static IP) and prints the `user@host` and the `SITE_HOST` to use. Any provider works: `ship.sh` only needs SSH and `sudo`.

`SITE_HOST` is the server's address with dashes plus `.sslip.io`, for example `20-1-2-3.sslip.io` for `20.1.2.3`. sslip.io resolves it to the IP, so Let's Encrypt issues a certificate without owning a domain.

## 2. Keys and configuration

```sh
mkdir -p deploy/.secrets
solana-keygen new --no-bip39-passphrase -o deploy/.secrets/promiser.json
solana-keygen new --no-bip39-passphrase -o deploy/.secrets/keeper.json
# devnet SOL for fees: the keeper pays every crank, the promiser pays one memo per anchor
solana transfer --from <funded-devnet-key> $(solana address -k deploy/.secrets/promiser.json) 0.15 -u devnet --allow-unfunded-recipient
solana transfer --from <funded-devnet-key> $(solana address -k deploy/.secrets/keeper.json) 0.15 -u devnet --allow-unfunded-recipient
cp deploy/.env.example deploy/.env       # then fill it in
```

`deploy/.env` and `deploy/.secrets/` are git-ignored. Fill `POSTGRES_PASSWORD` (`openssl rand -hex 24`), `SITE_HOST`, `PROMISE_SIGNER` (the promiser's address) and `KEEPER_CREATORS`.

`KEEPER_CREATORS` limits the keeper to crosses made by those creator addresses; on a shared cluster an unscoped keeper would serve strangers' crosses. Once the stack has indexed the cluster, list the creators you own with:

```sh
docker compose exec db psql -U oc -d oc -c "select creator, count(*) from crosses group by 1"
```

Crosses opened by any other creator are not cranked by this keeper (anyone may crank them: the instructions are permissionless). A cross spawned by a recurring series is created by the series' own address, not by its authority, so the keeper serves a series' crosses when the series' authority is in `KEEPER_CREATORS` (it reads the series once a pass).

### Keeper duties

`KEEPER_DUTIES` (default `default`) names the optional work the keeper does besides clearing, claiming, refunding and finalizing; `default,locks,partner-fees` adds to the default list. Blank means `default`; the word `none` turns every optional duty off. The duties that cost the keeper money are done only when named: `locks` (it opens an owner's token account on a first release), `series` (it pays the rent of every cross it spawns), `listings`, `bounties`, and `partner-fees` (it opens the fee recipient's two token accounts, then claims the protocol's Meteora DBC trading fees to it; the program fixes the destination, so a claim can only pay the protocol, `KEEPER_PARTNER_FEE_EVERY_SECS`, `KEEPER_MIN_PARTNER_QUOTE` and `KEEPER_MIN_PARTNER_BASE` set how often and how much). With the billing profile running, set `KEEPER_BILLING_URL=http://billing:8791` and the `series` duty spawns only for issuers with a paid subscription period, except the authorities in `KEEPER_ENTITLEMENT_EXEMPT`; no user's money is ever conditioned on a subscription. `KEEPER_DRY_RUN=1` plans everything and sends nothing. Every variable is in `.env.example`.

### The operations console and the docs service

Both are optional, and neither is public until a hostname is chosen on purpose. The variables are in `.env.example` and `docs/CONFIGURATION.md`.

**The operations console** is two parts: the `/ops` pages of the web app (a Vercel project) and `services/ops`, its API (profile `ops`). The browser never talks to the API: the web app's own `/ops/api` route passes a request on from the server, with the person's bearer token and nothing else, to `OPS_CONSOLE_URL`. The decision, in order of what protects what:

1. The console API accepts no request without a token, and holds only each token's sha-256. With no `OPS_TOKENS` every request is refused.
2. `services/ops` binds to `127.0.0.1:8792` on the host and is not reachable through the `SITE_HOST` block of the Caddyfile at all. The web app reaches it on the same host with the default `OPS_CONSOLE_URL`.
3. A web app on another host (Vercel) cannot reach loopback. For that case the Caddyfile has a second block, `OPS_SITE_HOST`, that proxies only `/v1/ops/...`, never the monitor's webhook (`/v1/ops/hooks/...`, which the monitor reaches on the compose network), and answers only from `OPS_ALLOWED_IPS`. Everyone else gets 403. Unset, the host name is `ops.localhost` and the allowed address is loopback, so nothing is exposed. Set `OPS_CONSOLE_URL=https://<OPS_SITE_HOST>` in the web project. Vercel's servers do not call from a fixed address, so an address allow list there is only as tight as the range you can name: if you cannot name one, keep the block closed and run the console API on the same host as a web app you serve yourself, or put the web app's `/ops` behind Vercel's own deployment protection.
4. The `/ops` pages carry `noindex`, are left out of the sitemap and are disallowed in `robots.txt`. That keeps them out of search results; it is not access control, which is 1 to 3.

Checked with a stub upstream behind Caddy 2: from an allowed address `/v1/ops/log` is proxied (200), the webhook path and every other path are 404, and from any other address every path is 403.

**The docs service** (`docs`, `services/docs-mcp`) serves the repository's Markdown documents as a site, over MCP at `/mcp` and as JSON, read-only. `pack.sh` puts into the image the committed Markdown documents under `docs/`, `README.md` and a `.git/HEAD` naming the commit, so every answer says which revision it was read at; a document that is not committed is not served. Runbooks and security notes are left out unless `DOCS_KINDS` names them. Set `DOCS_SITE_HOST` (and `DOCS_PUBLIC_URL`, which goes into `/llms.txt`) to publish it; the service counts requests per client from the address Caddy forwards.

## 3. Ship it

```sh
sh deploy/ship.sh <user>@<host> [~/.ssh/key]
```

This packs the tracked files (`pack.sh`; secrets are git-ignored and never included), copies them with `.env` and the two keypairs to `/opt/opening-bell` (keypairs mode 600, owned by uid 1000), installs Docker if missing, builds the image and runs `docker compose up -d`. Run it again to deploy a new version; the database volume is kept.

Check it:

```sh
curl -s https://$SITE_HOST/v1/health        # {"ok":true,"indexedSlot":"...","recentDriftAlerts":0}
curl -s https://$SITE_HOST/v1/stats
ssh <user>@<host> 'cd /opt/opening-bell/deploy && sudo docker compose ps && sudo docker compose logs --tail=20 keeper promiser indexer'
```

A fresh database is filled by the indexer walking the program's history through the RPC. On the public devnet RPC that took about 45 minutes for the first 48 crosses; `/v1/health` reports the slot it has reached.

## 4. The web app

```sh
vercel link --project opening-bell                  # once, from the repository root
vercel env add NEXT_PUBLIC_API_URL production       # https://<SITE_HOST>
vercel env add NEXT_PUBLIC_RPC_URL production       # https://api.devnet.solana.com
vercel env add NEXT_PUBLIC_CHAIN production         # solana:devnet
sh deploy/vercel-deploy.sh --prod
```

`NEXT_PUBLIC_*` values are inlined at build time, so a change needs a new deploy. The project's Root Directory is `apps/web`; `vercel-deploy.sh` stages only the workspace files the build needs, because the repository as a whole is far over Vercel's 15 000-file upload limit. The API allows any origin by default; set `CORS_ORIGINS` to the web origin(s) to restrict it.

## Operating it

- Logs: `docker compose logs -f <service>`; each service logs JSON lines, 20 MB x 5 files kept.
- Restart one service: `docker compose restart keeper`. Change `.env`, then `docker compose up -d`.
- Backup: `docker compose exec -T db pg_dump -U oc oc | gzip > oc-$(date +%F).sql.gz`. The index is rebuildable from chain; the promise tables (signed bands, grades, anchors) are not, so back those up.
- The promiser key is the identity every signed band is checked against. Replacing it starts a new track record; keep it and the `PROMISE_SIGNER` value in step.
- Throttling: the public devnet RPC rate-limits. A dedicated endpoint in `RPC_URL` makes the first backfill and the keeper faster.
- Not hosted: `services/mcp` is stdio-only by design (ADR-0019); agents run it locally with `OPENING_CROSS_API` pointing at this API. Its documentation tools are hosted by the `docs` profile (above).

## Rehearse locally

```sh
sh deploy/pack.sh /tmp/ob.tgz && mkdir /tmp/ob && tar -xzf /tmp/ob.tgz -C /tmp/ob
cd /tmp/ob/deploy && mkdir .secrets && cp <keys> .secrets/ && printf 'POSTGRES_PASSWORD=x\nSITE_HOST=localhost\nPROMISE_SIGNER=<address>\nKEEPER_CREATORS=<address>\n' > .env
docker compose up -d --build     # https://localhost with Caddy's internal certificate
```
