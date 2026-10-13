# ADR-0309: Agent identity is read from the Metaplex Agent Registry, and recognises only agents that trade from their own wallet

Status: accepted (2026-10-13) · Row J5 · Code `packages/agent-identity`, `services/api/src/routes/agents.ts` · Evidence `W2A-J5-agents.md`

## Decision

1. **An agent is an MPL Core asset with an identity record in the registry** (`1DREGFgy...`, 40 bytes at `["agent_identity", asset]`). Verification checks that the record exists, is owned by the registry, names the asset, and that the asset is a Core asset.
2. **Its wallet is the Asset Signer PDA** (`["mpl-core-execute", asset]` under MPL Core): no private key exists. A bidder is recognised as an agent only if its wallet is such a PDA of a registered agent. The directory lists every identity (`getProgramAccounts`) and maps each wallet to its asset; it is cached for ten minutes and an old copy is served if a reload fails.
3. **The seeds were read from Metaplex's documentation and the published `mpl-core` source and then checked against the chain**: 50 of 50 sampled identity PDAs equal the accounts the registry holds; 8 of 68 derived wallets are real funded accounts.
4. **The policy is allow, deny, or a limit on agents' share of known volume**, checked after the fact. A share limit is not reported as met while some volume is unrevealed.
5. **Registration is not endorsement.** Any wallet can register an asset; the registration document at the URI is third-party text and is returned as data.

## Alternatives rejected

- Treating a bidder as an agent because it says so: no proof.
- Requiring a DAS-enabled RPC: not available without a paid account; the registry is small enough to list directly.

## Consequences

Enforcement at order time needs a gate pass issued by an attester that applies the same check (HUMAN_TASKS). An agent that bids from an ordinary wallet is not seen.
