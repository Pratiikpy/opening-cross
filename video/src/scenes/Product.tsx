// Real screens of the product. Each scene pans and zooms a recorded screenshot; nothing here is mocked.
import { MONO, type Mode, THEME } from '../brand';
import { Appear, Caption, Chip, Eyebrow, Headline, Shot, Stage, Sub, beat, useScene } from '../ui';

function Callout({ mode, p, start, x, y, children }: { mode: Mode; p: number; start: number; x: number; y: number; children: string }) {
  const k = beat(p, start, 0.08);
  const t = THEME[mode];
  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity: k, transform: `translateY(${(1 - k) * 14}px)`, background: t.ink, color: t.bg, borderRadius: 14, padding: '12px 22px', fontFamily: MONO, fontSize: 24, boxShadow: '0 16px 40px rgba(0,0,0,0.25)' }}>{children}</div>
  );
}

/** The investor flow: an open-book cross, a bid placed, the result claimed. */
export function Investor() {
  const { p } = useScene();
  const mode = 'light' as const;
  const second = p > 0.52;
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 110, top: 150, width: 640 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>For investors</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={74} width={620}>Bid. Wait for the close. Get the one price.</Headline>
        </Appear>
        <Appear p={p} start={0.14} style={{ marginTop: 28 }}>
          <Sub mode={mode} size={29} width={600}>Connect any Solana wallet. Funds are escrowed on chain; if the cross does not print, everything is refunded.</Sub>
        </Appear>
        <Appear p={p} start={0.2} style={{ marginTop: 34 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Chip mode={mode}>escrowed</Chip><Chip mode={mode}>one price</Chip><Chip mode={mode} tone="good">refund if no print</Chip>
          </div>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 800, top: 120 }}>
        <Shot mode={mode} src={second ? 'shots/w3/05-open-cross-settled-claimed.png' : 'shots/w3/02-open-cross-after-order.png'} width={1010} height={840} from={{ x: 0.07, y: second ? 0.03 : 0.02, zoom: 1.2 }} to={{ x: 0.08, y: second ? 0.045 : 0.04, zoom: 1.2 }} p={second ? (p - 0.52) / 0.48 : p / 0.52} start={0} dur={1} />
        {!second ? <Callout mode={mode} p={p} start={0.3} x={60} y={560}>your order, escrowed</Callout> : <Callout mode={mode} p={p} start={0.7} x={60} y={560}>settled and claimed</Callout>}
      </div>
    </Stage>
  );
}

/** The issuer console: mints read from chain, a cross created and scheduled. */
export function Issuer() {
  const { p } = useScene();
  const mode = 'dark' as const;
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 110, top: 170, width: 640 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>For issuers</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={74} width={620}>Open a cross in one form.</Headline>
        </Appear>
        <Appear p={p} start={0.14} style={{ marginTop: 28 }}>
          <Sub mode={mode} size={29} width={600}>Mints are read from the chain, the grid and window are checked, and the cross is created on Solana.</Sub>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 800, top: 120 }}>
        <Shot mode={mode} src={p < 0.5 ? 'shots/w4/01-form-top.png' : 'shots/w4/02-created-cross.png'} width={1010} height={840} from={p < 0.5 ? { x: 0.12, y: 0.0, zoom: 1.95 } : { x: 0.04, y: 0.0, zoom: 1.35 }} to={p < 0.5 ? { x: 0.24, y: 0.0, zoom: 1.95 } : { x: 0.06, y: 0.02, zoom: 1.35 }} p={p < 0.5 ? p / 0.5 : (p - 0.5) / 0.5} />
        <Appear p={p} start={0.55}><Caption mode={mode}>The created cross, read back from chain.</Caption></Appear>
      </div>
    </Stage>
  );
}

/** The trust layer on the real pages: a cross with its signed band, the premium monitor, the track record. */
export function TrustScreens() {
  const { p } = useScene();
  const mode = 'dark' as const;
  const t = THEME[mode];
  const shots = [
    { src: 'shots/trust/cross-settled-desktop-dark.png', label: 'Cross page: signed band, graded', from: { x: 0.06, y: 0.04, zoom: 1.18 }, to: { x: 0.07, y: 0.075, zoom: 1.18 } },
    { src: 'shots/trust/premium-settled-desktop-dark.png', label: 'Premium monitor: live mainnet quotes', from: { x: 0.19, y: 0.03, zoom: 1.62 }, to: { x: 0.19, y: 0.2, zoom: 1.62 } },
    { src: 'shots/trust/accuracy-settled-desktop-dark.png', label: 'Track record: every band counted', from: { x: 0.19, y: 0.03, zoom: 1.62 }, to: { x: 0.19, y: 0.16, zoom: 1.62 } },
  ];
  const idx = Math.min(2, Math.floor(p * 3));
  const local = p * 3 - idx;
  const fade = Math.min(1, local * 6) * Math.min(1, (1 - local) * 6 + 0.0001);
  const s = shots[idx]!;
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 110, top: 170, width: 640 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>On the page</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={74} width={620}>Every claim is a record you can open.</Headline>
        </Appear>
        <Appear p={p} start={0.14} style={{ marginTop: 28 }}>
          <Sub mode={mode} size={29} width={600}>Real pages, real data, read from the API. A band links to the signed record it was graded from.</Sub>
        </Appear>
        <div style={{ marginTop: 46, display: 'grid', gap: 14 }}>
          {shots.map((x, i) => (
            <div key={x.label} style={{ fontFamily: MONO, fontSize: 24, color: i === idx ? t.ink : t.subtle, display: 'flex', gap: 16, alignItems: 'center' }}>
              <span style={{ width: 14, height: 14, borderRadius: 7, background: i === idx ? t.accent : t.border }} />
              {x.label}
            </div>
          ))}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 800, top: 120, opacity: fade }}>
        <Shot mode={mode} src={s.src} width={1010} height={840} from={s.from} to={s.to} p={local} />
      </div>
    </Stage>
  );
}
