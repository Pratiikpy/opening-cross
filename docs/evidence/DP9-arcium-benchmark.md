# DP9: Arcium 1,000-bid benchmark — BLOCKED on devnet funds and an RPC key

Status 2026-10-11: **the benchmark was not run.** Nothing below is a measurement of Arcium. This file records what was tried, what works now, and the exact step that is missing. There is no cost, latency or failure-rate figure, and none should be quoted.

## What was attempted

| # | Attempt | Result |
|---|---|---|
| 1 | The vendor's one-line installer (`curl … https://install.arcium.com/ \| bash`, script read first) in WSL | Stopped by its own dependency check: it runs `sudo apt-get install pkg-config build-essential libudev-dev libssl-dev` and the WSL user has no passwordless sudo. Nothing installed. |
| 2 | The documented manual path: `arcup 0.15.0` from `bin.arcium.com`, then `arcup install` | **Works.** `arcium 0.15.0` is installed in WSL (`~/.cargo/bin/arcium`), the `arcium/arx-node` and `arcium/trusted-dealer` v0.15.0 images are pulled, and `arcium deploy` and `arcium init-mxe` print their help, and the top-level help lists `arcium test` with `-c/--cluster` for devnet. 0.15.0 matches the pin in ADR-0001. |
| 3 | Sizing the run from the vendor's deployment guide and the CLI help | The devnet cluster offset is **456** and the recovery set size must be at least **4**. A deploy needs "around 2-5 SOL" for program deployment and account initialisation, and the guide says the public Solana RPC drops deployment transactions and a Helius, Triton or QuickNode endpoint should be used. The operations key holds about 4.7 SOL, which the other devnet proofs also draw on, and the public faucet answers every request with HTTP 429 (tested three times on 2026-10-11, once with a fresh address). The run therefore exceeds the 1 SOL allowed for it, and the only RPC available is the one the guide says not to use. |

## What is not done, and why that is the honest state

- **The circuit.** A 1,000-bid benchmark needs an Arcis circuit that adds an encrypted bid to an encrypted tick histogram and a second that reveals only the aggregate curve and P\*. It would be modelled on `research/repos/examples/sealed_bid_auction` (which keeps encrypted running state and reveals only the winner and price). It has not been written: an unbuilt, untested circuit would be a stub, and `arcium build` compiles Arcis and an Anchor program on top of a Rust toolchain, a heavy build that was held back while another job was using the same machine.
- **The measurement.** Cost per bid is the Solana fee plus the cluster's computation fee per queued computation; latency is queue to callback; failure rate is computations that abort or expire. All three need real computations on cluster 456.

## What unblocks it (HUMAN_TASKS H17)

1. At least 6 SOL on devnet for the MXE deploy and 1,000 queued computations, and a Helius, Triton or QuickNode devnet RPC URL (saved in `.secrets/`).
2. Then, in order: write the two circuits against the example's layout; `arcium build`; `arcium test` on localnet (Docker) to fix correctness and get a first latency figure; `arcium deploy --cluster-offset 456 --recovery-set-size 4 --keypair-path <operations key> --rpc-url <devnet RPC>`; run 1,000 bids with the client; record cost, latency distribution, failure rate, and check that only the aggregate curve and P\* are readable.

## Consequence for the product

PLAN limits Arcium to crosses of about 1,000 bids and names commit-reveal with an encrypted default reveal as the path for larger ones, and ADR-0005 lists Arcium sealed bids (DP9) as deliberately later. Until this benchmark exists, the "up to 1,000 bids" figure is the vendor-example scale, **NOT VERIFIED** for this circuit, and sealed bids in the product are the commit-reveal implementation in `cross_core` (run on the real program to 100,000 orders in DP13).
