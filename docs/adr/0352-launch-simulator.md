# ADR-0352: The launch simulator runs the program's rules on integers and says it is a model

Status: accepted (2026-10-13)

## Context

PRODUCT_FEATURES A8 asks for a launch simulator: demand, clearing, float, liquidity and fees. The danger is a simulator that looks authoritative while inventing demand, or one that quietly disagrees with the program.

## Decision

- `apps/web/src/lib/issuer-sim.ts` implements the clearing rule of ADR-0003, the print guards of OCIP-1 section 7.7 (minimum volume, then maximum imbalance, both strict and division-free) and the fee formulas of section 7.6 over bigints. It agrees with the independent verifier (`packages/verifier/src/reference.ts`) on 600 random books for the price, the matched quantity and the rationed side, and on 300 random books for the fill a joining bid would get, and its fee arithmetic equals `packages/fees` for every kind and every integrator fee from 0 to 300.
- Demand is an input, never a default. The page starts with no demand and says so. Demand comes from three places: rows the issuer types, the soft commits on a draft listing (ADR-0353), or nothing. The three scenarios (half, once and twice the demand entered) are labelled scenarios; they are not a confidence interval and the page does not call them one.
- Outputs are what the rule gives: the clearing price, tokens sold, the raise, the fees the seller pays, what the issuer keeps, the float, the value at the clearing price, what stays unsold, demand over supply, and what a bid of a given limit would get. A cross that would not print says which guard stopped it and where it would have cleared.
- Not simulated, and said so on the page: the oracle guard (its verdict depends on a price update that does not exist yet), and liquidity after the cross. The API has no read of pool state, and the simulator does not invent depth. Fees are computed on the whole notional; the program rounds per order, so the figure is within a few atoms.
- The protocol fee schedule comes from the chain through `GET /v1/issuer/protocol`; if that read fails the page uses the schedule proposed in ADR-0010 and names it as proposed.

## Consequences

- A simulator result is only as good as the demand the issuer believes. The imbalance footgun (an oversubscribed sale fails a tight imbalance limit) is visible in the scenarios, and is explained in words next to the guard.
- Liquidity health stays a gap until a pool-state read exists in the API.
