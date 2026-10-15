# ADR-0802: One event log and eighteen projection tables for the seven programs

Status: accepted (2026-10-15).

## Decision

Migration 019 adds `program_events` (every Anchor event of the seven programs, decoded from the IDLs, with `subject` and `cross_address`) and one projection table per account family. The indexer follows each program under its own cursor (`rpc:<program id>`), attributes events by invoke stack so a CPI is not credited to its caller, and tolerates absence: on a cluster without a program its tables stay empty and the reconciler, which reads crosses only, is unaffected. `WAVE3D_PROGRAMS` picks the programs (default all, `none` off). All tables are classified `chain` in the disaster-recovery table, so a rebuild from the cluster restores them.

The event codecs are generated from `idls/*.json` by a script, not written by hand, so an IDL change cannot silently drift.
