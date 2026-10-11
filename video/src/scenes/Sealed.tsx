import { MONO, THEME } from '../brand';
import { Appear, Caption, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'dark' as const;
const t = THEME[mode];

// commitment = sha256(order ‖ salt); the first sixteen hex characters of three sample commitments.
const BIDS = [
  { hash: 'eb2078b1101a6f73', side: 'BUY', qty: '1,200', price: '1.55' },
  { hash: '5c1e09ceac118c54', side: 'BUY', qty: '500', price: '1.30' },
  { hash: 'f68d7c67459103fe', side: 'BUY', qty: '800', price: '1.40' },
];

export function Sealed() {
  const { p } = useScene();
  const reveal = beat(p, 0.56, 0.18);
  const phase = p < 0.5 ? 0 : p < 0.56 ? 1 : 2;
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 140, top: 170, width: 820 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>Sealed bids</Eyebrow></Appear>
        <Appear p={p} start={0.06} style={{ marginTop: 28 }}>
          <Headline mode={mode} size={86} width={820}>Nobody can see your bid until it can no longer help them.</Headline>
        </Appear>
        <Appear p={p} start={0.2} style={{ marginTop: 36 }}>
          <Sub mode={mode} size={32} width={760}>A sealed bid puts only a hash on chain while the window is open. Bids that are never revealed are refunded in full.</Sub>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 1040, top: 230, width: 760 }}>
        {BIDS.map((b, i) => {
          const k = beat(p, 0.14 + i * 0.07, 0.12);
          const flip = beat(p, 0.56 + i * 0.05, 0.12);
          const shown = flip > 0.5;
          return (
            <div key={b.hash} style={{ opacity: k, transform: `translateX(${(1 - k) * 60}px)`, marginBottom: 26, height: 128, borderRadius: 24, border: `2px solid ${shown ? t.accent : t.border}`, background: t.surface, display: 'flex', alignItems: 'center', padding: '0 36px', gap: 28 }}>
              <div style={{ width: 54, height: 54, borderRadius: 14, background: shown ? t.accent : t.surface2, display: 'grid', placeItems: 'center' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={shown ? t.bg : t.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  {shown ? <path d="M7 11V8a5 5 0 0 1 9.6-2M5 11h14v10H5z" /> : <path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" />}
                </svg>
              </div>
              <div style={{ flex: 1, transform: `scaleY(${Math.max(0.05, Math.abs(1 - flip * 2 < 0 ? flip * 2 - 1 : 1 - flip * 2))})` }}>
                {shown ? (
                  <div style={{ fontFamily: MONO, fontSize: 38, color: t.ink }}>
                    {b.side} {b.qty} <span style={{ color: t.muted }}>@</span> {b.price}
                  </div>
                ) : (
                  <div style={{ fontFamily: MONO, fontSize: 34, color: t.muted }}>0x{b.hash}…</div>
                )}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 22, color: shown ? t.positive : t.subtle }}>{shown ? 'revealed' : 'committed'}</div>
            </div>
          );
        })}
        <div style={{ marginTop: 44, display: 'flex', gap: 0, height: 64, borderRadius: 16, overflow: 'hidden', border: `2px solid ${t.border}`, fontFamily: MONO, fontSize: 24 }}>
          {['commit window', 'reveal window', 'settle'].map((label, i) => (
            <div key={label} style={{ flex: i === 2 ? 0.7 : 1, display: 'grid', placeItems: 'center', background: phase === i ? t.accent : t.surface, color: phase === i ? t.bg : t.muted, fontWeight: phase === i ? 500 : 400, transition: 'none' }}>{label}</div>
          ))}
        </div>
        <Appear p={p} start={0.78} style={{ marginTop: 24 }}><Caption mode={mode}>Reveal checks the hash. A wrong salt, price or quantity is refused.</Caption></Appear>
      </div>
    </Stage>
  );
}
