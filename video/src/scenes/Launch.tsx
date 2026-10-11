import { MONO, THEME } from '../brand';
import { Appear, Caption, Count, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'dark' as const;
const t = THEME[mode];

const STEPS = [
  { title: 'Cross clears', body: 'One price, P*, for everyone.', mono: 'P* = 1.50' },
  { title: 'Pool opens at P*', body: 'A Meteora DBC curve whose start price is the clearing price.', mono: 'start sqrt price = √P*, read back on chain' },
  { title: 'Winners claim', body: 'Tokens minted at exactly P*. Mint authority revoked.', mono: 'mint authority: none' },
  { title: 'Trading continues', body: 'Gated by the issuer\'s rules, then it graduates.', mono: 'DBC → DAMM v2' },
];

export function Launch() {
  const { p } = useScene();
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 140, top: 150, width: 1500 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>From launch to liquid market</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={80} width={1400}>The auction sets the price. The pool starts there.</Headline>
        </Appear>
        <Appear p={p} start={0.12} style={{ marginTop: 26 }}>
          <Sub mode={mode} size={32} width={1200}>No gap between the first fair price and the first pool price.</Sub>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 140, top: 490, width: 1640, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 28 }}>
        {STEPS.map((s, i) => {
          const k = beat(p, 0.22 + i * 0.14, 0.14);
          return (
            <div key={s.title} style={{ opacity: k, transform: `translateY(${(1 - k) * 40}px)`, border: `2px solid ${i === 1 ? t.accent : t.border}`, borderRadius: 26, background: t.surface, padding: '34px 32px', minHeight: 330, position: 'relative' }}>
              <div style={{ fontFamily: MONO, fontSize: 24, color: t.accentText }}>{String(i + 1).padStart(2, '0')}</div>
              <div style={{ marginTop: 14, fontSize: 38, fontWeight: 600, letterSpacing: -1 }}>{s.title}</div>
              <div style={{ marginTop: 14, fontSize: 26, color: t.muted, lineHeight: 1.35 }}>{s.body}</div>
              <div style={{ marginTop: 24, fontFamily: MONO, fontSize: 21, color: t.ink, lineHeight: 1.35 }}>{s.mono}</div>
              {i < STEPS.length - 1 ? <div style={{ position: 'absolute', right: -30, top: 150, width: 32, height: 3, background: t.borderStrong }} /> : null}
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', left: 140, top: 900, display: 'flex', gap: 80, fontFamily: MONO }}>
        <Appear p={p} start={0.5}>
          <span style={{ fontSize: 44, fontWeight: 500 }}><Count p={p} start={0.5} dur={0.2} to={153098} /></span>
          <span style={{ fontSize: 22, color: t.subtle }}> CU to open the pool</span>
        </Appear>
        <Appear p={p} start={0.54}>
          <span style={{ fontSize: 44, fontWeight: 500 }}><Count p={p} start={0.54} dur={0.2} to={54185} /></span>
          <span style={{ fontSize: 22, color: t.subtle }}> CU to bind the mint</span>
        </Appear>
        <Appear p={p} start={0.6}><Caption mode={mode}>Measured against Meteora's mainnet DBC program.</Caption></Appear>
      </div>
    </Stage>
  );
}
