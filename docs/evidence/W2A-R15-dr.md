# W2A-R15: disaster recovery

Date: 2026-10-13. Runbook: `docs/runbooks/DISASTER_RECOVERY.md`. Code: `services/indexer/src/dr.ts` (classification, logical backup and restore, digests), `services/indexer/scripts/dr-drill.ts`. Tests: `services/indexer/test/dr.test.ts` (6, against Postgres 18). Decision: ADR-0306.

## What was built

Every table is classified as chain (rebuilt by re-running the indexer), derived, cache or backup (held nowhere else); a test scans every migration and every service and package for `CREATE TABLE` and fails when a table is not classified or a classified table exists nowhere, so a new table cannot silently fall outside the backup. `logicalBackup` writes each backup-class table as one JSON line per row (as the database itself serialises it, so a bigint or an 18-digit numeric keeps every digit) with a manifest of row counts and sha-256 digests; `logicalRestore` refuses a backup whose files do not match their digests, refuses a target that is not empty, loads in foreign-key order inside one transaction (a failure part-way rolls back everything), and resets serial sequences afterwards; `tableDigests` proves two databases hold equal rows.

## Tests

Restore equals source on every backed-up table by digest, with a number above 2^53, an 18-digit numeric, text with quotes and commas, a text array and an accented letter; a serial column keeps counting after a restore (this caught a real defect: the restored `ops_log` would have collided on the next insert); a damaged file is refused before anything is written; a part-way failure leaves nothing behind; a tampered row changes the digest.

## The drill, on real data (2026-10-13)

`dr-drill.ts` against devnet: three finished crosses (11 orders, 31 events) read into a database with the indexer's own ingestion; (1) a backup of every table, restored into an empty database: every table equal by row count and sha-256 (30 tables, 48 rows); (2) a database rebuilt from the chain alone, from nothing: `events`, `crosses`, `orders` and `cursors` identical by digest to the first; (3) the rebuilt database against the deployed API: state, clearing price and matched volume agree for all three crosses, and all 11 orders' status and fill agree. Nine checks, all true. A first run failed on `cursors` only because the two ingestions used different source names; the drill now uses one.

## Not covered

The physical backup (`pg_dump`) and its off-host copy: no `pg_dump` exists on this machine and Docker was not running, so the commands in the runbook are the standard ones and were **not run**; the object-storage bucket and credential are HUMAN. The drill rebuilt three crosses, not the full history of the programs from the first signature (a public RPC rate limits that; a dedicated endpoint, H26, makes it practical). Multi-region and key ceremonies are not built (HUMAN). Recovery times in the runbook are targets, not measurements. The restore was exercised on a database with the Windows default encoding (WIN1252); production Postgres is UTF-8, and the test data avoids characters outside both.
