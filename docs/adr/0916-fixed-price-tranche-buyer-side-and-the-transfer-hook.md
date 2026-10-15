# ADR-0916: The fixed-price tranche, buyer side, and a base token with the transfer hook (B4)

Status: accepted (2026-10-16) · Builds on ADR-0663

## Context

B4's open items: a transfer-hook base "is not exercised", there is "no page where buyers deposit into the tranche", and the indexer-facing parts are someone else's. Meteora publishes no buyer page address this repository can verify, so the link from a tranche to a buyer is the transactions themselves.

## Decision

- `packages/adapters/src/presale-buyer.ts` builds the buyer's and the issuer's instructions on Meteora's Presale Vault: create the escrow, deposit, claim, creator withdrawal (completed or failed), and decodes the `Presale` account (`decodePresale`, `presaleOutcome`).
- `buildOpenFixedPricePresale` takes `transferHook` for a base token with the cross_gate hook: the hook's five accounts follow the instruction and a `TransferHookBase` slice names them. The API finds the hook from the mint (`open-fixed-price-presale`); a hook it does not know is refused (`UNKNOWN_TRANSFER_HOOK`), because a transfer built without its accounts fails.
- Routes `presale-deposit`, `presale-claim`, `presale-creator-withdraw` read the tranche and refuse in words (`NOT_ONGOING`, `NOT_COMPLETED`, `SALE_FAILED`, `STILL_OPEN`, `ALREADY_WITHDRAWN`, `NO_ESCROW`, `NOT_THE_CREATOR`); the issuer page has the forms.

## Verified against the real binaries

A launch minted through the DBC continuation (so the base carries the hook), won by the issuer in the call, then sold as a tranche. Opening without the hook's accounts fails with `MissingRemainingAccountForTransferHook`; with them it opens at exactly P* (`q_price = floor(P* x 2^64 / scale)`) and 500,000,000 base move into the vault through the hook. Three buyers deposited; the third asked for 600,000,000 and the vault took 249,999,999, leaving its cap two atoms short at most; a deposit to the full vault is refused (`ZeroTokenAmount`) and one without an escrow too. A claim before the sale ends is refused (`PresaleNotOpenForClaim`), without the hook's accounts too, and each buyer received the floor of `deposit x 2^64 / q_price` or one atom less (199,999,999 for 300,000,000 at 1.5), which at P* cost each of them what they deposited to within two atoms. A second claim pays nothing. The issuer withdrew the quote raised, to within the atom the vault keeps, once (`CreatorAlreadyWithdrawn` the second time). A second tranche that raised nothing failed; the issuer took the hooked supply back through the hook, and only with the hook's accounts. The same flows ran through the API.

Rules Meteora's program enforced that the documentation does not spell out: the maximum cap must equal the supply's worth at the price (`InvalidTokenPrice`), the minimum cap must leave a gap below it (`PresaleMinMaxCapGapTooSmall`), and `creator_withdraw` reads the vault and the mint it moves from as its first two remaining accounts (the published IDL lists neither).

## Not covered

A buyer withdrawing during the sale or taking quote back from a failed sale (Meteora's instructions exist; no builder or route), permissioned whitelist modes, deposit fees, vesting and lock durations, the unsold-token action, the quote token with a hook or a transfer fee, the indexer decoding of `FixedPricePresaleOpened`, an MCP tool, and any run on a cluster (H27).
