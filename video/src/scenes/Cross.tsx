import { MONO, THEME } from '../brand';
import { Appear, Caption, Eyebrow, Headline, Mono, Stage, Sub, beat, outExpo, useScene } from '../ui';

const mode = 'light' as const;
const t = THEME[mode];

// The book from the end-to-end run on a local validator: two buyers against an issuer who sells 1,000 tokens at 1.20
// and 1,000 more at 1.50. The program printed 1.50 and matched 1,200.
const ORDERS = [
  { side: 'sell', qty: 1000, price: 1.2 },
  { side: 'sell', qty: 1000, price: 1.5 },
  { side: 'buy', qty: 1200, price: 1.55 },
  { side: 'buy', qty: 500, price: 1.3 },
] as const;

const X0 = 1.1;
const X1 = 1.65;
const Y1 = 2200;
const CW = 700;
const CH = 520;
const px = (price: number) => ((price - X0) / (X1 - X0)) * CW;
const py = (qty: number) => CH - (qty / Y1) * CH;

const demand = (price: number) => ORDERS.filter((o) => o.side === 'buy' && o.price >= price).reduce((a, o) => a + o.qty, 0);
const supply = (price: number) => ORDERS.filter((o) => o.side === 'sell' && o.price <= price).reduce((a, o) => a + o.qty, 0);

function steps(f: (p: number) => number): string {
  const xs = [X0, ...ORDERS.map((o) => o.price), X1].sort((a, b) => a - b);
  let d = `M${px(X0)},${py(f(X0))}`;
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i]!;
    d += ` L${px(x)},${py(f(x - 0.0001))} L${px(x)},${py(f(x + 0.0001))}`;
  }
  return d;
}

export function Cross() {
  const { p } = useScene();
  const curve = beat(p, 0.36, 0.3, (x) => x);
  const mark = beat(p, 0.7, 0.1);
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 760 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>How a cross works</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={84} width={760}>Everyone trades at one price.</Headline>
        </Appear>
        <Appear p={p} start={0.1} style={{ marginTop: 30 }}>
          <Sub mode={mode} size={32} width={700}>Orders gather during a window. When it closes, one price clears the most volume, and every order that crosses it trades there.</Sub>
        </Appear>
        <div style={{ marginTop: 44, display: 'grid', gap: 14 }}>
          {ORDERS.map((o, i) => (
            <Appear key={i} p={p} start={0.2 + i * 0.045} dur={0.08} y={16}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontFamily: MONO, fontSize: 30 }}>
                <span style={{ width: 96, color: o.side === 'buy' ? t.ink : t.accentText, fontWeight: 500 }}>{o.side === 'buy' ? 'BUY' : 'SELL'}</span>
                <span>{o.qty.toLocaleString('en-US')} @ {o.price.toFixed(2)}</span>
                {o.side === 'buy' && o.price === 1.55 ? (
                  <span style={{ color: t.positive, opacity: mark, fontSize: 26 }}>bid 1.55, pays 1.50</span>
                ) : null}
              </div>
            </Appear>
          ))}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1010, top: 170 }}>
        <svg width={CW + 120} height={CH + 100} viewBox={`-70 -30 ${CW + 120} ${CH + 100}`} style={{ overflow: 'visible' }}>
          <defs><clipPath id="c"><rect x="-4" y="-20" width={(CW + 8) * curve} height={CH + 40} /></clipPath></defs>
          {[0, 500, 1000, 1500, 2000].map((q) => (
            <g key={q}>
              <line x1="0" y1={py(q)} x2={CW} y2={py(q)} stroke={t.border} strokeWidth="2" />
              <text x="-16" y={py(q) + 8} textAnchor="end" fontFamily="'IBM Plex Mono', monospace" fontSize="22" fill={t.subtle}>{q}</text>
            </g>
          ))}
          {[1.2, 1.3, 1.4, 1.5, 1.6].map((x) => (
            <text key={x} x={px(x)} y={CH + 44} textAnchor="middle" fontFamily="'IBM Plex Mono', monospace" fontSize="22" fill={t.subtle}>{x.toFixed(2)}</text>
          ))}
          <g clipPath="url(#c)">
            <path d={steps(demand)} fill="none" stroke={t.ink} strokeWidth="6" strokeLinejoin="round" />
            <path d={steps(supply)} fill="none" stroke={t.accent} strokeWidth="6" strokeLinejoin="round" />
          </g>
          <text x={px(1.12)} y={py(1760)} fontFamily="inherit" fontSize="28" fontWeight="600" fill={t.ink} opacity={curve}>buyers</text>
          <text x={px(1.52)} y={py(2090) - 14} fontFamily="inherit" fontSize="28" fontWeight="600" fill={t.accentText} opacity={curve}>sellers</text>
          <g opacity={mark}>
            <line x1={px(1.5)} y1={py(1200)} x2={px(1.5)} y2={CH} stroke={t.ink} strokeWidth="3" strokeDasharray="8 8" />
            <circle cx={px(1.5)} cy={py(1200)} r={14 + 8 * (1 - mark)} fill={t.accent} />
            <rect x={px(1.5) - 150} y={py(1200) - 128} width="300" height="76" rx="16" fill={t.ink} />
            <text x={px(1.5)} y={py(1200) - 78} textAnchor="middle" fontFamily="'IBM Plex Mono', monospace" fontSize="36" fontWeight="500" fill={t.bg}>1.50 · 1,200</text>
          </g>
        </svg>
        <Appear p={p} start={0.78} style={{ marginTop: -10 }}>
          <Caption mode={mode}>Clearing price and matched volume, as printed on chain.</Caption>
        </Appear>
      </div>
    </Stage>
  );
}
