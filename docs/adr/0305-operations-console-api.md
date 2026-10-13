# ADR-0305: The operations console is token-authenticated, two-person for listings, and hash-chained

Status: accepted (2026-10-13) · Row R11 · Code `services/ops` · Evidence `W2A-R11-ops-console.md`

## Decision

1. **Fail closed.** With no tokens configured every request is refused, with a message saying so. A token is a long random string; the server holds only its sha-256 and compares all entries in constant time. Three roles: viewer, reviewer, admin.
2. **Listing decisions need a second person.** The reviewer who opens a review cannot decide it. A reason of at least ten characters is required. An approval on evidence that could not be gathered needs an explicit flag, and the acknowledgement is recorded.
3. **Every action is one entry in a hash chain**, written in the same transaction as the change it records (both commit or neither). Each entry's hash covers the previous entry's hash and its own content; `verify` finds the first edited or removed entry; the head can be signed by an operator key and a broken chain is never signed.
4. **The log records that a case note was added, not what it said.** Notes stay in the case, which holds personal data.
5. **The monitor's webhook is authenticated by a secret in its path** (the monitor sends no headers). It opens an incident for a pause (by the monitor or someone else), a failed pause and a critical finding that persisted; warnings and first-pass criticals do not. An open incident with the same key is not opened twice.
6. **Notes are append-only; a closed case or a decided review cannot be changed**, only superseded by a new one.

## Alternatives rejected

- Shared admin password or one API key: no names in the log.
- Letting the opener decide: a listing queue with one person in it is a rubber stamp.
- A bare append-only table without hashes: cannot show tampering.

## Consequences

The chain does not stop the database owner, who holds the signing key, from re-signing a rewritten chain; a signed head must be copied somewhere the operator cannot quietly change. The log is in the backup class (ADR-0306), and restoring it resets the serial sequence.
