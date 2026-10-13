# @opening-cross/agent-identity

Verifies identities in the Metaplex Agent Registry (`1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p`, mainnet and devnet).

```ts
import { verifyAgent, cachedDirectory, checkAgentPolicy } from '@opening-cross/agent-identity';

const v = await verifyAgent(rpc, assetAddress);        // registered? which wallet is its own? the asset's name, owner and uri
const directory = cachedDirectory(rpc);                // every registered agent's wallet -> asset
const report = checkAgentPolicy({ mode: 'limit', maxShareBps: 2000 }, orders, await directory());
```

An agent is an MPL Core asset with a 40-byte identity record at `["agent_identity", asset]`; its wallet is the Asset Signer PDA at `["mpl-core-execute", asset]` under MPL Core. Both seed layouts were checked against the chain: on mainnet 50 of 50 sampled identity PDAs equal the registry's accounts, and 8 of the 68 registered agents' derived wallets are real funded accounts (`scripts/mainnet-check.ts`).

Registration is not endorsement, and an agent that bids from an ordinary wallet is not recognised. The policy (allow, deny, or a limit on agents' share of known volume) is checked after the fact. Evidence: `docs/evidence/W2A-J5-agents.md`; decision: `docs/adr/0309-agent-identity-from-the-agent-registry.md`.
