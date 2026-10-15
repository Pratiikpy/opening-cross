// Demand-calibrated curve segments for the DBC continuation (ADR-0913; rows D3, V-D design).
//
// The continuation curve (`ContinuationDesign`) is issuer-chosen: strictly increasing multiples of the clearing price's square root, and one liquidity weight per
// segment. This module derives both from the demand the call auction revealed, so the depth after the cross sits where buyers said they would pay, and
// thins out where nobody did. It is a pure function of the bids: no network, no clock, no randomness.
//
// Method. Take the buy orders whose limit is above P*. They are the revealed willingness to pay above the clearing price. Lay K bands over the price range from
// P* to a little above the highest such limit, equal in log-price, so a band is the same percentage wide wherever it sits. A band's liquidity weight is the base
// quantity bid inside it, floored at a small share of the average so that no band is empty (the DBC SDK needs positive weights, and a curve with a dead band is a
// price cliff). The band edges become `sqrtPriceMultiples` (the square root of each edge over P*). With fewer than two distinct limits above P* there is no
// demand to read, so the function says so and returns a flat default shape instead of inventing a calibration.
export type DemandBid = { /** Limit price in quote atoms per `priceScale` base atoms. */ price: bigint; /** Base atoms bid. */ quantity: bigint };

export type CalibrateInput = {
  clearingPrice: bigint;
  /** The bids to read (buy orders of the cross, any that are at or below P* are ignored). */
  bids: DemandBid[];
  /** Number of curve segments (1 to 15; DBC allows 16 curve points). Default 4, and never more than there are distinct limits above P*. */
  segments?: number;
  /** How far above the highest limit the curve's last band reaches, in basis points. Default 2,000 (20%). */
  headroomBps?: number;
  /** The least a band weighs, as a share of the average band's demand, in basis points. Default 1,000 (10%). */
  floorBps?: number;
};

export type CalibratedBand = { /** Lower and upper edge of the band, in the cross's price units. */ from: bigint; to: bigint; /** Base atoms bid with a limit inside the band. */ demand: bigint; weight: number };

export type CalibratedCurve = {
  /** `ContinuationDesign.sqrtPriceMultiples`: the square root of each band's upper edge over P*, strictly increasing and above 1. */
  sqrtPriceMultiples: number[];
  /** `ContinuationDesign.liquidityWeights`: one per band, positive. */
  liquidityWeights: number[];
  bands: CalibratedBand[];
  /** Base atoms bid above P*. */
  demandAbove: bigint;
  /** `demand` when read from bids; `default` when there was nothing to read. */
  basis: 'demand' | 'default';
  reason?: string;
};

export const CURVE_MAX_SEGMENTS = 15;
/** The shape used when the bids give nothing to read: three bands at 1.25x, 1.6x and 2x of the square-root price, equal weight. */
export const DEFAULT_CURVE_MULTIPLES = [1.25, 1.6, 2] as const;

const BPS = 10_000;

function fail(message: string): never {
  throw new Error(message);
}

export function calibrateCurveFromDemand(input: CalibrateInput): CalibratedCurve {
  const p0 = input.clearingPrice;
  if (p0 <= 0n) fail('the clearing price must be positive');
  const segmentsAsked = input.segments ?? 4;
  if (!Number.isInteger(segmentsAsked) || segmentsAsked < 1 || segmentsAsked > CURVE_MAX_SEGMENTS) fail(`segments is 1 to ${CURVE_MAX_SEGMENTS}`);
  const headroom = input.headroomBps ?? 2_000;
  const floorBps = input.floorBps ?? 1_000;
  if (!Number.isInteger(headroom) || headroom < 0 || headroom > 100_000) fail('headroomBps is 0 to 100,000');
  if (!Number.isInteger(floorBps) || floorBps < 0 || floorBps > BPS) fail('floorBps is 0 to 10,000');

  const above = input.bids.filter((b) => {
    if (b.quantity < 0n || b.price < 0n) fail('a bid has a negative price or quantity');
    return b.price > p0 && b.quantity > 0n;
  });
  const distinct = new Set(above.map((b) => b.price)).size;
  const demandAbove = above.reduce((n, b) => n + b.quantity, 0n);
  if (distinct < 2) {
    const reason = distinct === 0 ? 'no bid had a limit above the clearing price' : 'only one limit price was bid above the clearing price';
    const bands = DEFAULT_CURVE_MULTIPLES.map((m, i) => ({ from: scaled(p0, i === 0 ? 1 : DEFAULT_CURVE_MULTIPLES[i - 1]!), to: scaled(p0, m), demand: 0n, weight: 1 }));
    return { sqrtPriceMultiples: [...DEFAULT_CURVE_MULTIPLES], liquidityWeights: DEFAULT_CURVE_MULTIPLES.map(() => 1), bands, demandAbove, basis: 'default', reason };
  }

  const k = Math.min(segmentsAsked, distinct);
  const top = above.reduce((m, b) => (b.price > m ? b.price : m), 0n);
  // Work in floating point only for the band edges, which are a design choice, then fix them back to integers; the demand sums are exact bigint arithmetic.
  const ratioTop = (Number(top) / Number(p0)) * (1 + headroom / BPS);
  const logTop = Math.log(ratioTop);
  const edges: bigint[] = [p0];
  for (let i = 1; i <= k; i++) {
    const e = i === k ? ceilMul(p0, ratioTop) : scaled(p0, Math.exp((logTop * i) / k));
    const prev = edges[edges.length - 1]!;
    edges.push(e > prev ? e : prev + 1n);
  }
  // The top edge must cover the highest limit, whatever the rounding did.
  if (edges[k]! < top) edges[k] = top;

  const demands = Array.from({ length: k }, () => 0n);
  for (const b of above) {
    // A band is (from, to]; the highest limit sits in the last band.
    let i = 0;
    while (i < k - 1 && b.price > edges[i + 1]!) i++;
    demands[i]! += b.quantity;
  }
  const average = Number(demandAbove) / k;
  const floor = (average * floorBps) / BPS;
  const raw = demands.map((d) => Math.max(Number(d), floor));
  const mean = raw.reduce((a, b) => a + b, 0) / k;
  const weights = raw.map((r) => Math.round((r / mean) * 10_000) / 10_000).map((w) => (w > 0 ? w : 0.0001));
  const multiples: number[] = [];
  let prev = 1;
  for (let i = 1; i <= k; i++) {
    let m = Math.sqrt(Number(edges[i]!) / Number(p0));
    // Strictly increasing and above 1, even when two edges are one price unit apart.
    if (!(m > prev)) m = prev + 1e-9;
    multiples.push(m);
    prev = m;
  }
  const bands = demands.map((demand, i) => ({ from: edges[i]!, to: edges[i + 1]!, demand, weight: weights[i]! }));
  return { sqrtPriceMultiples: multiples, liquidityWeights: weights, bands, demandAbove, basis: 'demand' };
}

/** `price x factor`, floored, for a factor that is a design choice (floating point is fine for it). */
function scaled(price: bigint, factor: number): bigint {
  return (price * BigInt(Math.round(factor * 1e9))) / 1_000_000_000n;
}
function ceilMul(price: bigint, factor: number): bigint {
  const f = BigInt(Math.round(factor * 1e9));
  return (price * f + 999_999_999n) / 1_000_000_000n;
}
