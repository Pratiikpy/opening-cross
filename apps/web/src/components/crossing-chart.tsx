// Supply and demand stepping toward one price, after the hero chart in the design export.
// Drawn from fixed illustrative data and tagged "Illustration" where it is used.
const DEMAND = [10, 10, 9, 8, 8, 7, 6, 5, 4, 3, 3, 2, 1];
const SUPPLY = [1, 1, 2, 3, 3, 4, 5, 6, 7, 8, 9, 9, 10];

export function CrossingChart() {
  const w = 480;
  const h = 260;
  const step = w / (DEMAND.length - 1);
  const y = (v: number) => h - (v / 10) * (h - 16) - 8;
  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? 'M' : 'H'}${i * step}${i === 0 ? ` ${y(v)}` : ` V${y(v)}`}`).join(' ');
  const cross = DEMAND.findIndex((d, i) => d <= SUPPLY[i]!);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full" role="img" aria-label="Illustration: a falling demand line and a rising supply line meet at the clearing price">
      <path d={path(DEMAND)} fill="none" stroke="var(--ink)" strokeWidth="2.5" />
      <path d={path(SUPPLY)} fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
      <line x1="0" x2={w} y1={y(DEMAND[cross]!)} y2={y(DEMAND[cross]!)} stroke="var(--accent)" strokeWidth="1.5" />
      <circle cx={cross * step} cy={y(DEMAND[cross]!)} r="6" fill="var(--accent)" />
      <text x={step * 0.5} y={y(DEMAND[0]!) + 18} className="fill-[var(--muted)] font-mono text-[11px]">demand</text>
      <text x={w - step * 0.5} y={y(SUPPLY.at(-1)!) + 18} textAnchor="end" className="fill-[var(--muted)] font-mono text-[11px]">supply</text>
      <text x={cross * step + 10} y={y(DEMAND[cross]!) - 10} className="fill-[var(--accent-text)] font-mono text-[11px]">clearing price</text>
    </svg>
  );
}
