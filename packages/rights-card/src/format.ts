// Plain-language formatting for card text. Amounts stay exact: they are formatted from integer atoms, never through a float.

/** `1234500000` with 6 decimals is `1,234.5`. */
export function formatAtoms(atoms: bigint, decimals: number): string {
  const neg = atoms < 0n;
  const abs = neg ? -atoms : atoms;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals === 0 ? '' : (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

const UNITS: [string, bigint][] = [
  ['day', 86_400n],
  ['hour', 3_600n],
  ['minute', 60n],
  ['second', 1n],
];

/** `2592000` is `30 days`; a duration that is not a whole number of one unit is spelled out in the two largest units it needs. */
export function formatDuration(secs: bigint): string {
  if (secs <= 0n) return '0 seconds';
  const parts: string[] = [];
  let rest = secs;
  for (const [name, size] of UNITS) {
    const n = rest / size;
    if (n > 0n) {
      parts.push(`${n} ${name}${n === 1n ? '' : 's'}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

/** `2026-10-13 09:05 UTC`. */
export function formatTime(unixSecs: bigint): string {
  return `${new Date(Number(unixSecs) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
