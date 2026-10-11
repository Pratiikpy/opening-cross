// Shapes and formatting for the premium monitor (GET /v1/premium/summary, /v1/premium/latest).
// Premiums travel as signed integers in basis points x 100 (decimal strings); 4386 is 43.86 bps, 0.44%.

export type PremiumGroup = {
  session: 'regular' | 'pre' | 'post' | 'overnight' | 'closed';
  sizeUsd: number;
  leg: 'buy' | 'sell';
  summary: { n: number; medianBpsX100: string | null; p10BpsX100: string | null; p90BpsX100: string | null; minBpsX100: string | null; maxBpsX100: string | null; medianAbsBpsX100: string | null };
  excluded: Record<string, number>;
};

export type PremiumSummary = {
  cluster: string;
  reference: string;
  days: number;
  coverage: { rounds: number; tickers: number; first: number | null; last: number | null };
  groups: PremiumGroup[];
};

export type PremiumObservation = {
  at: number;
  ticker: string;
  symbol: string;
  mint: string;
  leg: 'buy' | 'sell';
  sizeUsd: number;
  session: PremiumGroup['session'];
  status: string;
  referenceE6: string | null;
  perShareE6: string | null;
  premiumBpsX100: string | null;
  route: string | null;
  multiplier: string | null;
};

/** "0.44%" for 4386; keeps the sign, drops a negative zero. */
export function percentOf(bpsX100: string | null): string {
  if (bpsX100 === null) return '—';
  const v = BigInt(bpsX100);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const hundredths = (a + 50n) / 100n; // hundredths of a percent
  const text = `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
  return neg && hundredths !== 0n ? `-${text}` : text;
}

/** "$382.97" from micro-USD. */
export function usdOf(e6: string | null): string {
  if (e6 === null) return '—';
  const v = BigInt(e6);
  const cents = (v + 5_000n) / 10_000n;
  return `$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const SESSION_LABEL: Record<PremiumGroup['session'], string> = {
  regular: 'Regular hours',
  pre: 'Pre-market',
  post: 'After hours',
  overnight: 'Overnight',
  closed: 'Market closed',
};

export const SESSION_ORDER: PremiumGroup['session'][] = ['regular', 'pre', 'post', 'overnight', 'closed'];

export const EXCLUSION_LABEL: Record<string, string> = {
  no_route: 'no route',
  quote_failed: 'quote failed',
  no_reference: 'no reference',
  no_multiplier: 'multiplier unreadable',
  zero_shares: 'no shares moved',
  issuer_halted: 'issuer halted',
};
