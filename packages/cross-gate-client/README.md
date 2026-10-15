# @opening-cross/cross-gate-client

Generated `@solana/kit` client for `cross_gate` plus hand-written helpers: eligibility passes for gated crosses (allowlist, Solana Attestation Service, Merkle allowlist) and compliance rules (ADR-0900).

```sh
npm install @opening-cross/cross-gate-client
```

> Not on the npm registry yet: the `opening-cross` scope is waiting on a registry account (`docs/HUMAN_TASKS.md`, H12). Until then use the package from a clone of the repository, where `pnpm install` links it, or from the tarball `pnpm pack` produces; `examples/ts-quickstart` shows the tarball route.

```ts
import { buildRules, initRulesWithHook, preset, claimPassAttested, diagnoseEligibility } from '@opening-cross/cross-gate-client';

// Switch a gate to Regulation S rules (counsel supplies the exclusion list) and keep transfers working on a hooked mint.
const p = preset('reg-s', { restrictedCountries: ['KP'] });
await send(await initRulesWithHook({ payer, authority, mint, rules: buildRules({ ...p.rules, identity: { credential, schema } }) }));
// Why a wallet cannot hold a pass, from the same accounts the program reads.
const d = await diagnoseEligibility({ mint, wallet, now, read });
```

| Module | What it gives |
|---|---|
| `rules`, `conform`, `describe` | build and read a gate's rules; the program's country, tier and flag check; the rules in plain English |
| `claim` | builders for issuing, refreshing and ending passes, `blockWallet`, `openVolume`, `updateHookMetas` |
| `hook` | the transfer-hook accounts of a gate (`resolveHookAccounts`, `withHookAccounts`, `detectHookListVersion`) |
| `lock`, `presets` | resale locks and the jurisdiction templates (templates, not legal advice) |
| `diagnose` | eligibility diagnosis |
| `identity`, `countries`, `accounts`, `pdas` | the `oc-identity` v1 record, ISO country tables, decoders for accounts the IDL does not list, addresses |

Tests: `pnpm test` (unit tests, nothing built) and `pnpm test:svm` (LiteSVM against the compiled `target/deploy/cross_gate.so`, through the shared harness in `tests/core`; run it from WSL, where LiteSVM has a native binary). `pnpm vendor:web` refreshes the copy of this source the web app bundles (`apps/web/src/app/gates/_lib/gate-client`); a test fails when the copy is stale.

Requires Node 22 or later and `@solana/kit` 8. Part of [Opening Cross](https://github.com/Pratiikpy/opening-cross); licensed Apache-2.0.
