# L4: verifiable builds and the mainnet deployment runbook

Status 2026-10-12: **IN PROGRESS (human-only remainder).** The build and hash tooling exists, was run, and reproduces the tested binaries from the commit; the mainnet deployment itself needs a funded deployer key, the multisig member keys and one decision from the founder (HUMAN_TASKS H18). Nothing has been deployed to mainnet.

## 1. What "the hash matches the repo" means here

A program on chain is the bytes of its ELF. Two checks are used and both are scripted:

- **Same bytes as a local build:** `scripts/onchain-hash.sh <program-id> <file.so> [rpc]` dumps the program, strips the zero padding the loader allocates, and compares SHA-256 with the file. Exit 0 only on identical bytes.
- **Same bytes as the source:** `scripts/verifiable-build.sh [--ref <git-ref>] [program…]` builds from a clean `git archive` of a commit inside the pinned Docker image (`solanafoundation/solana-verifiable-build:4.0.2`, Agave 4.0.2 as ADR-0001 pins) with `solana-verify build`, and writes `target/verifiable/hashes.txt` with the commit and each executable hash. Anyone with Docker repeats it and gets the same hash. Tooling: `solana-verify 0.5.2` (installed in WSL, flags read from its `--help`).

Two hash conventions appear below. `sha256sum` hashes the whole file. `solana-verify get-executable-hash` hashes the file with trailing zero padding removed, and is the value its on-chain verification record uses. Both are listed; do not compare across them.

## 2. Hashes of the current local builds (not verifiable builds)

Built with `cargo build-sbf` in WSL (Agave 4.0.2, platform-tools v1.53) from the working tree on 2026-10-11. These are the binaries the test suites ran against. They were not built in the pinned Docker image, but section 4 shows the image produces the same hashes; the files to deploy are still the ones from `scripts/verifiable-build.sh`.

| Program | Bytes | `sha256sum` | `solana-verify get-executable-hash` |
|---|---|---|---|
| cross_core | 573,096 | `9ad204bbda801d89b147aace47f409699d736f147f27a33e6e0eef57080b5e17` | `780d11058448ff54761cbd86bbd51540969269e9600ab49b95c319c38d6ba02d` |
| cross_gate | 364,032 | `44067144756195012c3a5938ce06c0c47164320d0b8c213dfe31ce6f7345cad8` | `b0183ec01a363dffd8135736734ff8e872a24328d83185ef64a36ef55bacb5a6` |
| cross_settle | 360,288 | `ed8bae6da940f8b8fcb28d9008c6af3692e400ed51c99573286278e35de533bb` | `4d2d7a60859ef98d9e0fd4fcd5b2042bfd33f4341e91a14257aa572f2e6907dc` |
| cross_calendar | 172,504 | `e055ea1c4fd1c53afac9bf2b1ca43173064822f839ac7bb4624df20108341801` | `cfd44af46a0d7f82505e2cfa20f8f0eae656899925ab2542566610ac7d042011` |
| treasury | 274,184 | `ce6b2b6174622a77d3767f8e5fe5542b1fac537e944cd169e53155a7317cee2c` | `856078195036afd1811d69c63aad0474b0d084e9e00ab94893c9fffeacf5d3f5` |

## 3. On-chain check, run on devnet

Re-run 2026-10-12 against commit `1249986` (all five programs deployed on devnet; the treasury has its second program id, `HoRbUkEX…`, after the first keypair was lost). `sh scripts/onchain-hash.sh <program-id> target/deploy/<name>.so devnet`:

| Program on devnet | Result |
|---|---|
| cross_core `F5k8EDDX…` | **MATCH.** The first 573,096 bytes of the 700,000-byte program equal the local build (sha256 `9ad204bb…`). `solana-verify get-program-hash -u devnet` gives `780d1105…`, equal to the local executable hash. |
| cross_gate `2pE7gApa…` | **MATCH.** First 364,032 of 374,304 bytes (sha256 `44067144…`). The earlier mismatch was a stale deployment; it has since been upgraded. |
| cross_settle `2EVpoks9…` | **MATCH.** 360,288 of 360,288 bytes (sha256 `ed8bae6d…`). |
| cross_calendar `CxtZKYwS…` | **MATCH.** 172,504 of 172,504 bytes (sha256 `e055ea1c…`). |
| treasury `HoRbUkEX…` | **MATCH.** 274,184 of 274,184 bytes (sha256 `ce6b2b61…`; executable hash `85607819…`, equal on chain and locally). |
| cross_settle `devnet-raydium` `4nH5srCT…` | Byte-for-byte match recorded in `A4-raydium-cpmm-devnet.md` (sha256 `4e617656…`). |

## 4. Verifiable build, run

`scripts/verifiable-build.sh` (all five programs, ref `HEAD` = commit `052ff2182dd063108b5f330af74a3aeea8287c30`, image `solanafoundation/solana-verifiable-build:4.0.2`, which reported its container toolchain as Rust 1.93.1) produced, for every program, an executable hash **identical to the hash of the local `cargo build-sbf` binary in section 2**:

| Program | Docker build, `get-executable-hash` | Equals section 2 |
|---|---|---|
| cross_core | `780d1105…ba02d` | yes |
| cross_gate | `b0183ec0…cb5a6` | yes |
| cross_settle | `4d2d7a60…907dc` | yes |
| cross_calendar | `cfd44af4…2011` | yes |
| treasury | `b6d57baa…a855` | yes |

The Docker run below predates the treasury's new program id (commit `ab80051`), so its treasury row is the hash of the old binary: **the treasury was not re-built in Docker at the current commit (NOT VERIFIED).** The other four rows are unaffected, since their sources did not change. So the tested binaries are the ones a stranger rebuilds from the commit, and devnet `cross_core` (section 3) is that same binary. Two things this does not show: a second machine reproducing the hash, and the repository's pinned host Rust 1.96.1 (the image builds with its own 1.93.1, and the SBF output was the same either way). Two defects found and fixed while getting here: `solana-verify build .` fails with a mangled manifest path, so the script passes the absolute mount path; and the container writes root-owned files, so the script removes its work directory from inside the container when a plain `rm` is refused.

## 5. Mainnet runbook, with caps

**Decision needed first (H18 item 3): the programs have no on-chain deposit cap.** `cross_core` limits orders per cross (`max_orders`) and the guardian can pause new crosses and orders (never claims or refunds), but anyone can create a cross, and no program limits the value escrowed in one. So a "cap" at launch can only be operational, and the safe operational form is:

1. The protocol is initialised **paused**, so nothing can be created until the admin unpauses it deliberately.
2. Only crosses created by our own issuer key are announced or linked from the app; the guardian key is held ready to pause.
3. Every cross is created with a small `max_orders` and a narrow price grid, and a small supply.
4. Raising any of that waits for the external audit (L2), per BUILD.md step 9.

Adding a program-level cap (for example a protocol-wide limit on escrow per cross) is the alternative; it changes `cross_core`, needs its own ADR and re-opens the audit scope. That choice is the founder's.

**Funding (computed with `solana rent` against mainnet-beta, 2026-10-11).** Rent-exempt minimum for the program data account of each binary at its exact size: cross_core 2.912 SOL, cross_gate 1.850, cross_settle 1.831, treasury 1.394, cross_calendar 0.877: **8.86 SOL** in total. Allocate 25% headroom for later upgrades (`--max-len`), which is about **11.1 SOL**. Each deploy also holds a buffer account of the same size until it finishes, so the peak while deploying the largest program is its buffer plus its data account (about 7.3 SOL for cross_core at +25%). Fund the deployer with **13 SOL**: 11.1 for the five programs, a margin for the buffer peak while the others are already locked, and fees.

**Steps** (all commands read from `solana program deploy --help` and `solana program set-upgrade-authority --help`, Agave 4.0.2):

1. Freeze a release commit. Run `scripts/verifiable-build.sh --ref <commit>` and keep `target/verifiable/hashes.txt`. Deploy **only** the files in `target/verifiable/`.
2. Create the deployer key offline-first, fund it with 13 SOL (H18), and put the three Squads member addresses in hand (H13).
3. For each program, largest first: `solana program deploy target/verifiable/<name>.so --program-id .keys/<name>-program.json --max-len <size × 1.25> --keypair <deployer> --upgrade-authority <deployer> -u <mainnet RPC> --use-rpc`. The program IDs are the `declare_id!` values already in the source (cross_core `F5k8EDDX…`, cross_gate `2pE7gApa…`, cross_settle `2EVpoks9…`, cross_calendar `CxtZKYwS…`, treasury `sPL9nYpG…`); the matching program keypairs are in `.keys/` and must be moved to the deployer's machine, never committed.
4. Check each deploy: `scripts/onchain-hash.sh <program-id> target/verifiable/<name>.so <mainnet RPC>` must print MATCH, and `solana-verify get-program-hash` must equal the hash in `hashes.txt`.
5. Initialise the protocol **paused**: `RPC_URL=<mainnet RPC> KEYPAIR=<deployer> GUARDIAN=<guardian address> FEE_RECIPIENT=<treasury address> pnpm --filter @opening-cross/devnet-proofs exec tsx src/init-protocol.ts` (dry run), then again with `CONFIRM=yes`. (`tests/devnet/src/init-protocol.ts`; its fresh-initialisation path has not been run on a live cluster because the devnet singleton already exists, but it sends the same two instructions `core-e2e.ts` and the end-to-end seed already send.)
6. Hand control to the multisig, following ADR-0013 as rehearsed in `tests/core/test/governance.test.ts`: `propose_admin` to the Squads vault and `accept_admin` from the vault; then `solana program set-upgrade-authority <program-id> --new-upgrade-authority <vault> --keypair <deployer>` for each of the five programs. After this, no single key can upgrade or change fees, and the guardian can only pause.
7. Record the signatures and hashes in this file and set L4 to DONE. Publish the build commit and `hashes.txt` so a stranger can run section 1's second check.

## 6. Not verified here

- A mainnet deployment, a fresh-cluster run of `init-protocol.ts`, a Squads handover on a real cluster (rehearsed on LiteSVM only; a devnet run of the handover itself has not been done).
- That the Docker image reproduces the same hash on a second machine (needs one more run elsewhere).
- Third-party verification through OtterSec's service (`solana-verify remote submit-job`), which needs the upgrade authority to upload the build record after deployment.
