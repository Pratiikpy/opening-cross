// Conversions between on-chain integers and what people read and type. Pure and exact: values are
// bigints end to end, and parsing refuses anything that would round.
//
// A cross price is quote atoms per `priceScale` base atoms (cross_core). Shown to people, it is
// quote tokens per one whole base token:
//   display = price · 10^baseDecimals / priceScale / 10^quoteDecimals

export type Market = { priceScale: bigint; baseDecimals: number; quoteDecimals: number };

/** Formats an integer amount of atoms as a decimal string, trimming trailing zeros. Whole parts get thousands separators. */
export function formatAtoms(atoms: bigint, decimals: number, maxFraction = decimals): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const unit = 10n ** BigInt(decimals);
  const whole = a / unit;
  const frac = (a % unit).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/** Parses a decimal string into atoms; null if malformed, negative or more precise than `decimals`. */
export function parseAtoms(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** The price as quote atoms per whole base token (exact only when it divides; floors otherwise). */
function quoteAtomsPerToken(price: bigint, m: Market): bigint {
  return (price * 10n ** BigInt(m.baseDecimals)) / m.priceScale;
}

/** A cross price as quote tokens per one base token. */
export function formatPrice(price: bigint, m: Market): string {
  return formatAtoms(quoteAtomsPerToken(price, m), m.quoteDecimals);
}

/** Parses a per-token price typed by a person into on-chain price units; null if not exactly representable. */
export function parsePrice(text: string, m: Market): bigint | null {
  const perToken = parseAtoms(text, m.quoteDecimals);
  if (perToken === null) return null;
  const num = perToken * m.priceScale;
  const den = 10n ** BigInt(m.baseDecimals);
  return num % den === 0n ? num / den : null;
}

/** Quote atoms a buyer pays for `quantity` base atoms at `price` (ceil, as cross_core charges). */
export function buyerPays(quantity: bigint, price: bigint, priceScale: bigint): bigint {
  return (quantity * price + priceScale - 1n) / priceScale;
}

/** Quote atoms a seller receives, before fees, for `quantity` base atoms at `price` (floor, as cross_core pays). */
export function sellerReceives(quantity: bigint, price: bigint, priceScale: bigint): bigint {
  return (quantity * price) / priceScale;
}

/** Basis points of an amount, rounded down as the program does (`mul_bps`). */
export function feeOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** "2h 14m 02s"-style countdown from seconds. */
export function formatDuration(seconds: bigint): string {
  let s = seconds < 0n ? 0n : seconds;
  const d = s / 86400n;
  s %= 86400n;
  const h = s / 3600n;
  s %= 3600n;
  const m = s / 60n;
  s %= 60n;
  const pad = (x: bigint) => x.toString().padStart(2, '0');
  return d > 0n ? `${d}d ${h}h ${pad(m)}m` : h > 0n ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

/** Lamports as SOL with up to 4 decimals, rounding up so an amount a person must have is never understated. */
export function formatSol(lamports: bigint): string {
  const per = 1_000_000_000n;
  const scaled = (lamports * 10_000n + per - 1n) / per;
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} SOL`;
}
