# ADR-0964: Deploy configuration is tested as the deployment reads it; a blank variable is an unset one

Status: accepted (2026-10-16) · Rows Z4, Y7 (external-flow exclusion), keeper configuration · Builds on ADR-0703 · Code `services/keeper/src/config.ts`, `deploy/docker-compose.yml`, `deploy/.env.example`, `services/keeper/test/deploy-compose.test.ts` · Evidence `W5-1G.md`

## Context

`OWN_WALLETS` is passed to the API by the compose file (`${OWN_WALLETS:-}`), and the API excludes those wallets, and each cross's own creator, proceeds recipient, integrator and fee recipient, from `/v1/metrics/external-flow`. Whether that wiring holds, and whether the market maker's flow is kept out when its key is listed, had not been tested. Reading the compose file against the keeper's source found two more gaps of the same kind:

- `KEEPER_DRY_RUN`, documented in the keeper, was not passed by compose, so it could not be switched on in a deployment.
- Passing a variable as `${KEEPER_DUTIES:-}` hands the process an empty string, and `parseDuties('')` means **no duties**: the first operator who listed the variable in `.env` and left it blank would have switched off refunds, challenge expiry, halts, graduation and backing.

## Decision

1. The keeper's environment is read in one place (`keeperConfig`), and **a blank variable is an unset one**: blank `KEEPER_DUTIES` is `default`; `none` is how to turn the optional duties off. A value that is not what it should be (a duty name, a whole number, an http(s) URL) is an error naming the variable, never a silent zero. `default` may be listed with others (`default,locks,partner-fees`).
2. Compose passes every keeper variable with its default spelled out, and `.env.example` documents each. A test fails when the keeper reads a variable compose does not pass, when compose passes one nothing reads, and when one is undocumented.
3. A test parses the compose file, expands `${VAR:-default}` and `${VAR:?msg}` as docker compose does, and hands the result to the code that consumes it: the API's `parseOwnWallets` and `externalFlow` for `OWN_WALLETS`, and `keeperConfig` for the keeper. With the list set, the keeper's and the market maker's orders are not counted as outside users; unset, they are, and the verdict says the figure is an upper bound.

## Consequences

`OWN_WALLETS` is a list the operator must keep complete: a wallet we operate that is on neither the list nor a cross role (throwaway wallets made on the fly) still counts as external, which the API's method text already says. Nothing was changed in the API.
