# W2D-B8: per-identity cap, one application, lottery tier, identity-bound vesting (B8, VM10, S8)

Outcome: **BUILT-LOCAL**. Design: ADR-0453, ADR-0454.

- `identity.max_orders` (1 = one application per identity) and `identity.cap_quote` (most quote an identity may have escrowed in live buy orders) per wallet holding the cross's gate pass; cancel frees the room; the applicant record is required, so leaving it out is refused (`rules-classes.test.ts`, `rules-safety.test.ts`).
- Class-1 lottery for oversubscribed ticks: one ticket per order, every order exactly one lot, a winning window from the draw; every ticket wins in the same number of windows (`alloc` unit tests).
- Identity-bound vesting: class-1 fills go to the lock vault and vest (`alloc.class1_cliff_secs`, `class1_vest_secs`).
- Fills for crosses with random books of classes, a lottery, a cap, insiders and cancels equal the independent TypeScript reference, order by order (`rules-random.test.ts`, 24 seeds; `rules-classes.test.ts`; 400+ v2 conformance vectors; `rules-verifier.test.ts`).

Limits: an identity is the wallet that holds the gate pass; "one person, one pass" is only as strong as the gate's attester (HUMAN_TASKS HG3, HI1), which the program cannot see. The lottery uses the cluster's block hashes, not a VRF (ADR-0452).

FEATURE_STATUS.md row wanted: `| B8, VM10, S8 per-identity allocation | BUILT-LOCAL | Per-identity application and escrow cap, class-1 lottery tier, identity-bound vesting, all keyed to the gate pass holder; fills equal the independent reference on 24 random books and 400+ vectors (`W2D-B8.md`, ADR-0453) | An identity is a gate-pass wallet, so one person one ID depends on the attester; lottery randomness is not a VRF; devnet proof pending funding; not audited |`
