import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// The same mark as icon.svg: a bar crossed by one price line.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', background: '#0b0b0f', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <div style={{ position: 'absolute', left: 28, right: 28, top: 85, height: 10, background: '#f4f4f2' }} />
        <div style={{ position: 'absolute', left: 70, width: 40, top: 50, height: 80, background: '#e8430c' }} />
      </div>
    ),
    size,
  );
}
