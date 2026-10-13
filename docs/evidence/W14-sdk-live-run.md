# W14, L3 — client, React kit and CLI run for real against devnet (2026-10-13)

Scope: `@opening-cross/client`, `@opening-cross/react` and `@opening-cross/cli` installed the way a stranger would
(packed tarballs into an empty project, no workspace links), then the README commands and snippets executed literally
against the live API `https://98-87-59-136.sslip.io` and Solana devnet (`https://api.devnet.solana.com`). Nothing was
published to a registry. The devnet key `.keys/opening-bell-devnet.json` was read only by the CLI's `--keypair` and by
local scripts; it was never printed. Spend: NOT VERIFIED against the 0.3 SOL limit. The wallet was in use by another job during the run (its balance
went from 2.87 to 2.28 SOL, which includes that job), so this run's share cannot be read from the balance. What was
created: five mints and five crosses with their shards. Every cross was settled and finalized afterwards (by the keeper
code itself, see below), which returns the book and shard rent; the mint accounts keep about 0.005 SOL of rent.

## How it was installed

```
for p in cross-core-client cross-gate-client verifier sdk client react cli; do (cd packages/$p && pnpm run build && pnpm pack --pack-destination <dir>); done
mkdir stranger && cd stranger && npm init -y
npm install <dir>/*.tgz react@19.3.0 react-dom@19.3.0 @solana/kit@8.4.0 tsx typescript@7.0.2 @types/node @types/react
```

Result: installs, `opening-cross` appears in `node_modules/.bin`. One warning a stranger sees: `@solana-program/token@0.16.0`
declares `engines.node >=24` while every package of ours declares `>=22` (EBADENGINE; nothing failed on Node 22.17).
Not changed: it is the vendor's constraint; the READMEs still say Node 22 or later.

## CLI, against the live API and devnet

| Command (literal from the README) | Result |
| --- | --- |
| `opening-cross --help` | full command list, options, exit codes; exit 0 |
| `opening-cross cross list` (`OPENING_CROSS_API` set) | table of indexed crosses; exit 0 |
| `cross get <finalized cross> --cluster devnet` | state, grid, window, fees, clearing; exit 0 |
| `cross get <cross> --verify` | **first run: exit 1, "API and cluster differ: fairness: API says {...}, cluster says undefined" (defect 1, below). After the fix: "API and cluster agree on every field.", exit 0** |
| `cross book <cross>`, `cross proof <cross>`, `verify <cross>` | book printed; `VERIFIED: a second implementation of the clearing rule reproduces the on-chain result exactly`; exit 0 |
| `create --file launch.json --dry-run` | **first run: exit 1, transactions 2 and 3 "would fail" (defect 2). After the fix: tx 1 "would succeed", 2 and 3 "cannot be checked yet", exit 0** |
| `create --file launch.json` (escrow, open book, 11 ticks, 2 shards, +4m) | 3 transactions landed; cross `2v3baDFeSceF43pgN5ebBESjQvEwF7kHBMnQUp4pGUvd` Live |
| `order place <cross> --side sell --price 1.2 --quantity 10` (+ `--dry-run` first) | dry run "would succeed (21484 compute units)", then sent and confirmed: `order status: open, revealed; the cross now has 1 orders` |
| `order place <cross> --side buy --price 1.3 --quantity 6` | placed; 2 orders |
| `settle`, `order claim --nonce n` x2, `finalize`, `verify` | cleared at 1.2, 6 base tokens traded (sell side rationed); both claims confirmed; finalized; verify: VERIFIED. Claim signatures `3sYJrVQ1…`, `2m8p2ikV…` |
| `init-shards <cross>` on a cross whose third create transaction expired | "Shards created." then, repeated, `error: every shard of this cross already exists`, exit 1 |
| `quote <cross> --side buy --quantity 5` (live API) | `This deployment does not offer best-execution quotes.` exit 4 (the live deployment predates the route) |
| `quote ...  --api http://127.0.0.1:18080` (this change's API) | `recommendation none` with both reasons as caveats; exit 0 |
| junk: `cross get notanaddress`, `--price 1.23` off-grid, signing command with no key, `verify` on the wrong cluster | exit 2 with the sentence "Prices move in steps of 0.05. Try 1.2 or 1.25." etc.; exit 2 for a cross that does not exist on that cluster; nothing sent |

## Client library, README snippet run literally

The "Validate what a person typed…" block of `packages/client/README.md`, with the live API, devnet RPC and
`loadKeypairSigner(process.env.KEYPAIR!)`, `nonce: 1n`, buy 10 at 1.25 on cross `87WNzBiuyp9SV9Cg5NFGcgo6z2pdd3qqKAGjZnX3xy63`:
`previewOrder(...).lines` printed five lines (escrow 12.5 quote, most you can pay 12.5, fees none, not-printing
refund, how to get money back), then `signSendConfirm` returned signature `3MBS4kqRmeJ2iDrbjCkdm5XTFK4AhLgFUoD3SoUKw88ubesB9KkiypExW9JVtcqyweTnmihwc9rvEWJuk3nbifJk`.
`tsc --strict --moduleResolution bundler` on the snippet: no errors.

## React kit, README tree mounted in jsdom against the live API and devnet

`OpeningCrossProvider` (apiUrl, rpcUrl, a wallet backed by the same key) around `useCross(address, { verify: 'both' })`,
`useBook`, `CrossStatus`, `OrderTicket`, `OrderList`, `BookDepth`, `FairnessReceipt`, real `fetch` and WebSocket, no mocks.
Observed text: "Checked against the chain: every field matches." (verification `verified`); live order count and book
level from the chain; typed price 1.3 and 5 tokens into `OrderTicket` (React-controlled inputs, native setter plus
`input`/`change` events), clicked "Place order": "Place order: done. Order placed. Nonce …" and the order count rose;
`OrderList` ("Your orders") listed both orders ("buy / in the book / Cancel order") once the index had them, within 40 s.
Not exercised: the CSS (`styles.css` is shipped but jsdom does not lay out), wallet-standard adapters, sealed bids,
`useFairnessProof` and `useBestExecution` on a live cross.

## Keeper with a paused mint (task Y5 part c), on devnet

A Token-2022 mint with the Pausable extension, paused, was created on devnet (`6tKyRVQ7…`), and two crosses sold it.
Pass over the cross that was still Live after its reveal window, real RPC, real `mintHaltCheck`:

```
{"pass":1,"attemptedTransactions":0,"done":0,"failed":0,"skipped":[{"cross":"9ck4xvwGdxLDKJXxVHhscMiYPzNBc5s6PDZpmpX14nk6","code":"MINT_PAUSED","reason":"settlement is withheld while the base mint 6tKyRVQ7… cannot move right now: The issuer has paused all transfers of this token."}]}
{"pass":2,"attemptedTransactions":0,"done":0,"failed":0,"skipped":[ same ]}   cross state afterwards: Live
```

For the other cross (settled by hand, no print, only a quote-side buyer) the same keeper claimed and finalized
(`done: 2`) although the base mint was paused: the program moves no base tokens for that order, so nothing was refused
and nothing was withheld. That is the intended behaviour: only a print (settle) is withheld while a mint is halted;
claims and finalize are tried, and are remembered as held only if the chain refuses them.

## Defects found and fixed

1. `compareCross` (client; used by CLI `cross get --verify`, `watch`, and React `useCross({ verify })`) compared every key of
   the API's answer, including `fairness`, which the API adds from the index and a chain read cannot supply. Every
   finalized cross reported a mismatch (CLI exit 1; React `verification: 'mismatch'`). Now `fairness` and the new `safety`
   field are API-only and not compared. Tests: `packages/client/test/chain-compare.test.ts`.
2. `create --dry-run` (CLI) and `dryRun` (client) reported the shard transactions of a new cross as "would fail" (the
   simulation cannot chain, so the cross account they need does not exist yet) and exited 1 for a create that works.
   `DryRunResult.inconclusive` now marks a later transaction that fails only with Anchor 3012 or `AccountNotFound`;
   the CLI says "cannot be checked yet" and exits 0 when nothing else is wrong. Tests: `packages/client/test/dry-run.test.ts`.
3. `create` stopping part-way (a shard transaction expired on devnet) did not say which cross had been made, so
   `init-shards` could not be run. The error now names the cross and the command to finish it. Verified by recovering the
   real orphan with `init-shards` (address recovered from the chain by hand before the change). No automated test: the
   CLI test harness cannot make a send fail part-way.
4. The client's `routeQuote`, the CLI `quote` command and the React `useBestExecution` hook call `POST /v1/route/quote`,
   which the API did not serve, so all three were permanently "unavailable". The API now serves it (see
   `Y5-safety-router-replay-api.md`).

## Clean-up pass

All five crosses ended Finalized. The last three were finished by the keeper package against real discovery
(`fromProgramAccounts`, no database): `done: settle, claim, claim, finalize, settle, claim, claim, finalize, finalize`,
`failed: []`; two further passes did nothing.

## Not covered

Registry install (no registry; H12). Node 24. A browser, Wallet Standard wallets and the CSS. Sealed-bid flows through
the three packages (vault file, reveal). `order cancel`, `order reveal`, `watch`. Mainnet. The cross-language parity
test against a Rust SDK (dropped earlier because that crate is not in the repository). The live deployment still runs
the old API (no deploy was made), so `quote`, safety, router and replay were exercised on a local API against the same
devnet and the same chain data; the CLI's "Waiting for your wallet…" status line is printed for keypair files too
(cosmetic, not changed).
