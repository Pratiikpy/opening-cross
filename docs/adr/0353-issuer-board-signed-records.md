# ADR-0353: The issuer board stores wallet-signed public records

Status: accepted (2026-10-13)

## Context

Several issuer features need to remember something that is not on chain: a draft listing and the interest in it (A3, S13), an application and a reviewer's decision (A2, R7), and holders' questions and the owner's answers (A10, E5). Moving funds is not involved. What matters is that a record is attributable to a wallet, cannot be forged or altered, and is honest about what it proves.

## Decision

- One table, `issuer_records`, created on first use like the gate allowlist table (`routes/gate.ts`), in the API's database. A record is immutable. Six kinds: `draft`, `softcommit`, `application`, `decision`, `question`, `answer`.
- The protocol is the treasury update's (ADR-0014, `routes/treasury-updates.ts`). The API validates and timestamps a body (`prepare`) and returns the record, its id (the sha-256 of its RFC 8785 canonical form) and a message: `opening-cross/issuer-record/v1`, a newline, the id. The wallet signs that message (the Wallet Standard `solana:signMessage`). `POST /v1/issuer/records` re-validates the body, recomputes the id, verifies the Ed25519 signature against the signer's address, and checks the record's time is within ten minutes of the server's clock. The browser never computes the id.
- Rules by kind, enforced on the server: a body has exactly the fields of its kind and no others; a soft commit's price must lie on its draft's grid and its amount must buy at least one atom; only the creator of a cross, or the authority of a treasury, can answer a question about it; only a wallet named in `ISSUER_CURATORS` can record a decision; a wallet's later soft commit on a draft replaces its earlier one; a wallet may add 30 records an hour.
- Everything is public and the pages say so before an issuer writes anything. A signature proves a wallet said exactly this. It does not prove the content is true, who the wallet's owner is, or that anyone verified anything. A soft commit is shown as interest, never as a bid, and no funds move.
- What is not collected: the demand map does not say where wallets are. The service holds no location data and will not infer one. The only characterisation of a committer is its track record on this network, read from the indexer's `orders` table (bid before, filled before, none).
- The question clock (seven days to overdue) is this board's convention, like the disclosure clock, and the pages say it is not enforced by a program.

## Consequences

- With no curators configured, applications are stored and public but cannot be decided, and the page says so. Naming reviewers is a human step (HUMAN_TASKS).
- The table is created by the API at runtime; the API's database role needs permission to create it.
- Records cannot be deleted. A mistaken draft is superseded by a new one.
