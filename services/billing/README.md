# services/billing

Issuer subscriptions for managed recurring crosses: plans from the rate card, a payment built as an unsigned token transfer with a plan memo, the payment read back from the chain, entitlements, and signed invoices. A subscription buys the managed service around the program; it never gates the program.

```
DATABASE_URL=... RPC_URL=... BILLING_MINT=... REVENUE_WALLET=... BILLING_KEYPAIR=... pnpm --filter @opening-cross/billing start
```

| Route | |
|---|---|
| `GET /v1/billing/plans` | the plans, the mint and wallet a payment goes to (prices are proposals until HD1) |
| `POST /v1/billing/subscribe { plan, issuer }` | an unsigned transaction: the issuer signs and pays the fee |
| `POST /v1/billing/payments { signature }` | the chain is read back (amount from the revenue account's balance change, payer from the transfer's authority, plan from the memo) and the paid period recorded once |
| `GET /v1/billing/entitlements/:issuer` | periods paid for, the plan in force, recurring crosses used against those included |
| `POST /v1/billing/invoices { issuer }` | an invoice signed by the billing key; a finished period's is the same document every time |

Run on devnet: a throwaway issuer bought the starter plan with 99.00 test USDC and the revenue account held exactly that afterwards. Evidence: `docs/evidence/W2A-Y8-billing.md`; decision: `docs/adr/0304-issuer-subscription-billing.md`; variables: `docs/CONFIGURATION.md`.
