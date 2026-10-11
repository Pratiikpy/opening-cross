# Devnet proof — Presale Vault partner-mint path (DP11)

Run: 2026-10-11T17:41:59.259Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/presale-vault-proof.ts`
Program: Meteora Presale Vault `presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj` (same address on devnet and mainnet)

Overall: **PASS**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| partner-mint | the partner authority mints exactly the presale supply to the creator account | PASS | [7Xo5kVyc…](https://explorer.solana.com/tx/7Xo5kVycDtWcV8PTwwWP5CDfwzcmGcXf9cy8ebN1Pc8HRWyZvrZBnuzTTmZFPUcHCydvYeKvWb8gdgCcFGAyqCa?cluster=devnet) | supply 2000000000, creator holds 2000000000, mint authority DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC |
| supply-in-vault | the presale program took the whole supply into its base vault; the creator holds none | PASS | [2HeB15Nx…](https://explorer.solana.com/tx/2HeB15NxarVRRMv1KC6vT6MKrcMrKE6iiDeBRg5WvorbooP7bzjDUtTaWoa7z4uFPR5mzFrtpwAp3M2fQKe4Yy5P?cluster=devnet) | vault 2000000000, creator 0 |
| revoke | mint authority revoked; supply unchanged | PASS | [ntji5Ban…](https://explorer.solana.com/tx/ntji5BanZFDoskuVf1nCaY9a9bbc3ujJito4c1FEYwqSBAk47XPLUzUgFNhrEjtAcU7hNewPjuQB7K1KZ6SyYKf?cluster=devnet) | mint authority null, supply 2000000000 |
| no-more-mint | nobody can mint more after the revoke (SPL Token FixedSupply, error 0x5) | PASS | — | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x5 |
| deposit | a buyer deposits quote into the presale after the revoke | PASS | [4moo9yrA…](https://explorer.solana.com/tx/4moo9yrAQLnKv6h6UUtmpHiPBrrmhjxcvikfnE6oDFxu9ueLdnuXUqb8MKyjR1CH5Hm7Nhf6xZKDTzvfmCD2hozU?cluster=devnet) | quote vault 100000000, buyer quote 900000000 |
| no-early-claim | a claim before the sale ends is refused: PresaleNotOpenForClaim (6017) | PASS | — | Program presSVxnf9UU8jMxhgSMqaRwNiT36qeBdNeTRKjTdbj failed: custom program error: 0x1781 |
| claim | the buyer claims base tokens at the fixed price from the supply minted before the revoke | PASS | [5gAh2vwY…](https://explorer.solana.com/tx/5gAh2vwYqfXqCRrMWVaJ4TC7CCf6qJD3HeeTLEpCJWe6kG9LfvXUFDzgKYw2ZTfjxwELdQuHHwCGaq6XxHQLFq17?cluster=devnet) | claimed 1000000000 base atoms for 100000000 quote atoms at 0.1 (expected 1000000000) |
| creator-withdraw | the creator withdraws the raised quote | PASS | [gnnWUtFf…](https://explorer.solana.com/tx/gnnWUtFfXZPiN7764kGtEVjacVgxG9W7nhnm92xcHx3Wsw8JZTfYf4U47Dxh6v92EHVqASH2UipSdAffki4MkQL?cluster=devnet) | creator quote 100000000 (expected 100000000) |
| unsold-refund | the unsold base is refunded to the creator, and total supply is still the original | PASS | [4AhyAKnU…](https://explorer.solana.com/tx/4AhyAKnUWUtacGhaiHWvr2z3thVkGog4ChFwTkw56YBBN4Vs6GFrNPywyPXoYjthJrdGc2G6uUCLfWieW7QCwqtt?cluster=devnet) | refunded 1000000000 (expected 1000000000); supply 2000000000 (expected 2000000000); sold 1000000000 + refunded = 2000000000 |
