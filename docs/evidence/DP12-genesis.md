# DP12 — Metaplex Genesis third-party bucket (2026-10-05)

Question: can an Opening Cross be a "bucket" of a Metaplex Genesis launch, called from our
program, or is it a NO-GO?

Sources:

- Metaplex docs (metaplex.com/docs/smart-contracts/genesis, read 2026-10-05).
- The client `@metaplex-foundation/genesis` 0.43.2, the latest on npm on that date, in
  `research/repos/genesis-npm`.
- GitHub: no public repository holds the Genesis program source.

## Findings

- Program `GNS1S5J5AspKXgpjz6SvKL66kPaKWAhaGRhCqPRxii2B` (mainnet and devnet). Its source is not
  public; only the generated client is.
- Buckets are a fixed set defined by the program. Inflow: launch pool, presale, **uniform-price
  auction** (`addAuctionBucketV1`, `placeAuctionBidV1`, `claimAuctionTokensV1`,
  `claimAuctionRefundV1`), bonding curves and Pump. Outflow: unlocked, claim schedule, vault,
  distribution, Streamflow. Graduation targets: Meteora, Raydium CPMM and CLMM. The docs describe
  no way for an external program to register a new bucket type or sale mechanism.
- The unlocked outflow bucket (`addUnlockedBucketV2`) allocates base tokens to a `recipient` that
  is a plain public key. Its claim (`claimUnlockedV2`) takes `recipient` as an account, not a
  signer; only `payer` signs. The tokens go to the recipient's token accounts.

## Decision

- **NO-GO** for an Opening Cross as a native Genesis bucket called from our program. Genesis is
  closed source with a fixed bucket set, so there is no stable interface to CPI into or register
  with.
- **GO, by composition**, for issuers who launch on Genesis and want a later cross. An unlocked
  bucket names the issuer (or its treasury) as recipient; once claimed, the issuer supplies those
  tokens to an escrow-mode cross like any other seller. No CPI is needed, and both programs stay
  unmodified. The permissionless claim is read from the client's account definitions; running it
  on devnet waits on H10.
- Related work: Genesis's own uniform-price auction bucket is prior art for launch auctions on
  Solana. See DP10.
