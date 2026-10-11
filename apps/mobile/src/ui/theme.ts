// Opening Bell design tokens, copied from apps/web/src/app/globals.css (which takes them from the Claude Design exports,
// darkening the orange where it carries small text so WCAG AA holds: accentText on bg, onAccent on accentFill).
import { useColorScheme } from 'react-native';

export const LIGHT = {
  bg: '#ffffff',
  surface: '#f7f7f8',
  surface2: '#eeeef0',
  ink: '#0b0b0f',
  muted: '#5a5a62',
  subtle: '#6b6b74',
  border: '#e4e4e8',
  borderStrong: '#8a8a93',
  accent: '#e8430c',
  accentFill: '#d63e0b',
  onAccent: '#ffffff',
  accentText: '#c2380a',
  positive: '#17703f',
  positiveBg: '#e9f6ee',
} as const;

export const DARK = {
  bg: '#0b0b0f',
  surface: '#17171c',
  surface2: '#26262d',
  ink: '#f4f4f2',
  muted: '#9a9aa2',
  subtle: '#8a8a93',
  border: '#26262d',
  borderStrong: '#6b6b74',
  accent: '#ff6a3d',
  accentFill: '#ff6a3d',
  onAccent: '#0b0b0f',
  accentText: '#ff7a4a',
  positive: '#5fd08f',
  positiveBg: '#12291c',
} as const;

export type Tokens = { [K in keyof typeof LIGHT]: string };

export const useTheme = (): Tokens & { dark: boolean } => {
  const dark = useColorScheme() === 'dark';
  return { ...(dark ? DARK : LIGHT), dark };
};

export const FONT = { regular: 'HankenGrotesk_400Regular', medium: 'HankenGrotesk_500Medium', semibold: 'HankenGrotesk_600SemiBold', bold: 'HankenGrotesk_700Bold', mono: 'IBMPlexMono_400Regular', monoMedium: 'IBMPlexMono_500Medium' } as const;
