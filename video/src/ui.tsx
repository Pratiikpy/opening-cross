// Shared building blocks for the film. Every scene animates from a normalised progress p in [0, 1] over its own
// length, so the same scene plays at 15 seconds in the full film and at 8 in the short cut.
import { type CSSProperties, type ReactNode, createContext, useContext } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT, MONO, type Mode, THEME } from './brand';

export const outExpo = Easing.bezier(0.16, 1, 0.3, 1);
export const inOut = Easing.bezier(0.65, 0, 0.35, 1);

/** Progress of a beat that starts at `start` and lasts `dur`, both as fractions of the scene. */
export function beat(p: number, start: number, dur: number, easing: (t: number) => number = outExpo): number {
  return interpolate(p, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing });
}

/** A timeline tells each scene how long its own slot is; on its own, a scene is the whole composition. */
export const SceneLength = createContext<number | null>(null);
/** True for the final scene of a timeline, the only one that fades out; the others are covered by the next scene fading in. */
export const LastScene = createContext<boolean>(true);

export function useScene(): { p: number; frame: number; fps: number; total: number } {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const slot = useContext(SceneLength);
  const total = slot ?? durationInFrames;
  return { p: frame / Math.max(1, total - 1), frame, fps, total };
}

export function Stage({ mode, children, grid = true }: { mode: Mode; children: ReactNode; grid?: boolean }) {
  const t = THEME[mode];
  const { frame, total } = useScene();
  const last = useContext(LastScene);
  const fade = interpolate(frame, [0, 8, total - 8, total], [0, 1, 1, last ? 0 : 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: t.bg, color: t.ink, fontFamily: FONT, opacity: fade, overflow: 'hidden' }}>
      {grid ? (
        <AbsoluteFill
          style={{
            backgroundImage: `linear-gradient(${t.border} 1px, transparent 1px), linear-gradient(90deg, ${t.border} 1px, transparent 1px)`,
            backgroundSize: '96px 96px',
            opacity: mode === 'light' ? 0.55 : 0.4,
            maskImage: 'radial-gradient(ellipse at 50% 45%, black 25%, transparent 78%)',
            WebkitMaskImage: 'radial-gradient(ellipse at 50% 45%, black 25%, transparent 78%)',
          }}
        />
      ) : null}
      {children}
    </AbsoluteFill>
  );
}

export function Appear({ p, start, dur = 0.12, y = 24, children, style }: { p: number; start: number; dur?: number; y?: number; children: ReactNode; style?: CSSProperties }) {
  const b = beat(p, start, dur);
  return <div style={{ opacity: b, transform: `translateY(${(1 - b) * y}px)`, ...style }}>{children}</div>;
}

export function Eyebrow({ mode, children }: { mode: Mode; children: ReactNode }) {
  return <div style={{ fontFamily: MONO, fontSize: 24, letterSpacing: 4, textTransform: 'uppercase', color: THEME[mode].accentText, fontWeight: 500 }}>{children}</div>;
}

export function Headline({ mode, children, size = 92, width = 1300 }: { mode: Mode; children: ReactNode; size?: number; width?: number }) {
  return <div style={{ fontSize: size, lineHeight: 1.04, fontWeight: 600, letterSpacing: -size * 0.025, maxWidth: width, color: THEME[mode].ink }}>{children}</div>;
}

export function Sub({ mode, children, size = 34, width = 1100 }: { mode: Mode; children: ReactNode; size?: number; width?: number }) {
  return <div style={{ fontSize: size, lineHeight: 1.35, color: THEME[mode].muted, maxWidth: width, fontWeight: 400 }}>{children}</div>;
}

export function Mono({ mode, children, size = 28, color }: { mode: Mode; children: ReactNode; size?: number; color?: string }) {
  return <span style={{ fontFamily: MONO, fontSize: size, color: color ?? THEME[mode].ink }}>{children}</span>;
}

/** The Opening Bell mark: a bar crossed by one price line. */
export function Mark({ mode, width = 88, draw = 1 }: { mode: Mode; width?: number; draw?: number }) {
  const t = THEME[mode];
  const h = (width * 12) / 22;
  return (
    <svg width={width} height={h} viewBox="0 0 22 12" style={{ overflow: 'visible' }}>
      <rect x="0" y="5" width={22 * draw} height="2" fill={t.ink} />
      <rect x="7" y={6 - 6 * draw} width="8" height={12 * draw} fill={t.accent} />
    </svg>
  );
}

export function Logo({ mode, size = 40 }: { mode: Mode; size?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.4, fontSize: size, fontWeight: 600, letterSpacing: -size * 0.03, color: THEME[mode].ink }}>
      <Mark mode={mode} width={size * 1.1} />
      opening bell
    </div>
  );
}

/** A real screen of the product in a window frame, panned and zoomed between keyframes. */
export function Shot({
  mode,
  src,
  width,
  height,
  from,
  to,
  p,
  start = 0,
  dur = 1,
  radius = 22,
}: {
  mode: Mode;
  src: string;
  /** Size of the visible window on the canvas. */
  width: number;
  height: number;
  /** Camera on the source image, as a fraction of its width (x, y of the top-left) and a zoom where 1 fits the width. */
  from: { x: number; y: number; zoom: number };
  to: { x: number; y: number; zoom: number };
  p: number;
  start?: number;
  dur?: number;
  radius?: number;
}) {
  const t = THEME[mode];
  const k = beat(p, start, dur, inOut);
  const cam = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, zoom: from.zoom + (to.zoom - from.zoom) * k };
  const imgWidth = width * cam.zoom;
  return (
    <div style={{ width, height, borderRadius: radius, overflow: 'hidden', border: `2px solid ${t.border}`, background: t.surface, boxShadow: mode === 'light' ? '0 40px 120px rgba(11,11,15,0.18)' : '0 40px 120px rgba(0,0,0,0.6)', position: 'relative' }}>
      <Img src={staticFile(src)} style={{ position: 'absolute', left: -cam.x * imgWidth, top: -cam.y * imgWidth, width: imgWidth, maxWidth: 'none' }} />
    </div>
  );
}

export function Chip({ mode, children, tone = 'plain' }: { mode: Mode; children: ReactNode; tone?: 'plain' | 'good' | 'bad' | 'warn' }) {
  const t = THEME[mode];
  const color = tone === 'good' ? t.positive : tone === 'bad' ? t.accentText : tone === 'warn' ? t.muted : t.ink;
  const border = tone === 'good' ? t.positive : tone === 'bad' ? t.accent : t.borderStrong;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, border: `2px solid ${border}`, color, borderRadius: 999, padding: '8px 22px', fontSize: 26, fontWeight: 500, background: tone === 'good' ? t.positiveBg : 'transparent' }}>
      {children}
    </span>
  );
}

/** A number that counts up to its value. */
export function Count({ p, start, dur = 0.3, to, format }: { p: number; start: number; dur?: number; to: number; format?: (n: number) => string }) {
  const v = Math.round(to * beat(p, start, dur));
  return <>{format ? format(v) : v.toLocaleString('en-US')}</>;
}

export function Caption({ mode, children }: { mode: Mode; children: ReactNode }) {
  return <div style={{ fontFamily: MONO, fontSize: 22, color: THEME[mode].subtle, letterSpacing: 1 }}>{children}</div>;
}
