# ADR-0472: stake-to-earn distributions, verified-revenue rounds and tranches

Status: accepted (2026-10-13) · PRODUCT_FEATURES E8, V3/Y6

## Distributions (E8)

Holders who want distributions **stake** coins in the treasury's coin vault (withdrawable at any time, in any state) and receive a pro-rata share of every deposit. Anyone deposits quote tokens (a dividend, a revenue share, a buyback return); the deposit is held in the distribution vault and released to the stakers through a per-coin accumulator (`acc_per_stake`, 1e9 fixed point, full-width multiply-divide, rounding down). A deposit streams over `stream_secs` (set when the treasury is extended; 0 pays at once): with a stream, a coin staked for one block to catch a deposit earns one block's share. Releases are attributed to whoever was staked during the interval because every stake change advances the stream first. A deposit made while nobody is staked waits and goes to the first staker after the window. Invariants, tested including a random sequence: `coin_vault = votes_locked + total_staked + grants_unreleased`; the distribution vault always covers settled-but-unclaimed rewards plus the unreleased stream; nothing is created or lost (paid + remainder = deposited), and the remainder is rounding dust.

Why staking: a push to every holder needs the holder list, which the program cannot enumerate; a Merkle distribution needs a trusted snapshot. Staking is the trustless way to know who holds what, at the cost that a holder must opt in. "Automated" here means no per-holder transaction by the payer and no trusted snapshot; it does not mean un-staked wallets are paid.

## Verified-revenue rounds (V3/Y6)

The extension fixes a share (`rev_share_bps`), a credential and schema, a round length and start, and a payment grace. For round `r` an attester writes a SAS attestation at nonce `sha256("oc-round" ‖ treasury ‖ r)` whose data is the round's revenue in quote atoms, a little-endian u64 (use SAS layout `[3]`; SAS itself then refuses other shapes). After the round ends and before the grace ends, **anyone** may call `pay_round`: the program reads the attestation, computes `ceil(revenue * share / 10000)`, takes it from the payer (the company or a sponsor) and streams it to the stakers. A zero-revenue attestation is a valid, unpaid round. If the grace passes with no paid round, **anyone** calls `mark_missed`: the NAV window opens and team spending freezes (ADR-0471). A round is paid or missed exactly once (the `round` PDA is `init`ed).

**Tranches.** The team may release `tranche_amount` from the vault once per paid round whose attested revenue met `tranche_min_revenue`. This is how the program reads "verified-revenue tranches": capital is released against verified revenue, not on the team's say-so. It is in addition to the periodic allowance and subject to the same freezes.

## Limits

- The attester is trusted for the figure. It is a named SAS credential holder; the program verifies that it signed, not that the number is true. The reader that produces the attestation from a payment processor is a service outside this program (`HT3` in HUMAN_TASKS); no payment-processor integration exists in this repository, so the revenue path is NOT VERIFIED against a real revenue source. `packages/treasury-client` exports the nonce derivation and the data encoding such a service needs.
- Reclaim zkFetch and bank feeds: not built.
- Proved on LiteSVM (`treasury-dist.test.ts`, 16 tests). Devnet proof is pending the upgrade (rounds compress to seconds, so the devnet script runs them live).
