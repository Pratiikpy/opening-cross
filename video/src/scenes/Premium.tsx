import { MONO, THEME } from '../brand';
import premium from '../data/premium.json';
import { Appear, Caption, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'dark' as const;
const t = THEME[mode];

type Obs = { ticker: string; symbol: string; leg: 'buy' | 'sell'; sizeUsd: number; status: string; premiumBpsX100: string; multiplier: string };

// The first live round (docs/evidence/premium-live.md): $1,000 buys and sells of nine xStocks on Solana, priced per
// share against Hyperliquid's HIP-3 oracle, while the underlying market was closed.
const ROWS = Object.values(
  (premium.observations as Obs[]).filter((o) => o.sizeUsd === 1000 && o.status === 'ok').reduce<Record<string, { symbol: string; multiplier: string; buy: number; sell: number }>>((acc, o) => {
    const r = (acc[o.ticker] ??= { symbol: o.symbol, multiplier: o.multiplier, buy: 0, sell: 0 });
    r[o.leg] = Number(o.premiumBpsX100) / 10_000;
    return acc;
  }, {}),
).sort((a, b) => a.symbol.localeCompare(b.symbol));

const SCALE = 400; // pixels per percent
const MAXP = 0.6;

export function Premium() {
  const { p } = useScene();
  const rowH = 70;
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 140, top: 170, width: 700 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>Premium monitor</Eyebrow></Appear>
        <Appear p={p} start={0.06} style={{ marginTop: 28 }}>
          <Headline mode={mode} size={80} width={700}>What a stock token really costs.</Headline>
        </Appear>
        <Appear p={p} start={0.14} style={{ marginTop: 32 }}>
          <Sub mode={mode} size={31} width={640}>A real swap at $1,000, priced per share, set against an independent reference. By size. By market session.</Sub>
        </Appear>
        <Appear p={p} start={0.78} style={{ marginTop: 36 }}>
          <div style={{ fontFamily: MONO, fontSize: 24, color: t.muted, lineHeight: 1.6 }}>
            Nine tokens. Every quote priced.<br />
            NVDAx × 1.0017: the issuer's multiplier is in the price.
          </div>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 930, top: 150, width: 900 }}>
        <div style={{ position: 'relative', height: 34, fontFamily: MONO, fontSize: 22, color: t.subtle }}>
          <span style={{ position: 'absolute', left: 690, width: 100, textAlign: 'right' }}>sell</span>
          <span style={{ position: 'absolute', left: 800, width: 100, textAlign: 'right' }}>buy</span>
        </div>
        {ROWS.map((r, i) => {
          const k = beat(p, 0.2 + i * 0.045, 0.18);
          const cx = 450;
          const wBuy = Math.min(MAXP, Math.abs(r.buy)) * SCALE * k;
          const wSell = Math.min(MAXP, Math.abs(r.sell)) * SCALE * k;
          return (
            <div key={r.symbol} style={{ position: 'relative', height: rowH, opacity: Math.min(1, k * 3) }}>
              <div style={{ position: 'absolute', left: 0, top: 6, fontSize: 30, fontWeight: 600 }}>{r.symbol}</div>
              {r.multiplier !== '1' ? <div style={{ position: 'absolute', left: 0, top: 42, fontFamily: MONO, fontSize: 18, color: t.accentText }}>× {Number(r.multiplier).toFixed(4)}</div> : null}
              <div style={{ position: 'absolute', left: cx, top: 4, width: 2, height: rowH - 8, background: t.borderStrong }} />
              <div style={{ position: 'absolute', left: r.sell >= 0 ? cx + 2 : cx - wSell, top: 12, width: wSell, height: 18, background: t.muted, borderRadius: 9 }} />
              <div style={{ position: 'absolute', left: r.buy >= 0 ? cx + 2 : cx - wBuy, top: 38, width: wBuy, height: 18, background: t.accent, borderRadius: 9 }} />
              <div style={{ position: 'absolute', left: 690, width: 100, top: 18, textAlign: 'right', fontFamily: MONO, fontSize: 24, color: t.muted }}>{r.sell.toFixed(2)}%</div>
              <div style={{ position: 'absolute', left: 800, width: 100, top: 18, textAlign: 'right', fontFamily: MONO, fontSize: 24, color: t.accentText }}>{r.buy.toFixed(2)}%</div>
            </div>
          );
        })}
        <div style={{ marginTop: 20, maxWidth: 880 }}><Caption mode={mode}>Grey: sell. Orange: buy. Right of the line is above the reference. $1,000 swaps, per share. Market closed; the reference is a perpetual, not the cash market.</Caption></div>
      </div>
    </Stage>
  );
}
