# ADR-0911: DAMM v2 reward slots and joining the pool (D1, X17)

Status: accepted (2026-10-16) · Builds on ADR-0022, ADR-0007

## Context

D1 and X17 ask for reward slots on the compounding DAMM v2 pool a cross opens, "through Meteora's own instructions". The lock, the vesting schedule and the compounding fee mode were proved (ADR-0022); reward slots were not built.

## Decision

`packages/adapters/src/rewards.ts` builds Meteora's six reward instructions (`initialize_reward`, `fund_reward`, `claim_reward`, `update_reward_funder`, `update_reward_duration`, `withdraw_ineligible_reward`) and a decoder for a pool's creator, liquidity and two slots. `damm-lp.ts` builds `create_position` and `add_liquidity`, because a reward stream pays every position in proportion to its liquidity and the pool a cross opens holds only the issuer's: an outside holder has to be able to join to earn anything. The API has a route for each (`settle-meteora-extra-tx.ts`), `GET /v1/crosses/:address/damm-rewards`, and `damm-lp-join`, which sizes the deposit from the pool's own reserves (a share in basis points) and caps what it may take with a stated slippage; the web page has the forms (`apps/web/src/app/issuer/settle/meteora-more.tsx`).

## Facts found by running the real binary

- **Who may open a slot.** The pool's creator may open slot 0 only. Slot 1 needs a Meteora operator account; the creator trying it gets `MissingOperatorAccount`, and so does a stranger trying slot 0. The same holds for `update_reward_funder` and `update_reward_duration`.
- The duration must be one day to one year (`InvalidRewardDuration` otherwise). The slot names one funder; anyone else funding is refused (`InvalidAdmin`). Funding while a stream runs is accepted and adds to it.
- Claiming needs the position NFT: a stranger, and the issuer on another holder's position, get `InvalidAuthority`.
- **The split is by liquidity, and exact.** With a pool of one position and a second holder joining with a third of the issuer's liquidity (a quarter of the pool), the 8,640,000,000 streamed over a day was claimed 6,480,000,000 to the issuer (to within 200,000 atoms of rounding in the program's fixed-point rate) and 2,160,000,000 to the holder; the vault kept only that rounding dust. The adapters' pool decoder agrees with Anchor's on the creator, the liquidity and the slot.
- `withdraw_ineligible_reward` is refused while a stream runs (`RewardNotEnded`).

## Not covered

Slot 1 (needs a Meteora operator we do not have), DLMM reward slots (a separate set of instructions on the pair), a reward token with a transfer hook or transfer fee, a claimable amount computed off chain (the program pays it; the API does not predict it), and any run on a cluster (H27).
