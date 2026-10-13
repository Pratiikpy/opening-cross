import { ImageResponse } from 'next/og';
import { type Card, type Receipt, cardOf } from '@/lib/receipt';

export const RECEIPT_IMAGE = { width: 1200, height: 630 };

const INK = '#f4f4f2';
const MUTED = '#9a9aa2';
const OK = '#5fd08f';
const BAD = '#ff7a4a';

function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 30, fontWeight: 600, color: INK }}>
      <div style={{ display: 'flex', position: 'relative', width: 54, height: 30 }}>
        <div style={{ position: 'absolute', left: 0, top: 12, width: 54, height: 5, background: INK }} />
        <div style={{ position: 'absolute', left: 17, top: 0, width: 20, height: 30, background: '#e8430c' }} />
      </div>
      opening bell
    </div>
  );
}

function CardImage({ card, hash, network }: { card: Card; hash: string; network: string }) {
  const tone = card.verdict.tone === 'ok' ? OK : BAD;
  return (
    <div style={{ width: '100%', height: '100%', background: '#0b0b0f', color: INK, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 64px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Brand />
        <div style={{ display: 'flex', fontSize: 24, color: MUTED }}>{card.title}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', fontSize: 26, color: MUTED, letterSpacing: 2 }}>{card.headline.label.toUpperCase()}</div>
        <div style={{ display: 'flex', fontSize: card.headline.value.length > 12 ? 72 : 128, fontWeight: 700, letterSpacing: -3, lineHeight: 1.05 }}>{card.headline.value}</div>
        <div style={{ display: 'flex', marginTop: 20, alignItems: 'center', gap: 14, fontSize: 30, color: tone }}>
          <div style={{ display: 'flex', width: 16, height: 16, borderRadius: 8, background: tone }} />
          {card.verdict.text}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 24, gap: 6, fontSize: 28 }}>
          {card.wallet ? (
            <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 8 }}>
              <div style={{ display: 'flex', color: MUTED }}>{card.wallet.heading}</div>
              {card.wallet.lines.slice(0, 2).map((l, i) => (
                <div key={i} style={{ display: 'flex', width: '100%', fontSize: 26, lineHeight: 1.25 }}>
                  {l}
                </div>
              ))}
              {card.wallet.lines.length > 2 ? <div style={{ display: 'flex', color: MUTED }}>{`and ${card.wallet.lines.length - 2} more on the receipt page`}</div> : null}
            </div>
          ) : (
            card.lines
              .filter((l) => l.label === 'Matched' || l.label === 'Orders filled')
              .map((l) => (
                <div key={l.label} style={{ display: 'flex', gap: 14 }}>
                  <div style={{ display: 'flex', color: MUTED }}>{l.label}</div>
                  <div style={{ display: 'flex' }}>{l.value}</div>
                </div>
              ))
          )}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 22, color: MUTED }}>
        <div style={{ display: 'flex' }}>{`${card.lines.find((l) => l.label === 'Cross')?.value ?? ''} · Solana ${network} · not audited`}</div>
        <div style={{ display: 'flex' }}>{`receipt sha-256 ${hash.slice(0, 16)}…`}</div>
      </div>
    </div>
  );
}

/** The receipt as a PNG. Only values from the receipt are drawn. */
export function receiptImage(receipt: Receipt, sha256: string, cacheSeconds: number): ImageResponse {
  return new ImageResponse(<CardImage card={cardOf(receipt)} hash={sha256} network={receipt.network} />, {
    ...RECEIPT_IMAGE,
    headers: { 'cache-control': `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` },
  });
}

/** A plain card for a request that cannot be answered with a receipt (an unsettled cross, an API that stayed busy). */
export function noticeImage(title: string, detail: string): ImageResponse {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', background: '#0b0b0f', color: INK, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '56px 64px' }}>
        <Brand />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, letterSpacing: -2 }}>{title}</div>
          <div style={{ display: 'flex', fontSize: 30, color: MUTED }}>{detail}</div>
        </div>
        <div style={{ display: 'flex', fontSize: 22, color: MUTED }}>Solana devnet · not audited</div>
      </div>
    ),
    { ...RECEIPT_IMAGE, headers: { 'cache-control': 'no-store' } },
  );
}
