# ADR-0912: The claimable amount of a fee-sharing vault is computed from its account (D7)

Status: accepted (2026-10-16) · Builds on ADR-0024, ADR-0701

## Context

D7 listed "the claimable amount is not computed (the accumulator scale is unverified)". A recipient of a Dynamic Fee Sharing vault could not be told what a claim would pay without sending one.

## Decision

`decodeFeeShareVault`, `feeShareClaimable`, `feeShareAccumulatorStep` and `feeShareClaimableAfterFunding` (`packages/adapters/src/feeshare.ts`) compute it from the vault account alone. The program keeps one Q64 fixed-point accumulator, `fee_per_share`; funding adds `(amount << 64) / total_share`; a claim pays `share x (fee_per_share - checkpoint) >> 64` and sets the checkpoint. `GET /v1/fee-share/:base/:mint` now returns `claimable` for every recipient.

## Verified against the real binary

With shares 7, 13 and 17 (total 37) and fundings of 1,000,000,007 and 333,333,333, which divide by nothing, so every rounding is exercised: the accumulator after a funding equals `(amount << 64) / 37` exactly; each real claim paid exactly the computed figure, before and after another recipient's claim and after a second funding; the projection of a funding that had not yet happened equalled the figure after it; and what is paid plus what stays in the vault equals what was funded, the dust being under one atom per recipient per funding. Layout read off a vault the binary wrote: in a user record the address is at offset 0, the share at 32, the claimed amount at 40 and the 16-byte-aligned checkpoint at 64; the documentation's field order does not say so.

## A refusal the documentation had and the builder did not

The program needs **at least two** recipients (`ExceededUser` for one); the builder allowed one and the API said "at least one". Both now require two to five. FEATURE_STATUS and ADR-0024 say "1 to 5 recipients" and should be corrected.

## Not covered

A vault whose token has a Token-2022 transfer fee (the credited amount is smaller than the funded one), the `fund_by_claiming_fee` path's amount (it depends on the position's fees), and the DBC creator and partner bridges, which stay unbuilt for pools this protocol opens (ADR-0701).
