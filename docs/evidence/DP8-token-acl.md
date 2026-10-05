# Devnet proof DP8 — Token ACL gating with cross_gate

Run: 2026-10-05T08:56:40.770Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/token-acl-proof.ts`
Programs: Token ACL `TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP`, cross_gate `2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr`

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| mint | Token-2022 mint created with Default Account State = Frozen and token_acl metadata | PASS | [2E42Vq7n…](https://explorer.solana.com/tx/2E42Vq7nz7PMGr14QLT3gJ1iTQ3Z1Je3th8xzLchyk8ZSXCgREUwQ1WHZPSExyTFtqxsdPa3hqTKKRYQCnYJnH7s?cluster=devnet) | mint 6xb27RCNZxFUwgnDrGjQbv8j4TKuNnyYeTjvNvxebrVd |
| acl-config | freeze authority delegated to Token ACL MintConfig; gate = cross_gate; permissionless thaw/freeze on | PASS | [5PusfwCz…](https://explorer.solana.com/tx/5PusfwCzjYDBtiTNcK6CX5kMLRexz2iaQq7wL4fDqRr8HZjVVnHEEyUevPncyu7zvVfHFeY26xHj96Jf9xRnJYLe?cluster=devnet) | MintConfig 8F3DL9trqZroDaitFnpK5ZLQU3SBL9yxfLQNTiiWhgVF; freezeAuthority 8F3DL9trqZroDaitFnpK5ZLQU3SBL9yxfLQNTiiWhgVF |
| gate-config | cross_gate configured in allowlist mode; Alice holds a pass, Bob does not; both accounts start frozen | PASS | [3FqzVHGt…](https://explorer.solana.com/tx/3FqzVHGtzKhUyDyKn2HDhMemRWLwvmW2fMMtrCigDafD8h4DTSkxh61ZTxYNjohdZTeCGo5JucDey7PPccFyAjvx?cluster=devnet) | gate config BjR9UNRx68DtukUWPTAk7vSJPZQFmaCcT9SP2m7UYdvQ |
| DP8a | wallet with a pass thaws its account permissionlessly via Token ACL → cross_gate | PASS | [1tSnJ2we…](https://explorer.solana.com/tx/1tSnJ2weEawGpXjZ4M32S2Sj7DkyfjNW3sLTbsGicwthCoHG7wAWD8MjBtpBL1PbPnsegUVQNWPRvZKweHCJJze?cluster=devnet) | Alice account now Initialized |
| DP8b | wallet without a pass cannot thaw | PASS | — | Program log: AnchorError thrown in programs\cross_gate\src\lib.rs:143. Error Code: RecipientNotAllowed. Error Number: 6001. Error Message: Owner does not hold a pass for this token. |
| mint-to | issuer mints to the thawed allowed account | PASS | [381ni71P…](https://explorer.solana.com/tx/381ni71PFHRXF2E1zqawM3aWfQAHffAewFTBq2uKQvMajFDhauMLx3hXwrEvbW2BepL5Ecaa1vYzEFyMMr6xPEm2?cluster=devnet) | 1,000 tokens to Alice |
| DP8c | transfer to a wallet without a pass fails (destination frozen) | PASS | — | Program log: Error: Account is frozen |
| DP8d | permissionless freeze of a wallet that holds a pass is refused | PASS | — | Program log: AnchorError thrown in programs\cross_gate\src\lib.rs:154. Error Code: OwnerAllowed. Error Number: 6010. Error Message: Owner holds a pass; permissionless freeze is not allowed. |
| revoke | Alice pass revoked | PASS | [2Qzi7Jz9…](https://explorer.solana.com/tx/2Qzi7Jz9qnP48xtQm6AVzi1VuDC6ekyHg2kWpkemWCR1TrKFNFRcePUEKPCeAdAGqaowMjhhSjVhj7s94AjKR7i5?cluster=devnet) | pass account closed |
| DP8e | after revocation any caller freezes the account via Token ACL → cross_gate | PASS | [59zVx5FQ…](https://explorer.solana.com/tx/59zVx5FQmhuMNp6mbPNzzuUwF9NkHEzHe3sBiE5bdCZ1xmnYDXbnXSKpkDhp2anK1ak1neayLv2mXBGJ6b2bsmZA?cluster=devnet) | Alice account Frozen |
| DP8f | calling the gate directly (not through Token ACL) is refused | PASS | — | Program log: AnchorError thrown in programs\cross_gate\src\lib.rs:419. Error Code: NotCalledByTokenAcl. Error Number: 6008. Error Message: Gate check was not invoked by Token ACL. |
