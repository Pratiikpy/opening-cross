# ADR-0453: Per-identity limits and allocation classes

Status: accepted (2026-10-13). Implements PRODUCT_FEATURES B8, VM10, S8 (cap, one application, lottery tier, identity-bound vesting) and B9, T3 (allocation policies). Builds on ADR-0003, ADR-0004, ADR-0012 and ADR-0450.

## Context

The specification wants a cap per applicant (about 1%), one application per identity, an optional lottery for oversubscribed deals, and allocation policies: reserved shares for small verified buyers, for buyers who accept a lock, and for supporters, with early commitment improving priority and never price. All of it must leave the clearing price alone (ADR-0003) and keep `claim` O(1): a fill must be a pure function of the order and a few figures recorded at the clear.

## Decision

**Identity.** An identity is the wallet that holds the cross's `cross_gate` pass. The gate decides who may hold one: an attester's SAS attestation, a Merkle allowlist, or a grant by the gate authority (ADR-0012). One person, one pass is therefore as strong as the gate's attester; the program cannot see a person. Because a cap without an identity is theatre, `set_rules` refuses identity rules and classes on a cross without a gate (`InvalidParams`).

- `identity.max_orders` (1 = one application per identity) and `identity.cap_quote` (most quote the identity may have escrowed in live buy orders at once) are tracked in an `Applicant` account per (cross, wallet) that `commit_order` creates and `cancel_order` decrements. Both are required remaining accounts when the rules are set; leaving one out is `ApplicantMismatch`. The cap is on escrow, which is public at commit in both disclosure modes; a cap on quantity would need the quantity, which sealed orders hide.
- `close_applicant` returns the record's rent to its owner once the cross is finalized.

**Allocation classes.** Orders carry a class (`commit_order_ext`): 0 general, 1 identity-verified small (escrow at most `small_cap_quote`), 2 locked (the fill is locked for at least `min_lock_secs`, ADR-0454), 3 priority (placed before `early_until_ts`, or by a wallet holding a pass of `priority_gate`). A rationed marginal volume `R` is shared (`clearing_core::alloc`, written down in ADR-0104 of the earlier draft and reproduced here):

1. class 1 receives `reserve_bps[0]` of `R`, by lottery in whole lots when `lottery_unit > 0` (one ticket per order, every class-1 order is exactly one lot) and pro rata within the class otherwise;
2. classes 2 and 3 each receive `min(Q_c, R · reserve_bps / 10,000)`, pro rata within the class;
3. what remains is shared pro rata over everyone's remaining quantity, class 0 included, so a reserve a class cannot fill goes to the others and volume is never stranded.

Better-priced orders always fill in full whatever their class, and only the **marginal** tick is split by class, so the clearing price, the matched volume and every unrationed fill are exactly as ADR-0003. Fills round down, so the sum never exceeds `R`; a property test and the conformance vectors check it.

**The lottery.** Tickets are numbered in the order class-1 orders were revealed or placed at the marginal tick. The winning window starts at `seed[16..24] mod tickets`, where the seed comes from the draw of ADR-0452, which must therefore finish before the clear (`DrawRequired`). Every ticket wins in exactly `winners` of the possible windows. A lottery ticket cannot be withdrawn (the draw needs every number to be a live order).

**Identity-bound vesting** is `alloc.class1_cliff_secs` and `class1_vest_secs`: class-1 fills go to the lock vault and vest (ADR-0454).

## Not built

Bottom-up fill, merit or holder reservation from an on-chain balance snapshot (a supporter credential is a gate pass, class 3), and "lower future priority for fast flippers" (a reputation figure kept off chain). No VRF: the lottery uses the cluster's attested randomness of ADR-0452. The attester that makes "one wallet per person" true is a trusted party (HUMAN_TASKS HG3, HI1).

## Evidence

`tests/core/test/rules-classes.test.ts`: the limits (one application, the cap, cancel frees room, a missing gate is refused), and a full class/lottery cross with fills compared with the independent TypeScript reference order by order, locked fills vesting on a clock. `tests/core/test/rules-verifier.test.ts`: the verifier reproduces a classes cross from the class book. `packages/verifier/conformance/v2.json` (400+ vectors).
