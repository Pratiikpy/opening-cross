import { MONO, THEME } from '../brand';
import { Appear, Caption, Chip, Count, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'light' as const;
const t = THEME[mode];

// Verdicts as the classifier returns them (packages/authenticity). The first is the real xStocks TSLAx; the second a
// token that copies its symbol; the third a real Backpack Securities token for another company, found in a live sweep.
const CARDS = [
  { name: 'TSLAx', addr: 'XsDoVf…qsJHzoB', tone: 'good' as const, verdict: 'GENUINE', line: "Listed by xStocks. The mint, freeze, pause and delegate keys on chain are the issuer's." },
  { name: 'TSLAx', addr: '7xKXtg…JosgAsU', tone: 'bad' as const, verdict: 'IMPERSONATOR', line: 'Copies a genuine symbol and is not it. The real one is XsDoVf…qsJHzoB.' },
  { name: 'DJT', addr: 'DJTu7v…zfxvoF', tone: 'warn' as const, verdict: 'UNVERIFIED STOCK TOKEN', line: 'A tokenized stock from an issuer we do not cover. Not accused; not confirmed.' },
];

export function Authenticity() {
  const { p } = useScene();
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 120, top: 150, width: 760 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>Is this real?</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={80} width={760}>A name is the one thing a fake can copy for free.</Headline>
        </Appear>
        <Appear p={p} start={0.14} style={{ marginTop: 30 }}>
          <Sub mode={mode} size={31} width={700}>We check the issuer's own list and the keys the issuer holds on chain. Names and logos prove nothing.</Sub>
        </Appear>
        <Appear p={p} start={0.5} style={{ marginTop: 44 }}>
          <div style={{ display: 'flex', gap: 56, fontFamily: MONO }}>
            <div><div style={{ fontSize: 56, fontWeight: 500, color: t.ink }}><Count p={p} start={0.5} dur={0.2} to={1774} /></div><div style={{ fontSize: 22, color: t.subtle }}>issuer mints read on chain</div></div>
            <div><div style={{ fontSize: 56, fontWeight: 500, color: t.positive }}><Count p={p} start={0.52} dur={0.2} to={0} /></div><div style={{ fontSize: 22, color: t.subtle }}>of the top 100 tokens falsely accused</div></div>
          </div>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 960, top: 170, width: 860 }}>
        {CARDS.map((c, i) => {
          const k = beat(p, 0.2 + i * 0.14, 0.14);
          return (
            <div key={c.verdict} style={{ opacity: k, transform: `translateY(${(1 - k) * 36}px)`, marginBottom: 30, borderRadius: 26, border: `2px solid ${c.tone === 'good' ? t.positive : c.tone === 'bad' ? t.accent : t.borderStrong}`, background: c.tone === 'good' ? t.positiveBg : t.bg, padding: '30px 38px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
                  <span style={{ fontSize: 46, fontWeight: 600 }}>{c.name}</span>
                  <span style={{ fontFamily: MONO, fontSize: 24, color: t.subtle }}>{c.addr}</span>
                </div>
                <Chip mode={mode} tone={c.tone}>{c.verdict}</Chip>
              </div>
              <div style={{ marginTop: 14, fontSize: 28, color: t.muted, lineHeight: 1.35 }}>{c.line}</div>
            </div>
          );
        })}
        <Appear p={p} start={0.86}><Caption mode={mode}>The copy is a constructed test token; every verdict is the classifier's real output. It says who issued a token, not whether it is a good buy.</Caption></Appear>
      </div>
    </Stage>
  );
}
