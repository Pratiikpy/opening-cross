# Deploying the Opening Cross backend

The backend is five Node services, Postgres 17 and Caddy, started by one `docker-compose.yml`. The web app (`apps/web`) is a separate Vercel project that talks to it over HTTPS and WSS.

| Service | What it does | Needs |
|---|---|---|
| `db` | Postgres 17 (volume `pgdata`, not published) | `POSTGRES_PASSWORD` |
| `migrate` | one-shot, applies `services/indexer/migrations` before anything else starts | |
| `indexer` | follows `cross_core` on the cluster, writes events, reconciles against chain | `RPC_URL` |
| `api` | REST and `/v1/stream` WebSocket, behind Caddy | `PROMISE_SIGNER`, `CORS_ORIGINS` |
| `keeper` | clears, claims, refunds and finalizes crosses made by `KEEPER_CREATORS` | `.secrets/keeper.json` (fee payer) |
| `promiser` | signs, grades and anchors price bands | `.secrets/promiser.json` (signer and fee payer) |
| `premium` | measures mainnet stock-token liquidity on a schedule | `PREMIUM_RPC_URL` (mainnet) |
| `caddy` | automatic HTTPS (Let's Encrypt) for `SITE_HOST`, proxies HTTP and WebSocket to `api` | ports 80 and 443 |

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

Crosses opened by any other creator are not cranked by this keeper (anyone may crank them: the instructions are permissionless).

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
- Not hosted: `services/mcp` is stdio-only by design (ADR-0019); agents run it locally with `OPENING_CROSS_API` pointing at this API.

## Rehearse locally

```sh
sh deploy/pack.sh /tmp/ob.tgz && mkdir /tmp/ob && tar -xzf /tmp/ob.tgz -C /tmp/ob
cd /tmp/ob/deploy && mkdir .secrets && cp <keys> .secrets/ && printf 'POSTGRES_PASSWORD=x\nSITE_HOST=localhost\nPROMISE_SIGNER=<address>\nKEEPER_CREATORS=<address>\n' > .env
docker compose up -d --build     # https://localhost with Caddy's internal certificate
```
