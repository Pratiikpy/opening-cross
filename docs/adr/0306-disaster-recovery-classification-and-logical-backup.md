# ADR-0306: Every table is classified, and a backup is proven by restoring it

Status: accepted (2026-10-13) · Row R15 · Code `services/indexer/src/dr.ts` · Runbook `docs/runbooks/DISASTER_RECOVERY.md` · Evidence `W2A-R15-dr.md`

## Decision

1. **Every table is one of chain, derived, cache or backup**, in code (`TABLE_CLASS`). A test scans every `CREATE TABLE` in services and packages and fails on an unclassified table or a classified table that exists nowhere. A new table cannot fall outside the backup unnoticed.
2. **Funds are never in the database.** The chain tables rebuild from the chain; the backup class (signed promises, referrals, registrations, integrity documents, the audit log, billing, alert subscriptions and the rest) is what is lost without a backup.
3. **The logical backup is one JSON line per row, as the database serialises it**, with a manifest of row counts and sha-256 digests. Restore verifies every file before writing, refuses a non-empty target, loads parents before children inside one transaction, and resets serial sequences. Two databases are equal when their per-table digests are.
4. **A backup is not trusted until restored.** A drill rebuilds a database from the chain alone and restores a backup into an empty one, and compares both with the source and with the deployed API.
5. **Recovery objectives are targets** (24 hours of backup-class data, 30 minutes with an intact database, 2 hours from a backup) and the runbook says they are not measurements.

## Alternatives rejected

- Backing up everything: re-running the indexer is cheaper and a rebuild is itself the integrity check.
- Relying on `pg_dump` alone: it cannot be verified without the database engine's tools on the machine that checks it; it is also done, as the physical layer.

## Consequences

The physical backup schedule, off-host storage and the key ceremonies are HUMAN. Multi-region is not built.
