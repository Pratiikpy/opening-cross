# ADR-0550: The wizard's Rules step asks the API, and says what the network can do

Status: accepted (2026-10-14). Builds on ADR-0450 to ADR-0462 and ADR-0500, ADR-0504.

## Context

The issue wizard could create a cross but could not set any of the rules the extended `cross_core` enforces (ending buckets and a drawn end, a cancel cutoff, print guards, identity limits, allocation classes, lockups, declared insiders and a bond, extra oracles, stock options, a referral). Those rules are proved on LiteSVM and a local validator and are not deployed to devnet (H27). The screen has to be useful now and honest about that.

## Decision

1. **One validator.** The wizard does not copy `checkRules`. The form (`RulesForm`, `@opening-cross/presets/rules`) is turned into the `rules` object, and `POST /v1/rules/check` (the SDK's `checkRules`) judges it, a moment after typing stops. Field-format problems (a half minute, a percentage with three decimals) are named on the field first. A test (`services/api/test/issuer-rules-parity.test.ts`) holds the form's constants equal to the SDK's, every preset accepted by `checkRules` once the issuer supplies what only the issuer can, and every refusal field `checkRules` can produce mapped to a box of the form.
2. **The size is measured, not estimated.** With a wallet connected the wizard builds (never signs) `POST /v1/tx/create-cross-ruled` and shows `sizes`: one transaction, or the two the program needs when the quote account and the handover of the mint authority would push the first over 1,232 bytes, or the refusal when the creation and the rules alone do not fit. Measured against the harness: six declared insiders with a gate and an oracle guard switch to two transactions, eight do not fit.
3. **A half-landed creation can be finished.** If the transaction that creates the cross fails after the one before it landed, the page says the cross does not exist, counts what landed, and resends only the rest (the same request builds the same transactions for the same cross number).
4. **Presets set structure, never amounts.** Seven presets; a preset replaces the whole form, says its values are conventions, and names what the issuer must still fill.
5. **What bidders will see** is written from the `rules` object that will be committed, not from the form.
6. **Release honesty.** `GET /v1/programs` (workstream 3C, `routes/holder-programs.ts`) says whether `cross_core` and the treasury have the extension. On the first release the page says so, fails the readiness item and switches Create-with-rules off; clearing the rules brings back the plain Create, which the first release can do. If the release cannot be read, Create stays on and the creation is simulated on the cluster first (ADR-0552).

## Not covered

Chain state the program checks at creation (a halt state or calendar that does not exist). Series (`create-series`) has no screen. Whether the safety gate accepts a base mint whose authority was handed to the cross by a first transaction that landed alone (finishing re-requests the build) is NOT VERIFIED against a real cluster.
