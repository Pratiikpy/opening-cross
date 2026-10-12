# Devnet proof — ownership-coin treasury: allowance, attestation-gated release, lapse and liquidation (A5)

Run: 2026-10-12T01:53:53.352Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/treasury-proof.ts` (`dp:treasury`). Real devnet transactions; expected refusals are simulated against the deployed program, so nothing failed is billed or recorded.
Programs: treasury `HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd`, Solana Attestation Service `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`. Funder, team, auditor (the SAS issuer), two coin holders and a stranger are throwaway keys funded from the devnet promiser key.
The treasury program takes `period_secs`, `grace_secs` and the attestation expiry as parameters, so this run uses a 90-second allowance period and a 45-second grace period on the real cluster clock. Production values (30-day period, 7-day grace) are the same code path with larger numbers; they are not exercised here.

Not covered: a real auditor. The attestation issuer is a throwaway key, so this proves the mechanism and not any real audit process (HUMAN H2). Multi-period spending over days and a grace period of days are not run; the one period reset and the grace expiry are run at their short settings. Where treasury proceeds come from (a cross paying straight into the vault) is covered by the cross proofs, not here: the vault is funded here by a plain mint of the quote token.

Overall: **FAIL**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| sas-setup | an auditor creates a SAS credential and schema on devnet | PASS | — | credential 7g55VNb3YdJjizKcTnZgLhw2NPbXq7Y4xWwpeAvZWHgo, schema H1zrjE7gmjyUtCNniy3FEjxVvVXZcRU4pWoLfdX2copw |
| refuse-open-supply | a coin whose mint authority is still set is refused (SupplyNotFixed) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:35. Error Code: SupplyNotFixed. Error Number: 6001. Error Message: The coin's supply must be fixed: its mint authority must be revoked. |
| create | the treasury is created over a fixed-supply coin with a 1,000-quote allowance per 90 s period | PASS | [3pye1ifQ…](https://explorer.solana.com/tx/3pye1ifQ8nmjLR9yCqJJKsGuss6bvyXEmNRYTwZE5jkci7YEgsmPDyVW2whYUHbkqX66XnXHZkUDymTiL9yECxdQ?cluster=devnet) | treasury 3SeQFrJ9X3NzNeJzzPFBTGeaE9qvxcsGrNxy4Hidavsw, vault 4aEFFe4i6GBuMTTa6kWFP5RMUDDKUfYeuCE48FF8ZMHo holds 10000000001 |
| refuse-unattested-spend | the team cannot spend before any attestation exists (NotAttested) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:73. Error Code: NotAttested. Error Number: 6005. Error Message: No live attestation for this treasury. |
| refuse-liquidate-without-lapse | nobody can start liquidation without a recorded lapse (NoLapse) | PASS | — | Program log: AnchorError occurred. Error Code: NoLapse. Error Number: 6009. Error Message: No lapse has been recorded. |
| refuse-early-redeem | holders cannot redeem before liquidation (NotLiquidating) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:187. Error Code: NotLiquidating. Error Number: 6004. Error Message: The treasury is not in liquidation. |
| attest | the auditor's SAS attestation for the treasury exists on devnet | PASS | [5uEK6JRt…](https://explorer.solana.com/tx/5uEK6JRtkxooeWN6TQEvx41WLySVC5BT8UQq32LbtzDDnm9a6opXUhLqSRkuWnYuk31e9xG1yWtrmekLXPjU6QaS?cluster=devnet) | attestation DCKTRwa3AYXta4GHh1XDExS21fCRvcF12zx6bmd9MLMe, expiry 1791769420 |
| spend-within-allowance | while attested the team spends its full allowance (600 + 400) | PASS | [4yVW2GZH…](https://explorer.solana.com/tx/4yVW2GZHJesyAr2uYPYSsEi3acwAzxBgnPQrB1kVQfFLsaECMKGtbkUebaZonKr96jZEGvpXmHGiKX4TF2uWkjkK?cluster=devnet) | team received 1000000000 |
| refuse-over-allowance | one more atom in the same period is refused (OverAllowance) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:100. Error Code: OverAllowance. Error Number: 6008. Error Message: Spend exceeds this period's allowance. |
| refuse-stranger-spend | a non-authority cannot spend (Unauthorized) | PASS | — | Program log: AnchorError caused by account: treasury. Error Code: Unauthorized. Error Number: 6002. Error Message: Only the treasury authority may spend. |
| refuse-wrong-attestation | the wrong attestation account is refused (WrongAttestationAccount) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:238. Error Code: WrongAttestationAccount. Error Number: 6007. Error Message: That is not this treasury's attestation account. |
| period-reset | after the 90 s period the allowance resets and the team spends another 1,000 | PASS | [67T866ku…](https://explorer.solana.com/tx/67T866kuYJX3q1qcj1ZmKu67Yib8wWU4dp6gZyawKBwDB6nETUieFX24ETmXybwFZxfUnor9VnfXTs7QmDA8Vst6?cluster=devnet) | team holds 2000000000 |
| refuse-lapse-while-attested | while the attestation is live nobody can record a lapse (StillAttested) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:133. Error Code: StillAttested. Error Number: 6006. Error Message: The attestation is still live. |
| lapse | once the attestation expires anyone records the lapse, starting the grace clock | PASS | [niFWyVNH…](https://explorer.solana.com/tx/niFWyVNHUHcPQHp6RTdQ5qzJkHQPqttSRSzsvHxxPWghaQk7Ghk7zeyAfpyD1dvtaiZf9u5L1QpUhkUW3cp9kDr?cluster=devnet) | lapsedSince 1791769424 (expiry 1791769420) |
| refuse-spend-lapsed | spending stops while the attestation is lapsed (NotAttested) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:73. Error Code: NotAttested. Error Number: 6005. Error Message: No live attestation for this treasury. |
| refuse-liquidate-in-grace | liquidation inside the grace period is refused (GraceNotOver) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:167. Error Code: GraceNotOver. Error Number: 6010. Error Message: The grace period after the lapse has not ended. |
| liquidation | after the grace period anyone triggers liquidation; the vault and coin supply are snapshotted | PASS | [5atMifUq…](https://explorer.solana.com/tx/5atMifUqTqoNZrXVBJpm2ZP5ZeiT8RV349N6beX15n4UyYsfUEJpJJk57vAbMZfmUhgx5Fqpehpxw7FJzxWkUYZc?cluster=devnet) | snapshot vault 8000000001, supply 1000000000 |
| refuse-revival-spend | a renewed attestation cannot revive a liquidating treasury for spending (Liquidating) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:72. Error Code: Liquidating. Error Number: 6003. Error Message: The treasury is in liquidation. |
| refuse-revival-record | nor clear the lapse (Liquidating) | PASS | — | Program log: AnchorError thrown in programs/treasury/src/lib.rs:152. Error Code: Liquidating. Error Number: 6003. Error Message: The treasury is in liquidation. |
| redeem | holders redeem pro rata (floor), exactly the snapshot share of the vault | PASS | [qn4dc2S1…](https://explorer.solana.com/tx/qn4dc2S1swtiidoX1j1tAnNj9BW7oCEzbZPELDYAf9Cr1KV2XRyLhdxA4acNSbcHkt7WtMpPjrmF2ciRZ75VSmt?cluster=devnet) | alice 4800000000 (expected 4800000000), bob 3200000000 (expected 3200000000) of snapshot 8000000001 |
| redeem-conserves | the vault keeps only rounding dust and the redeemed coins are burned | PASS | — | vault left 1 |
| refuse-double-redeem | redeeming coins you no longer hold is refused | PASS | — | Program log: Error: insufficient funds |
| cleanup | unused devnet SOL returned to the promiser key | PASS | — | 194117720 lamports returned |

## Error

```
Error: transaction 3Ht9vt7C9cMMo5Ygrscyq44DMCnEA1Hwrd4JCV55AazQvdUzAU6Je6wDou6DTSzUjS48CsiUVmhgUHQ17uKMc4xh not confirmed within 90 s
    at send (C:\Users\prate\col\tests\devnet\src\kit.ts:63:9)
    at async attest (C:\Users\prate\col\tests\devnet\src\treasury-proof.ts:83:17)
    at async main (C:\Users\prate\col\tests\devnet\src\treasury-proof.ts:169:3)
```
