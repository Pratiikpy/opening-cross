import { MONO, THEME } from '../brand';
import { Appear, Caption, Count, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'light' as const;
const t = THEME[mode];
const T = THEME.dark;

// Real output of `pnpm --filter @opening-cross/promises verify` against a live local validator, and of the
// conformance run against the program itself.
const LINES: { text: string; kind: 'cmd' | 'pass' | 'info' }[] = [
  { text: '$ verify <api>/v1/promises/c5f36a0f…', kind: 'cmd' },
  { text: 'PASS  id and signature valid for C688U582…pytR', kind: 'pass' },
  { text: 'PASS  published book hashes to inputsHash', kind: 'pass' },
  { text: 'PASS  recomputed point: tick 10 (promised 10)', kind: 'pass' },
  { text: 'GRADE SCORED  cleared at tick 10, error 0 ticks', kind: 'info' },
  { text: '', kind: 'info' },
  { text: 'conformance on chain: 523 run, 0 mismatches', kind: 'pass' },
];

export function Verifier() {
  const { p } = useScene();
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 760 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>Don't trust us</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={80} width={760}>Check the price yourself.</Headline>
        </Appear>
        <Appear p={p} start={0.12} style={{ marginTop: 30 }}>
          <Sub mode={mode} size={31} width={720}>A second, independent implementation recomputes every cross from its on-chain book. Same answer, or it says so.</Sub>
        </Appear>
        <Appear p={p} start={0.5} style={{ marginTop: 44 }}>
          <div style={{ display: 'flex', gap: 56, fontFamily: MONO }}>
            <div><div style={{ fontSize: 60, fontWeight: 500 }}><Count p={p} start={0.5} dur={0.2} to={525} /></div><div style={{ fontSize: 22, color: t.subtle }}>conformance vectors</div></div>
            <div><div style={{ fontSize: 60, fontWeight: 500, color: t.positive }}><Count p={p} start={0.52} dur={0.2} to={523} /></div><div style={{ fontSize: 22, color: t.subtle }}>reproduced by the program</div></div>
          </div>
          <div style={{ marginTop: 14 }}><Caption mode={mode}>The other 2 exceed account limits, and are named.</Caption></div>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 960, top: 190, width: 860, borderRadius: 26, background: T.bg, padding: '38px 42px', boxShadow: '0 40px 100px rgba(11,11,15,0.25)', border: `2px solid ${T.border}`, minHeight: 600 }}>
        <div style={{ display: 'flex', gap: 10, marginBottom: 26 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 16, height: 16, borderRadius: 8, background: c }} />)}
        </div>
        {LINES.map((l, i) => {
          const k = beat(p, 0.14 + i * 0.08, 0.06);
          const chars = Math.round(l.text.length * (l.kind === 'cmd' ? beat(p, 0.14, 0.14, (x) => x) : 1));
          return (
            <div key={i} style={{ fontFamily: MONO, fontSize: 24, lineHeight: 1.75, opacity: l.kind === 'cmd' ? 1 : k, color: l.kind === 'pass' ? T.positive : l.kind === 'cmd' ? T.ink : T.muted, whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: 44 }}>
              {l.kind === 'cmd' ? l.text.slice(0, chars) : l.text}
            </div>
          );
        })}
      </div>
    </Stage>
  );
}
