# W2D-D9: liquidity health helper

Status: BUILT-LOCAL. `packages/adapters/src/health.ts` (ADR-0486): exact integer constant-product quote, slippage in bps, depth at a slippage limit (bisection) and time-weighted persistence from snapshots. Tests `packages/adapters/test/health.test.ts` (6, pass on Windows): monotonic slippage, depth maximality across pools and fees, a fee above the limit leaves no depth, persistence weighting. Full-range DAMM v2 pools only; DLMM depth needs bin arrays and is not covered. No on-chain part: none belongs here.
