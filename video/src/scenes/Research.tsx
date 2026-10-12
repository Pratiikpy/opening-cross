import { MONO, THEME } from '../brand';
import { Appear, Caption, Count, Eyebrow, Headline, Stage, beat, useScene } from '../ui';

const mode = 'dark' as const;
const t = THEME[mode];

// Third-party measurements are read from their publications (Pine Analytics, Memento Research); the census is ours,
// measured on mainnet in docs/evidence/data/D-diagnose-census-dbc.json.
const STATS = [
  { head: '50%+', to: 50, suffix: '%+', body: 'of pump.fun tokens are sniped in the block they are created', source: 'Pine Analytics' },
  { head: '84.7%', to: 847, suffix: '%', tenth: true, body: 'of 2025 launches trade below their launch valuation (100 of 118)', source: 'Memento Research' },
  { head: '25.5%', to: 255, suffix: '%', tenth: true, body: 'of 1,176,567 Meteora DBC transactions failed in 24 hours: a race', source: 'Our mainnet census, 11 to 12 Oct 2026' },
] as const;

// The sixteen problems Meteora and Colosseum say they want solved (PROBLEMS_AND_SOLVERS.md). Lit: what Opening Bell
// has built a working answer for. Tagged M: the problems Meteora's own brief lists.
const PROBLEMS: { id: string; name: string; ours: boolean; meteora: boolean }[] = [
  { id: 'P1', name: 'Unfair launches', ours: true, meteora: true },
  { id: 'P2', name: 'Price discovery', ours: true, meteora: true },
  { id: 'P3', name: 'Liquidity after launch', ours: true, meteora: true },
  { id: 'P4', name: 'Launch infrastructure', ours: true, meteora: true },
  { id: 'P5', name: 'Market access', ours: false, meteora: false },
  { id: 'P6', name: 'Gatekept capital', ours: false, meteora: false },
  { id: 'P7', name: 'Holder rights', ours: false, meteora: false },
  { id: 'P8', name: 'New asset classes', ours: false, meteora: true },
  { id: 'P9', name: 'Payments', ours: false, meteora: false },
  { id: 'P10', name: 'Agent payments', ours: false, meteora: false },
  { id: 'P11', name: 'Onboarding', ours: false, meteora: false },
  { id: 'P12', name: 'Agent investing', ours: false, meteora: false },
  { id: 'P13', name: 'Public intent', ours: false, meteora: false },
  { id: 'P14', name: 'Compliant securities', ours: true, meteora: false },
  { id: 'P15', name: 'Fake volume', ours: false, meteora: false },
  { id: 'P16', name: 'After-hours pricing', ours: true, meteora: false },
];

export function Research() {
  const { p } = useScene();
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 120, top: 120, width: 820 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>We studied the market first</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 22 }}>
          <Headline mode={mode} size={70} width={820}>The first block decides the price. Most buyers lose.</Headline>
        </Appear>
        <div style={{ marginTop: 44, display: 'grid', gap: 30 }}>
          {STATS.map((s, i) => {
            const k = beat(p, 0.16 + i * 0.12, 0.14);
            return (
              <div key={s.head} style={{ opacity: k, transform: `translateY(${(1 - k) * 30}px)`, display: 'flex', gap: 24, alignItems: 'center' }}>
                <div style={{ fontFamily: MONO, fontSize: 84, fontWeight: 500, color: t.accentText, minWidth: 300 }}>
                  <Count p={p} start={0.16 + i * 0.12} dur={0.18} to={s.to} format={(n) => ('tenth' in s && s.tenth ? (n / 10).toFixed(1) : String(n)) + s.suffix} />
                </div>
                <div>
                  <div style={{ fontSize: 28, lineHeight: 1.3, color: t.ink, maxWidth: 440 }}>{s.body}</div>
                  <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 20, color: t.subtle }}>{s.source}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 1030, top: 150, width: 780 }}>
        <Appear p={p} start={0.3}>
          <div style={{ fontFamily: MONO, fontSize: 22, letterSpacing: 2, color: t.muted, marginBottom: 22 }}>16 PROBLEMS MARKETS AND JUDGES ASK FOR, EACH STUDIED ON EVERY CHAIN</div>
        </Appear>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          {PROBLEMS.map((pr, i) => {
            const k = beat(p, 0.34 + i * 0.012, 0.1);
            const lit = beat(p, 0.62, 0.14);
            const on = pr.ours ? lit : 0;
            return (
              <div
                key={pr.id}
                style={{
                  opacity: k,
                  transform: `scale(${0.94 + 0.06 * k})`,
                  borderRadius: 18,
                  padding: '16px 16px 18px',
                  height: 128,
                  border: `2px solid ${on > 0.5 ? t.accent : t.border}`,
                  background: on > 0.5 ? 'rgba(255,106,61,0.13)' : t.surface,
                  position: 'relative',
                }}
              >
                <div style={{ fontFamily: MONO, fontSize: 20, color: on > 0.5 ? t.accentText : t.subtle }}>{pr.id}</div>
                <div style={{ marginTop: 8, fontSize: 23, fontWeight: 600, lineHeight: 1.15, color: on > 0.5 ? t.ink : t.muted }}>{pr.name}</div>
                {pr.meteora ? <div style={{ position: 'absolute', right: 12, top: 12, fontFamily: MONO, fontSize: 15, color: t.subtle, border: `1.5px solid ${t.borderStrong}`, borderRadius: 8, padding: '1px 7px' }}>Meteora</div> : null}
              </div>
            );
          })}
        </div>
        <Appear p={p} start={0.72} style={{ marginTop: 26, display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${t.accent}`, background: 'rgba(255,106,61,0.13)', display: 'inline-block' }} />
          <span style={{ fontSize: 24, color: t.ink }}>Built and working today: six of the sixteen</span>
        </Appear>
        <Appear p={p} start={0.8} style={{ marginTop: 18 }}>
          <Caption mode={mode}>Sources and dates: docs/evidence and PROBLEMS_AND_SOLVERS.md. The census is spot-checked against live mainnet.</Caption>
        </Appear>
      </div>
    </Stage>
  );
}
