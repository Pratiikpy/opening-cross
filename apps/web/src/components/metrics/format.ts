// Wording and number formatting for the measured-metrics sections. Pure, so the honesty rules are tested:
// a count is shown as "k of n", and a percentage only appears next to a sample large enough for it to mean something.

/** Below this many items a percentage would imply precision the sample does not have. */
export const PERCENT_MIN_SAMPLE = 30;

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "3 of 5", with the percentage appended only for samples of at least PERCENT_MIN_SAMPLE. */
export function ofCount(k: number, n: number): string {
  if (n === 0) return 'none yet';
  const base = `${k.toLocaleString('en-US')} of ${n.toLocaleString('en-US')}`;
  return n >= PERCENT_MIN_SAMPLE ? `${base} (${Math.round((k / n) * 100)}%)` : base;
}

/** A 0..1 property of the data (not a count of events), shown as a whole percent; null is "no data". */
export const share = (x: number | null): string => (x === null ? 'no data' : `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`);

/** Basis points: whole numbers from 100 up, up to two decimals below, with a non-breaking space before the unit. */
export function bps(x: number | null): string {
  if (x === null) return 'no data';
  const text = Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${text} bps`;
}

/** "95% interval 34% to 100%" for a proportion's Wilson range. */
export const interval = (lo: number | null, hi: number | null): string | null => (lo === null || hi === null ? null : `95% interval ${Math.round(lo * 100)}% to ${Math.round(hi * 100)}%`);

export function seconds(s: number | null): string {
  if (s === null) return 'no data';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Quote atoms (decimal string) as whole quote tokens when every sampled cross used the same decimals; otherwise as atoms. */
export function atoms(value: string | null, decimals: number[]): string {
  if (value === null) return 'no data';
  if (decimals.length !== 1) return `${BigInt(value).toLocaleString('en-US')} atoms`;
  const d = decimals[0]!;
  const unit = 10n ** BigInt(d);
  const v = BigInt(value);
  const frac = (v % unit).toString().padStart(d, '0').replace(/0+$/, '');
  return `${(v / unit).toLocaleString('en-US')}${frac ? `.${frac}` : ''} quote tokens`;
}
