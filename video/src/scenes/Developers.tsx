import { MONO, THEME } from '../brand';
import { Appear, Caption, Eyebrow, Headline, Stage, Sub, beat, useScene } from '../ui';

const mode = 'dark' as const;
const t = THEME[mode];

const PANELS = [
  {
    label: 'SDK',
    code: [
      "const ix = await buildPlaceOrder({",
      "  cross, owner, nonce: 0n,",
      "  side: OrderSide.Buy,",
      "  price: 1_550_000n, quantity: 1_200_000_000n,",
      "});",
    ],
  },
  {
    label: 'API',
    code: ['GET  /v1/crosses/:address/promise', 'GET  /v1/tokens/:mint/authenticity', 'POST /v1/tx/place-order   → unsigned'],
  },
  {
    label: 'MCP · 17 tools',
    code: ['oc_get_signed_band   oc_check_token', 'oc_get_premium       oc_draft_place_order', '"name": {"untrusted_tool_output":', '          {"text": "…"}}'],
  },
];

export function Developers() {
  const { p } = useScene();
  return (
    <Stage mode={mode}>
      <div style={{ position: 'absolute', left: 140, top: 160, width: 760 }}>
        <Appear p={p} start={0.02}><Eyebrow mode={mode}>For builders and agents</Eyebrow></Appear>
        <Appear p={p} start={0.05} style={{ marginTop: 26 }}>
          <Headline mode={mode} size={80} width={760}>Everything the app does is an API.</Headline>
        </Appear>
        <Appear p={p} start={0.12} style={{ marginTop: 30 }}>
          <Sub mode={mode} size={31} width={700}>Open source, Apache-2.0. Writes are unsigned transactions: your wallet signs, we never hold a key.</Sub>
        </Appear>
        <Appear p={p} start={0.7} style={{ marginTop: 40 }}>
          <Caption mode={mode}>An agent's token names arrive wrapped as data, never as instructions.</Caption>
        </Appear>
      </div>
      <div style={{ position: 'absolute', left: 980, top: 150, width: 840 }}>
        {PANELS.map((pnl, i) => {
          const k = beat(p, 0.18 + i * 0.16, 0.16);
          return (
            <div key={pnl.label} style={{ opacity: k, transform: `translateY(${(1 - k) * 34}px)`, marginBottom: 28, borderRadius: 22, background: t.surface, border: `2px solid ${t.border}`, padding: '24px 34px' }}>
              <div style={{ fontFamily: MONO, fontSize: 21, color: t.accentText, letterSpacing: 3, marginBottom: 12 }}>{pnl.label.toUpperCase()}</div>
              {pnl.code.map((l, j) => (
                <div key={j} style={{ fontFamily: MONO, fontSize: 24, lineHeight: 1.6, color: l.includes('untrusted') || l.includes('"text"') ? t.accentText : t.ink, whiteSpace: 'pre' }}>{l}</div>
              ))}
            </div>
          );
        })}
      </div>
    </Stage>
  );
}
