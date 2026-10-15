# ADR-0913: Demand-calibrated continuation curve (D3, V-D design)

Status: accepted (2026-10-16) · Builds on ADR-0006, ADR-0482

## Context

D3's gap said the DBC continuation curve is "issuer-chosen (`sqrtPriceMultiples`), not demand-calibrated segments". The issuer picked the price points and every segment had the same liquidity weight.

## Decision

`calibrateCurveFromDemand` (`packages/adapters/src/calibrate.ts`) derives both from the demand the call revealed. It takes the buy orders with a limit above P*, lays K bands (default 4, at most 15, never more than there are distinct limits) equal in log price from P* to 20% above the highest limit, and gives each band a liquidity weight equal to the base bid inside it, floored at 10% of the average so that no band is empty (a dead band is a price cliff, and the DBC SDK needs positive weights). The band edges are the square roots of the edges over P*, which is what `ContinuationDesign.sqrtPriceMultiples` takes; the weights go to the new pass-through `liquidityWeights`. With fewer than two distinct limits above P* there is nothing to read, so it says so (`basis: "default"`, with a reason) and returns a flat default shape instead of inventing a calibration. It is a pure function: the same bids in any order give the same curve.

`POST /v1/curve/calibrate` exposes it (the clearing price from a cross, or given).

## Verified against the real DBC binary

A launch cleared at P* with bids of 300,000,000, 500,000,000, 1,000,000,000 and 2,800,000,000 base at 2.9, 2.6, 2.2 and 2.0 million: the calibrated design (three bands, weights 1.6667, 0.8333, 0.5 on demands of 1,000,000,000, 500,000,000 and 300,000,000) opened a pool at exactly P*, and the config DBC stored holds the calibrated price points to the last digit and liquidity per band in exactly the ratio of the weights (1 : 0.49997 : 0.29999 asked and stored). A weights list of the wrong length is refused before anything is sent.

## What this does and does not claim

It puts depth where buyers said they would pay. It does not claim the curve is optimal for the issuer or for price discovery: the band count, the headroom and the floor are design choices with defaults, no alternative curve was compared on outcomes, and revealed limits in a call are not a forecast of later demand. NOT VERIFIED: that a calibrated curve gives better outcomes than the issuer's own choice.
