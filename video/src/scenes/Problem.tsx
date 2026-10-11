import { MONO, THEME } from '../brand';
import { Appear, Caption, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'dark' as const;
const t = THEME[mode];

// An illustration, not data: three arrivals at the same new market, in the same second, each filling worse than the
// one before.
const FILLS = [
  { who: 'First block', price: 1.0 },
  { who: 'A bot', price: 1.38 },
  { who: 'You', price: 2.1 },
];
const BAR = 560;

export function Problem() {
  const { p } = useScene();
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 140, top: 190, width: 900 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>The problem</Eyebrow></Appear>
        <Appear p={p} start={0.06} style={{ marginTop: 28 }}>
          <Headline mode={mode} size={96} width={900}>A new market opens. The fastest takes the price.</Headline>
        </Appear>
        <Appear p={p} start={0.2} style={{ marginTop: 40 }}>
          <Sub mode={mode} width={820}>Thin books, a race for the first block, and a price no one agreed to.</Sub>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 1130, top: 300, width: 700 }}>
        <Appear p={p} start={0.18} dur={0.1}>
          <div style={{ fontFamily: MONO, fontSize: 24, color: t.muted, letterSpacing: 2, marginBottom: 36 }}>THE SAME TOKEN, THE SAME SECOND</div>
        </Appear>
        {FILLS.map((f, i) => {
          const k = beat(p, 0.28 + i * 0.12, 0.2);
          const last = i === FILLS.length - 1;
          return (
            <div key={f.who} style={{ marginBottom: 54 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', width: BAR + 120, opacity: Math.min(1, k * 2) }}>
                <span style={{ fontSize: 36, fontWeight: 600, color: last ? t.ink : t.muted }}>{f.who}</span>
                <span style={{ fontFamily: MONO, fontSize: 36, color: last ? t.accentText : t.ink }}>{(1 + (f.price - 1) * k).toFixed(2)}</span>
              </div>
              <div style={{ marginTop: 14, height: 22, width: BAR + 120, background: t.surface, borderRadius: 11 }}>
                <div style={{ height: 22, width: ((f.price / 2.1) * (BAR + 120)) * k, background: last ? t.accent : t.borderStrong, borderRadius: 11 }} />
              </div>
            </div>
          );
        })}
        <Caption mode={mode}>Illustration</Caption>
      </div>
    </Stage>
  );
}
