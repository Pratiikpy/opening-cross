// The issuer's own trading clock and halt flags for each xStock, from the public assets API.
import { sessionOf } from '../session.js';
import type { Session } from '../types.js';

export const XSTOCKS_ASSETS_URL = 'https://api.xstocks.fi/api/v2/public/assets';

export interface IssuerState {
  readonly ticker: string;
  readonly symbol: string;
  readonly mint: string | null;
  readonly halted: boolean;
  readonly period: string | null;
  readonly nextChangeAt: number | null;
}

export interface RawAsset {
  symbol: string;
  underlyingSymbol: string | null;
  isTradingHalted?: boolean;
  trading: { isTradingHalted?: boolean; currentPeriod: string; nextChangeAt: string | null } | null;
  deployments: { network: string; address: string }[];
}

export function parseAssets(nodes: readonly RawAsset[]): IssuerState[] {
  return nodes
    .filter((a) => a.underlyingSymbol)
    .map((a) => ({
      ticker: (a.underlyingSymbol as string).toUpperCase(),
      symbol: a.symbol,
      mint: a.deployments.find((d) => d.network === 'Solana')?.address ?? null,
      halted: Boolean(a.isTradingHalted || a.trading?.isTradingHalted),
      period: a.trading?.currentPeriod ?? null,
      nextChangeAt: a.trading?.nextChangeAt ? Math.floor(Date.parse(a.trading.nextChangeAt) / 1000) : null,
    }));
}

export async function fetchIssuerStates(timeoutMs = 20_000): Promise<IssuerState[]> {
  const out: IssuerState[] = [];
  for (let page = 0; page < 100; page++) {
    const res = await fetch(`${XSTOCKS_ASSETS_URL}?page=${page}&pageSize=100`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`xStocks API HTTP ${res.status}`);
    const j = (await res.json()) as { nodes: RawAsset[]; page: { hasNextPage: boolean } };
    out.push(...parseAssets(j.nodes));
    if (!j.page.hasNextPage) return out;
  }
  throw new Error('xStocks API returned more than 100 pages');
}

export const sessionFor = (s: IssuerState, atSeconds: number): Session | null => (s.period ? sessionOf(s.period, atSeconds) : null);
