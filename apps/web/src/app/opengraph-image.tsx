import { ImageResponse } from 'next/og';

export const alt = 'Opening Bell: one fair price for every new market on Solana';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', background: '#0b0b0f', color: '#f4f4f2', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 36, fontWeight: 600 }}>
          <div style={{ display: 'flex', position: 'relative', width: 66, height: 36 }}>
            <div style={{ position: 'absolute', left: 0, top: 15, width: 66, height: 6, background: '#f4f4f2' }} />
            <div style={{ position: 'absolute', left: 21, top: 0, width: 24, height: 36, background: '#e8430c' }} />
          </div>
          opening bell
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', fontSize: 84, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>
          <div>One fair price for</div>
          <div style={{ color: '#9a9aa2' }}>every new market on Solana.</div>
        </div>
        <div style={{ display: 'flex', fontSize: 28, color: '#9a9aa2' }}>Orders collect, then everyone pays one clearing price. Every result can be recomputed from the chain.</div>
      </div>
    ),
    size,
  );
}
