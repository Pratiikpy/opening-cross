// Jupiter swap quotes: the price a person would actually get, routed across every Solana venue.
import type { JupiterQuote } from '../types.js';

export const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

export class NoRouteError extends Error {
  override readonly name = 'NoRouteError';
}

export interface RawQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
  contextSlot: number;
  error?: string;
  errorCode?: string;
}

/** priceImpactPct is a percent decimal string; the result is basis points x100 (1% is 10 000). */
export function impactBpsX100(pct: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(pct.trim());
  if (!m) throw new Error(`unreadable price impact "${pct}"`);
  const frac = (m[2] ?? '').padEnd(4, '0').slice(0, 4);
  return BigInt(m[1] as string) * 10_000n + BigInt(frac);
}

export function parseQuote(raw: RawQuote): JupiterQuote {
  if (raw.errorCode === 'COULD_NOT_FIND_ANY_ROUTE' || raw.errorCode === 'TOKEN_NOT_TRADABLE') throw new NoRouteError(raw.error ?? raw.errorCode);
  if (raw.error) throw new Error(`Jupiter: ${raw.error}`);
  return {
    inputMint: raw.inputMint,
    outputMint: raw.outputMint,
    inAmount: BigInt(raw.inAmount),
    outAmount: BigInt(raw.outAmount),
    priceImpactBpsX100: impactBpsX100(raw.priceImpactPct),
    routeLabels: raw.routePlan.map((r) => r.swapInfo.label ?? 'unknown'),
    contextSlot: raw.contextSlot,
  };
}

export type QuoteFn = (inputMint: string, outputMint: string, amount: bigint) => Promise<JupiterQuote>;

export function jupiterQuoter(baseUrl: string = JUPITER_QUOTE_URL, slippageBps = 50, timeoutMs = 15_000): QuoteFn {
  return async (inputMint, outputMint, amount) => {
    const url = `${baseUrl}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as RawQuote;
    if (!res.ok && !body.errorCode) throw new Error(`Jupiter HTTP ${res.status}`);
    return parseQuote(body);
  };
}
