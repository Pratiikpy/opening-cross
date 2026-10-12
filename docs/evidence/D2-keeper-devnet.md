# D2 — Keepers racing on devnet (chaos)

Run: 2026-10-12T02:03:14.996Z · RPC https://api.devnet.solana.com
Script `tests/devnet/src/keeper-chaos.ts`; stack from `tests/devnet/run-stack.sh`; keepers are the real `services/keeper` process
Program: cross_core `F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ`

Overall: **FAIL**

| Step | Claim | Result | Transaction | Detail |
|---|---|---|---|---|
| fund | creator, two keepers and nine traders funded with devnet SOL (total under 0.5 SOL) | PASS | — | 28568640 lamports moved from the throwaway funder; creator 2gmbSymfkSvBotpwGNWKgs1MWtLARhisRQTAxZW3h9bb, keeper A 2GvdosBdfGRJHBErQEw1j9GQa6AkKfKL3SysvCZUVg6E, keeper B 5X3FNvUN66GeF5M6AfKQoBgWiBzvNh8topsNAswNeTzn |

## Error

```
SolanaError: Transaction simulation failed
    at <anonymous> (/mnt/c/Users/prate/col/node_modules/.pnpm/@solana+rpc-transformers@8._41c576ca649c45ebd6174e5e14ce9c6e/node_modules/@solana/rpc-transformers/src/response-transformer-throw-solana-error.ts:56:23)
    at <anonymous> (/mnt/c/Users/prate/col/node_modules/.pnpm/@solana+rpc-transformers@8._41c576ca649c45ebd6174e5e14ce9c6e/node_modules/@solana/rpc-transformers/src/response-transformer.ts:44:57)
    at <anonymous> (/mnt/c/Users/prate/col/node_modules/.pnpm/@solana+functional@8.4.0_typescript@7.0.2/node_modules/@solana/functional/src/pipe.ts:235:36)
    at Array.reduce (<anonymous>)
    at pipe (/mnt/c/Users/prate/col/node_modules/.pnpm/@solana+functional@8.4.0_typescript@7.0.2/node_modules/@solana/functional/src/pipe.ts:235:16)
    at Object.responseTransformer (/mnt/c/Users/prate/col/node_modules/.pnpm/@solana+rpc-transformers@8._41c576ca649c45ebd6174e5e14ce9c6e/node_modules/@solana/rpc-transformers/src/response-transformer.ts:42:16)
    at Object.execute (/mnt/c/Users/prate/col/node_modules/.pnpm/@solana+rpc-spec@8.4.0_typescript@7.0.2/node_modules/@solana/rpc-spec/src/rpc-api.ts:135:39)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    at async Object.send (/mnt/c/Users/prate/col/node_modules/.pnpm/@solana+rpc-spec@8.4.0_typescript@7.0.2/node_modules/@solana/rpc-spec/src/rpc.ts:138:20)
    at async send (/mnt/c/Users/prate/col/tests/devnet/src/keeper-chaos.ts:101:9)
```
