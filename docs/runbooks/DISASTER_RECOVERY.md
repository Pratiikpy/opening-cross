# Disaster recovery

Status: written 2026-10-13 for the devnet deployment (`deploy/docker-compose.yml`, one host). The recovery objectives below are **targets, not measurements**; the drills in section 6 measured what they say they measured and nothing more. Multi-region hosting and the key ceremonies are not built and are recorded in `docs/HUMAN_TASKS.md`.

## 1. What you can lose, and what that costs

The chain is the source of truth for everything that matters financially. The database is an index of it plus a small amount of data that exists nowhere else. `services/indexer/src/dr.ts` classifies every table, and a test (`test/dr.test.ts`) fails when a table exists that is not classified, so this section cannot drift from the code.

| Class | What it is | If the database is lost |
|---|---|---|
| chain | `events`, `crosses`, `orders`, `cursors`, calendar and treasury tables, `cross_statics`, `indexer_heartbeat`, `reconciliation_alerts` | Rebuilt by running the indexer again. No loss. |
| derived | `promise_grades` | Recomputed from `promises` and the crosses. |
| cache | `token_labels`, `funding_cache` | Read again on demand. No loss. |
| backup | signed promises, referrals, market-maker registrations, intents, integrity documents, rating snapshots and outcomes, billing payments and invoices, x402 payments, gate allowlists, issuer records, comments, alert subscriptions, support requests, sponsor ledger | **Gone** unless backed up. This is the list `backupTables()` returns. |

Funds are never in the database. Escrow, fees and proceeds are in program-owned token accounts; a lost database cannot lose them, and claims and refunds work without any off-chain service.

## 2. Targets

| Objective | Target | How it is met |
|---|---|---|
| Recovery point for the backup class | 24 hours | a daily backup (section 3) kept off the host |
| Recovery time, one host, database intact | 30 minutes | `sh deploy/ship.sh` onto a fresh Ubuntu host, then section 4 |
| Recovery time, database lost, backup available | 2 hours | restore (section 4), then let the indexer catch up |
| Recovery time, database and backup lost | the chain tables rebuild; the backup class is lost for good | section 5 |

The 24-hour point is a choice: shortening it is a schedule change, not a design change. Nothing here has been measured at production scale; the drill used three crosses.

## 3. Backups

Two layers; do both.

1. **Physical, daily, off the host.** From the host: `sudo docker compose exec -T db pg_dump -U oc -Fc oc > oc-$(date +%F).dump`, then copy it to object storage with credentials that cannot delete (a write-only key or a bucket with object lock). The restore is `pg_restore` into a fresh `postgres:17`. This repository does not schedule it: it needs a bucket and a credential (HUMAN_TASKS H36).
2. **Logical, checkable anywhere.** `logicalBackup(db, dir)` from `@opening-cross/indexer` writes each backup-class table as one JSON line per row with a manifest holding each table's row count and sha-256. It needs nothing but the database connection, and it can verify itself: `logicalRestore` refuses a backup whose files do not match their recorded digests, and refuses a target that is not empty. Use it for the weekly restore test in section 6, and for moving data between hosts.

Keys are not in the database and are not in any backup here. They are in `deploy/.secrets` on the host and in the operator's own safekeeping (section 7).

## 4. Restore, database lost, backup available

1. New host: `sh deploy/ship.sh <user>@<host> <ssh-key>` (installs Docker, copies the code and secrets, starts the stack). The `migrate` service creates the schema.
2. Stop the services that write while you restore: `sudo docker compose stop indexer api keeper promiser premium`.
3. Tables that a service creates for itself on first use (`gate_allowlists`, the alert tables, `issuer_records`, `cross_comments`, `sponsor_ledger`, `support_requests`) do not exist yet. Start the API once so it creates them, then stop it again.
4. Restore. Physical: `pg_restore -U oc -d oc --clean --if-exists oc-<date>.dump` inside the `db` container. Logical: `logicalRestore(db, dir)`; it lists any table it skipped.
5. Start everything. The indexer resumes from its cursors if they were restored, or from the beginning if not; both are correct.
6. Check, in this order: `GET /v1/health` (`ok: true`, indexer seconds-since-caught-up small), `GET /v1/stats` against the figures you noted before, then `GET /v1/accuracy` (the signed-promise record is the data most worth checking).

## 5. Database and backup both lost

The chain tables rebuild: `services/indexer` run from an empty database reads every transaction of the programs again. That can take long on a rate-limited RPC (see H26: use a dedicated endpoint). The backup class does not rebuild: signed promises, referrals and the rest of the list in section 1 are gone, and the product must say so. `promise_grades` can be recomputed only for promises that survive. Billing payments can be re-read from the revenue wallet's token history (transactions with an `oc-sub:1:<plan>` memo); no tool does that automatically yet.

## 6. Drills

| Drill | Command | Last result |
|---|---|---|
| Table classification is complete | `pnpm --filter @opening-cross/indexer test` | 6 tests passed, including classification of every table defined in `services/` and `packages/` |
| Backup then restore equals the source | the same test, and `scripts/dr-drill.ts` step 2 | every table of the restored database equal to the source by row count and sha-256, including a number beyond 2^53, an 18-digit numeric, text with quotes and commas |
| Rebuild from the chain alone equals the source | `DATABASE_URL=... pnpm --filter @opening-cross/indexer exec tsx scripts/dr-drill.ts` | 2026-10-13: three finished devnet crosses (11 orders, 31 events) rebuilt from nothing; `events`, `crosses`, `orders` and `cursors` identical by digest to the first ingestion |
| The rebuild agrees with the deployed API | same script, step 4 | state, clearing price, matched volume and every order's status and fill agree for all three crosses |

Evidence: `docs/evidence/W2A-R15-dr.md`. **Run the restore test on a schedule** (weekly) against the real backup; a backup that has never been restored is a hope.

## 7. Keys

| Key | What it can do | If lost | If stolen |
|---|---|---|---|
| program upgrade authority | replace a program | the program can never be upgraded again | the attacker can replace the program: the monitor (`program-integrity`) raises a critical finding and, when armed, pauses new crosses and orders |
| admin (protocol) | set fees, change the guardian, propose a new admin | `propose_admin` / `accept_admin` need the current admin; with it gone, fees and guardian are frozen | can change fees (bounded by the program) and guardian |
| guardian | pause new crosses and orders only | the admin sets a new one (`set_guardian`) | can pause and nothing else; claims and refunds are never blocked |
| keeper | pays fees to settle crosses; no authority over funds | create another and put it in `deploy/.secrets/keeper.json` | can only spend its own SOL |
| promiser | signs promises | promises already signed stay valid; a new key signs new ones and is published at `/v1/promises/signer` | can sign false promises: rotate and publish the change |
| attestation, billing signer | sign documents, hold no funds | generate a new one and publish it | can sign false documents: rotate and publish |

Rotation of every key is a manual step and is not rehearsed here. A key ceremony (generation, sharing and storage of the upgrade authority and admin keys on hardware or a multisig) is the founder's (HUMAN_TASKS H36).

## 8. Not covered

Multiple regions or hosts: one host, one database. A drill of the full program history from the first signature (the drill rebuilt three crosses). A drill of a full-host loss from a physical dump (no `pg_dump` exists on the development machine and Docker was not running; the physical commands above are the standard ones and were **not run**). Restoring the alert subscriptions' external state (Telegram link codes expire). An on-call process.
