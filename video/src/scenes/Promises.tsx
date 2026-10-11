import { MONO, THEME } from '../brand';
import { Appear, Caption, Chip, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'light' as const;
const t = THEME[mode];

// A real record from the end-to-end run on a local validator (docs/evidence/T-trust-e2e.md).
const ID = 'c5f36a0fb8c085cb7e1e99de…';
const SIGNER = 'C688U582…pytR';

export function Promises() {
  const { p } = useScene();
  const sign = beat(p, 0.3, 0.1);
  const settle = beat(p, 0.58, 0.12);
  const anchor = beat(p, 0.78, 0.12);
  const lane = { left: 1010, top: 250, width: 800 };
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 800 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>Signed, graded promises</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={80} width={800}>A price estimate you can hold us to.</Headline>
        </Appear>
        <Appear p={p} start={0.12} style={{ marginTop: 30 }}>
          <Sub mode={mode} size={31} width={740}>Before a cross closes we sign where its price will land. When it prints, the chain grades us, and the record counts every miss.</Sub>
        </Appear>
        <Appear p={p} start={0.7} style={{ marginTop: 40 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Chip mode={mode}>hit</Chip><Chip mode={mode}>miss</Chip><Chip mode={mode}>scored</Chip><Chip mode={mode}>void</Chip><Chip mode={mode}>unresolved</Chip>
          </div>
          <div style={{ marginTop: 18 }}><Caption mode={mode}>Each promise is counted exactly once.</Caption></div>
        </Appear>
      </div>
      <div style={{ position: 'absolute', ...lane }}>
        <div style={{ fontFamily: MONO, fontSize: 22, color: t.subtle, letterSpacing: 2 }}>CALL WINDOW</div>
        <div style={{ position: 'relative', marginTop: 22, height: 14, background: t.surface2, borderRadius: 7 }}>
          <div style={{ position: 'absolute', left: 0, top: 0, height: 14, width: `${Math.min(1, p / 0.58) * 100}%`, background: t.ink, borderRadius: 7 }} />
        </div>
        <div style={{ marginTop: 56, border: `2px solid ${sign > 0.5 ? t.ink : t.border}`, borderRadius: 24, padding: '34px 40px', background: t.bg, opacity: beat(p, 0.22, 0.1), boxShadow: '0 30px 80px rgba(11,11,15,0.10)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 30, fontWeight: 600 }}>Signed price band</div>
            <div style={{ opacity: sign, fontFamily: MONO, fontSize: 24, color: t.positive }}>signed</div>
          </div>
          <div style={{ marginTop: 22, display: 'flex', alignItems: 'baseline', gap: 18 }}>
            <span style={{ fontSize: 76, fontWeight: 600, letterSpacing: -2 }}>1.50</span>
            <span style={{ fontSize: 28, color: t.muted }}>estimate, no coverage claimed yet</span>
          </div>
          <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 22, color: t.subtle, lineHeight: 1.6 }}>
            <div>id {ID}</div>
            <div>signer {SIGNER}</div>
          </div>
        </div>
        <div style={{ marginTop: 34, opacity: settle, transform: `translateY(${(1 - settle) * 20}px)`, display: 'flex', alignItems: 'center', gap: 22 }}>
          <div style={{ width: 22, height: 22, borderRadius: 11, background: t.accent }} />
          <div style={{ fontSize: 34, fontWeight: 600 }}>The cross cleared at 1.50.</div>
        </div>
        <div style={{ marginTop: 10, marginLeft: 44, opacity: settle, fontFamily: MONO, fontSize: 26, color: t.positive }}>graded SCORED · error 0 ticks · read from the cross account</div>
        <div style={{ marginTop: 34, opacity: anchor, display: 'flex', alignItems: 'center', gap: 18, fontFamily: MONO, fontSize: 24, color: t.muted }}>
          <svg width="46" height="40" viewBox="0 0 46 40" fill="none" stroke={t.ink} strokeWidth="3">
            <rect x="17" y="2" width="12" height="9" rx="2" /><rect x="2" y="29" width="12" height="9" rx="2" /><rect x="32" y="29" width="12" height="9" rx="2" />
            <path d="M23 11v8M23 19H8v10M23 19h15v10" />
          </svg>
          folded into a Merkle root, written to Solana
        </div>
      </div>
    </Stage>
  );
}
