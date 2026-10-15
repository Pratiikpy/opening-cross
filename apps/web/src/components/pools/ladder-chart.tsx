'use client';

import { shortAddress } from '@/lib/units';
import { amount, ladderBars } from './format';
import { Scroll, TD, TH } from './parts';
import type { LadderBin } from './types';

const W = 640;
const H = 220;

/**
 * The bins of a DLMM pair as a depth chart. Each bin is a bar valued in quote tokens: offers of the base token sit to the right of the active bin (what a buyer
 * climbs through), bids of the quote token to the left (what a seller falls through). The table below the chart has every bin with its exact amounts.
 */
export function LadderChart({ bins, xDecimals, yDecimals, xMint, yMint, baseIsX }: { bins: LadderBin[]; xDecimals: number; yDecimals: number; xMint: string; yMint: string; baseIsX: boolean }) {
  if (bins.length === 0) return <p className="text-sm text-muted">No bin of this pair holds liquidity in the range that was read.</p>;
  const bars = ladderBars(bins.map((b) => ({ binId: b.binId, role: b.role, priceQ64: BigInt(b.quoteAtomsPerBaseAtomQ64), amountX: BigInt(b.amountX), amountY: BigInt(b.amountY) })));
  const gap = 2;
  const bw = Math.max(3, Math.min(28, (W - 20) / bars.length - gap));
  const step = bw + gap;
  const left = (W - step * bars.length) / 2;
  // The chart is drawn in the pair's own orientation: token X (offered above the active bin) to the right.
  const label = (role: LadderBin['role']) => (role === 'active' ? 'active bin' : role === 'ask' ? 'offers token X' : 'bids token Y');
  const total = bins.reduce((n, b) => n + (BigInt(b.amountX) > 0n || BigInt(b.amountY) > 0n ? 1 : 0), 0);
  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Bin ladder: ${total} bins hold liquidity. Bids to the left of the active bin, offers to the right.`} data-testid="ladder-chart">
        <line x1="0" x2={W} y1={H - 28} y2={H - 28} stroke="var(--border)" />
        {bars.map((b, i) => {
          const h = Math.max(b.share > 0 ? 2 : 0, b.share * (H - 56));
          const fill = b.role === 'active' ? 'var(--accent)' : b.role === 'ask' ? 'var(--ink)' : 'var(--positive)';
          const bin = bins[i]!;
          return (
            <rect key={b.binId} x={left + i * step} y={H - 28 - h} width={bw} height={h} fill={fill} opacity={b.role === 'active' ? 1 : 0.85} rx="1">
              <title>{`bin ${b.binId} (${label(b.role)}): ${amount(bin.amountX, xDecimals)} X, ${amount(bin.amountY, yDecimals)} Y`}</title>
            </rect>
          );
        })}
        <text x={left} y={H - 8} className="fill-[var(--muted)] font-mono text-[11px]">bin {bars[0]!.binId}</text>
        <text x={left + step * bars.length} y={H - 8} textAnchor="end" className="fill-[var(--muted)] font-mono text-[11px]">bin {bars.at(-1)!.binId}</text>
        <text x={W / 2} y={H - 8} textAnchor="middle" className="fill-[var(--accent-text)] font-mono text-[11px]">price rises to the right</text>
      </svg>
      <p className="text-xs text-muted">
        <span className="mr-3 inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm bg-positive" aria-hidden="true" /> bids (token Y, {shortAddress(yMint)})</span>
        <span className="mr-3 inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm bg-accent" aria-hidden="true" /> active bin</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm bg-ink" aria-hidden="true" /> offers (token X, {shortAddress(xMint)})</span>
        {baseIsX ? ' The base token is token X.' : ' The base token is token Y.'}
      </p>
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Every bin, with its amounts</summary>
        <Scroll label="Bins of the pair">
          <table className="w-full text-sm" data-testid="ladder-table">
            <thead>
              <tr>
                <th className={TH}>Bin</th>
                <th className={TH}>Role</th>
                <th className={TH}>Token X</th>
                <th className={TH}>Token Y</th>
                <th className={TH}>Resting orders</th>
              </tr>
            </thead>
            <tbody>
              {bins.map((b) => (
                <tr key={b.binId} className="border-t border-border" data-role={b.role}>
                  <td className={`${TD} font-mono`}>{b.binId}</td>
                  <td className={TD}>{label(b.role)}</td>
                  <td className={TD}>{amount(b.amountX, xDecimals)}</td>
                  <td className={TD}>{amount(b.amountY, yDecimals)}</td>
                  <td className={TD}>{BigInt(b.orderAmount) === 0n ? 'none' : `${amount(b.orderAmount, b.orderSide === 'ask' ? xDecimals : yDecimals)} (${b.orderSide})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      </details>
    </div>
  );
}
