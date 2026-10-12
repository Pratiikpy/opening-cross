import { MONO, THEME } from '../brand';
import { Appear, Count, Logo, Mark, Stage, beat, useScene } from '../ui';

const mode = 'light' as const;
const t = THEME[mode];

const FIGURES = [
  { to: 100000, label: 'orders in one cross, each 21,633 CU', fmt: undefined },
  { to: 525, label: 'conformance vectors, an independent implementation agrees on all', fmt: undefined },
  { to: 33, label: 'transactions to settle those 100,000 orders', fmt: undefined },
];

export function Close() {
  const { p } = useScene();
  const draw = beat(p, 0.05, 0.2);
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 150, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Mark mode={mode} width={170} draw={draw} />
        <Appear p={p} start={0.18} style={{ marginTop: 56, textAlign: 'center' }}>
          <div style={{ fontSize: 108, fontWeight: 600, letterSpacing: -3, lineHeight: 1.04 }}>One fair price for every<br />new market on Solana.</div>
        </Appear>
        <Appear p={p} start={0.36} style={{ marginTop: 54 }}>
          <div style={{ display: 'flex', gap: 110 }}>
            {FIGURES.map((f, i) => (
              <div key={f.label} style={{ textAlign: 'center', width: 400 }}>
                <div style={{ fontFamily: MONO, fontSize: 76, fontWeight: 500 }}><Count p={p} start={0.4 + i * 0.05} dur={0.25} to={f.to} /></div>
                <div style={{ marginTop: 6, fontSize: 24, color: t.muted, lineHeight: 1.3 }}>{f.label}</div>
              </div>
            ))}
          </div>
        </Appear>
        <Appear p={p} start={0.7} style={{ marginTop: 70, display: 'flex', alignItems: 'center', gap: 60 }}>
          <Logo mode={mode} size={44} />
          <span style={{ fontFamily: MONO, fontSize: 28, color: t.muted }}>opening-bell-psi.vercel.app</span>
          <span style={{ fontFamily: MONO, fontSize: 24, color: t.subtle }}>Built in India on Solana</span>
        </Appear>
      </div>
    </Stage>
  );
}
