# W2A-J5: verifiable agent identity (Metaplex Agent Registry)

Date: 2026-10-14 (run 2026-10-13/14). Code: `packages/agent-identity` (12 tests), `services/api/src/routes/agents.ts` (4 tests over Postgres), `packages/agent-identity/scripts/mainnet-check.ts`. Decision: ADR-0309. `tsc` clean for both.

## What it does

Reads the Metaplex Agent Registry: program `1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p` (the same address on mainnet and devnet, per Metaplex's documentation). An agent is an MPL Core asset with a 40-byte identity record at `["agent_identity", asset]`; its wallet is the Asset Signer PDA at `["mpl-core-execute", asset]` under MPL Core (`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`), which has no private key and acts only through Core's Execute. `verifyAgent` checks that the identity exists, is owned by the registry, names this asset, and that the asset is a Core asset, and reports the wallet and the asset's own name, owner and URI (third-party text, returned as data). `loadDirectory` lists every identity and maps each Asset Signer wallet to its asset, so a bidder's wallet can be recognised as an agent. `checkAgentPolicy` compares a cross's bidders with an issuer's stated policy (allow; deny; limit to a share of known volume, to the basis point) and refuses to call a share limit met while some volume is still unrevealed.

## Seeds, checked three ways

The seed layouts were read from Metaplex's documentation and from the published `@metaplex-foundation/mpl-core` 1.10.0 source (`findAssetSignerPda`: `string('mpl-core-execute')` then the asset). They were then checked against the chain: on mainnet the registry holds **68** identity accounts; for 50 of 50 sampled the identity PDA derived from the stored asset equals the account the registry returned; 8 of the 68 derived Asset Signer wallets are real funded system accounts (for example `9SyvAbtw...`, 0.1 SOL), which a wrong seed would not produce. Two real (asset, identity, wallet) triples are pinned in the tests. Eight agents were verified end to end (registered, wallet derived, names such as "Deside Test Agent", "Bonzi", "SAID LABS"), and three things that are not agents (USDC's mint, the ops wallet, a PDA) were each refused with the reason.

## Not covered

The registry is proof of registration, not of honesty: any wallet can register an asset. An agent that bids from an ordinary wallet is not recognised. The policy is checked after the fact; refusing an order at placement needs a `cross_gate` pass from an attester that applies the same check (HUMAN_TASKS), and was not built. The `AgentIdentity` plugin on the Core asset (its lifecycle hooks) was not parsed; the check rests on the identity PDA and the asset account. Devnet has the registry program but a count of devnet identities was not taken. The directory reads every identity with `getProgramAccounts`, which works for 68 accounts on the public endpoint and would need an indexed source (DAS) if the registry grows large.
