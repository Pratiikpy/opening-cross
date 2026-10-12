import { MONO, THEME } from '../brand';
import live from '../data/live.json';
import { Appear, Caption, Count, Eyebrow, Headline, Stage, beat, useScene } from '../ui';

const mode = 'light' as const;
const t = THEME[mode];

// Live counters recorded by scripts-fetch-live.mjs from the public API (see src/data/live.json for the time and URL).
// The sweep and the replay are from docs/evidence/D5-verifier-devnet-sweep.md and D-integrity-replay.md.
const TILES = [
  { to: live.crossesTotal, label: 'crosses opened on devnet' },
  { to: live.crossesPrinted, label: 'cleared at one price' },
  { to: live.buyersFilled, label: 'buyers filled at that price' },
];

export function Demand() {
  const { p } = useScene();
  const bar = beat(p, 0.5, 0.25);
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 120, top: 120, width: 900 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>Working today</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 22 }}>
          <Headline mode={mode} size={76} width={900}>It runs end to end. One price each time.</Headline>
        </Appear>
        <div style={{ marginTop: 56, display: 'flex', gap: 56 }}>
          {TILES.map((x, i) => (
            <Appear key={x.label} p={p} start={0.18 + i * 0.06} dur={0.1}>
              <div style={{ fontFamily: MONO, fontSize: 112, fontWeight: 500, letterSpacing: -4, lineHeight: 1 }}>
                <Count p={p} start={0.2 + i * 0.06} dur={0.22} to={x.to} />
              </div>
              <div style={{ marginTop: 12, fontSize: 25, color: t.muted, maxWidth: 250, lineHeight: 1.25 }}>{x.label}</div>
            </Appear>
          ))}
        </div>
        <Appear p={p} start={0.34} style={{ marginTop: 22 }}>
          <Caption mode={mode}>Live from the public API, {live.fetchedAt.replace('T', ' ')} UTC. Includes our own test crosses; yours join the count.</Caption>
        </Appear>
        <Appear p={p} start={0.5} style={{ marginTop: 50 }}>
          <div style={{ fontFamily: MONO, fontSize: 22, letterSpacing: 3, color: t.accentText, marginBottom: 16 }}>CHECKED BY A SECOND, INDEPENDENT IMPLEMENTATION</div>
          <div style={{ position: 'relative', width: 800, height: 36, borderRadius: 18, background: t.surface2 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, height: 36, borderRadius: 18, width: 800 * bar * (38 / 48), background: t.positive }} />
            <div style={{ position: 'absolute', left: 800 * bar * (38 / 48) + 6, top: 0, height: 36, borderRadius: 18, width: Math.max(0, 800 * bar * (10 / 48) - 6), background: t.borderStrong }} />
          </div>
          <div style={{ marginTop: 16, fontFamily: MONO, fontSize: 28, whiteSpace: 'nowrap' }}><span style={{ color: t.positive }}>38 verified</span> · 0 mismatched · 10 not yet cleared</div>
          <div style={{ marginTop: 8 }}><Caption mode={mode}>48 devnet cross accounts, 2026-10-12. docs/evidence/D5-verifier-devnet-sweep.md</Caption></div>
        </Appear>
      </div>

      <div style={{ position: 'absolute', left: 1130, top: 150, width: 680 }}>
        <Appear p={p} start={0.3}>
          <div style={{ borderRadius: 28, border: `2px solid ${t.border}`, background: t.surface, padding: '40px 44px', boxShadow: '0 40px 120px rgba(11,11,15,0.12)' }}>
            <div style={{ fontFamily: MONO, fontSize: 22, letterSpacing: 3, color: t.accentText }}>A REAL LAUNCH ON MAINNET, REPLAYED</div>
            <div style={{ marginTop: 20, fontSize: 40, fontWeight: 600, letterSpacing: -1, lineHeight: 1.12 }}>A live Meteora pool, decoded swap by swap.</div>
            <div style={{ marginTop: 36, display: 'flex', gap: 54, fontFamily: MONO }}>
              <div>
                <div style={{ fontSize: 76, fontWeight: 500 }}><Count p={p} start={0.45} dur={0.25} to={429} /></div>
                <div style={{ fontSize: 22, color: t.subtle, whiteSpace: 'nowrap' }}>swaps in 240 seconds</div>
              </div>
              <div>
                <div style={{ fontSize: 76, fontWeight: 500, color: t.positive }}><Count p={p} start={0.5} dur={0.25} to={429} /></div>
                <div style={{ fontSize: 22, color: t.subtle, maxWidth: 270 }}>amounts equal to Meteora's own events</div>
              </div>
            </div>
            <div style={{ marginTop: 26, fontSize: 24, lineHeight: 1.35, color: t.muted }}>
              The same replay reads any pool Opening Bell opens, so an issuer's holders can watch what happened after the cross.
            </div>
            <div style={{ marginTop: 18 }}><Caption mode={mode}>Pool 4dkLqPfA…R1baq · D-integrity-replay.md</Caption></div>
          </div>
        </Appear>
        <Appear p={p} start={0.74} style={{ marginTop: 36 }}>
          <div style={{ borderRadius: 22, background: t.ink, color: t.bg, padding: '28px 36px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 32, fontWeight: 600 }}>Place a bid yourself</div>
              <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 25, color: '#c9c9cf' }}>opening-bell-psi.vercel.app</div>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 24, color: '#ff7a4a' }}>devnet</div>
          </div>
        </Appear>
      </div>
    </Stage>
  );
}
