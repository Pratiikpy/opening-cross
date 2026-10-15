# @opening-cross/cleanverse

Typed client of the Cleanverse cooperate API (reference v5.6): A-Pass generation and status, A-Pass queries (single, list, verify), the supported-token list, the institution faucet, and the validator compliance reads (`is_register`, `rules`, `verify`, `is_paused`).

```ts
import { CleanverseClient, SANDBOX_URL, loadCredentials } from '@opening-cross/cleanverse';

const creds = loadCredentials(); // environment, or ~/cleanverse/.secrets/cleanverse.env
const client = new CleanverseClient(creds.config!);
const pass = await client.queryApass('solana', walletAddress);
// { tier: 3, status: 1, expirationTime: 1863690034, countries: ['IN'], ... }
```

What the client guarantees

- `api-id` on every request; the api-key only ever encrypts (AES/CBC/PKCS5Padding, zero IV) and is never sent.
- HTTP 400, 403, 404, 409 and 5xx, and envelope codes `0001`, `0002`, `1000`, `12026`, `12027`, are distinct error classes (`src/errors.ts`). An unknown code is an error.
- Only 5xx, timeouts and dropped connections are retried; a write is attempted once unless `retryWrites` is set.
- Every response is validated field by field; a malformed body is `MalformedResponseError`, never a default.
- Alpha-2 to ISO 3166-1 numeric country mapping for the 194 codes of the reference appendix.

Sandbox smoke run: `pnpm --filter @opening-cross/cleanverse sandbox:smoke` (exits 2 without credentials). Design notes and what is still unverified against the real sandbox: `docs/adr/0901-cleanverse-integration.md`.

Tests: `pnpm --filter @opening-cross/cleanverse test` (AES vectors from OpenSSL; the HTTP contract against a local server in `test/stub-server.ts`, a test double that is not shipped).
