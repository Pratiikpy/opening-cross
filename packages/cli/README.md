# @opening-cross/cli

`opening-cross`: read, trade and verify [Opening Cross](https://github.com/Pratiikpy/opening-cross) auctions from a terminal. It builds
transactions on your machine from chain state, signs them with a keypair file you name, sends and confirms them, and prints the signatures and
the resulting state. It never generates, stores or prints a key.

```
npm install -g @opening-cross/cli
opening-cross --help
opening-cross cross get <cross> --cluster devnet
opening-cross order place <cross> --side buy --price 1.25 --quantity 100 --keypair ~/.config/solana/id.json
opening-cross order place <cross> --side buy --price 1.25 --quantity 100 --keypair id.json --dry-run
opening-cross settle <cross> --keypair id.json
opening-cross verify <cross>
```

## Commands

| Command | Does |
| --- | --- |
| `cross list` | crosses the API has indexed (needs `--api`) |
| `cross get <cross> [--verify]` | one cross, read from the cluster; `--verify` also reports every field on which the API differs |
| `cross book <cross>` | the resting book and the price it would clear at now |
| `cross proof <cross>` / `verify <cross>` | recompute a cleared cross from its on-chain book; exit 0 only if it equals the recorded result |
| `order place <cross>` | place a buy or sell order; sealed crosses keep the salt in the vault file before anything is sent |
| `order cancel <cross> --nonce n` | withdraw while the cross is open |
| `order reveal <cross> --nonce n` | reveal a sealed order with the vault's salt |
| `order claim <cross> --nonce n [--owner a]` | collect a fill and refund; anyone may claim for anyone |
| `order list [--owner a]` | a wallet's orders as indexed (needs `--api`) |
| `settle`, `finalize`, `init-shards <cross>` | settle after the call, pay fees and proceeds, finish a half-created cross |
| `create --file launch.json` | open a cross from a file validated against `schemas/create-cross.schema.json` |
| `quote <cross> --side --quantity` | compare with the best DEX route when the deployment offers the router |
| `watch <cross>` | follow a cross (the API's event stream, otherwise the chain polled) |

## Options for every command

`--cluster localnet|devnet|mainnet-beta` (default devnet; `OPENING_CROSS_CLUSTER`), `--rpc url` (`OPENING_CROSS_RPC`), `--api url`
(`OPENING_CROSS_API`), `--json` (one JSON document on stdout; errors as JSON on stderr). Commands that sign also take `--keypair file`
(`OPENING_CROSS_KEYPAIR`, or `OPENING_CROSS_SECRET_KEY` holding the 64-byte JSON array), `--dry-run` (simulate against the cluster; sign nothing,
send nothing, write nothing), `--build local|api` and `--vault file` (sealed-bid salts; `OPENING_CROSS_VAULT`).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | the command ran and the answer is no: a proof did not verify, a transaction failed, a simulation would fail |
| 2 | bad command, flag or input (bad address, off-grid price, junk JSON, missing key file); nothing was sent |
| 3 | the network or the API could not be reached or was too busy; a send that timed out names the signature to check |
| 4 | the deployment does not offer what was asked (for example best-execution quotes) |

## The create file

See `schemas/create-cross.schema.json`. Prices are quote tokens per base token and amounts are base tokens unless `"units": "atoms"`; times are unix
seconds, ISO 8601, `now` or `+10m`.

```json
{
  "baseMint": "<mint>", "quoteMint": "<mint>",
  "supplyMode": "escrow", "disclosure": "open",
  "grid": { "min": "1", "tick": "0.05", "ticks": 11 },
  "window": { "close": "+10m" },
  "shards": 2, "maxOrders": 100
}
```

## Sealed bids

The salt that opens a sealed bid is kept in the vault file (`~/.opening-cross/sealed-bids-<cluster>.json`, mode 0600), in the same format as the
Opening Bell web app's backup. Lose it and the bid cannot be revealed (it is refunded in full at settlement).

Apache-2.0.
