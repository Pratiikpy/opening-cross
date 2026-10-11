// Opening Bell brand kit, taken from apps/web/src/app/globals.css (itself from the Claude Design exports).
import { loadFont as loadHanken } from '@remotion/google-fonts/HankenGrotesk';
import { loadFont as loadPlex } from '@remotion/google-fonts/IBMPlexMono';

const hanken = loadHanken('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] });
const plex = loadPlex('normal', { weights: ['400', '500'], subsets: ['latin'] });

export const FONT = hanken.fontFamily;
export const MONO = plex.fontFamily;
export const fontsReady = Promise.all([hanken.waitUntilDone(), plex.waitUntilDone()]);

export type Mode = 'light' | 'dark';

export const THEME = {
  light: { bg: '#ffffff', surface: '#f7f7f8', surface2: '#eeeef0', ink: '#0b0b0f', muted: '#5a5a62', subtle: '#6b6b74', border: '#e4e4e8', borderStrong: '#8a8a93', accent: '#e8430c', accentText: '#c2380a', positive: '#17703f', positiveBg: '#e9f6ee' },
  dark: { bg: '#0b0b0f', surface: '#17171c', surface2: '#26262d', ink: '#f4f4f2', muted: '#9a9aa2', subtle: '#8a8a93', border: '#26262d', borderStrong: '#6b6b74', accent: '#ff6a3d', accentText: '#ff7a4a', positive: '#5fd08f', positiveBg: '#12291c' },
} as const;

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
