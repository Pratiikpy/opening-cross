import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, type TextInputProps, type TextStyle, View, type ViewStyle } from 'react-native';
import { FONT, useTheme } from './theme';

type Variant = 'title' | 'heading' | 'body' | 'small' | 'label' | 'mono' | 'monoBig';

export function Txt({ variant = 'body', tone = 'ink', style, children, ...rest }: { variant?: Variant; tone?: 'ink' | 'muted' | 'subtle' | 'accent' | 'positive'; style?: TextStyle; children: ReactNode; numberOfLines?: number; selectable?: boolean }) {
  const t = useTheme();
  const color = tone === 'ink' ? t.ink : tone === 'muted' ? t.muted : tone === 'subtle' ? t.subtle : tone === 'accent' ? t.accentText : t.positive;
  const base: Record<Variant, TextStyle> = {
    title: { fontFamily: FONT.semibold, fontSize: 30, lineHeight: 34, letterSpacing: -0.9 },
    heading: { fontFamily: FONT.medium, fontSize: 17, lineHeight: 22 },
    body: { fontFamily: FONT.regular, fontSize: 15, lineHeight: 21 },
    small: { fontFamily: FONT.regular, fontSize: 13, lineHeight: 18 },
    label: { fontFamily: FONT.mono, fontSize: 11, lineHeight: 14, letterSpacing: 1.6, textTransform: 'uppercase' },
    mono: { fontFamily: FONT.mono, fontSize: 14, lineHeight: 20 },
    monoBig: { fontFamily: FONT.semibold, fontSize: 44, lineHeight: 48, letterSpacing: -1.4 },
  };
  return (
    <Text {...rest} style={[base[variant], { color }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[{ borderWidth: 1, borderColor: t.border, borderRadius: 20, padding: 18, backgroundColor: t.bg }, style]}>{children}</View>;
}

export function Button({ label, onPress, disabled, busy, variant = 'primary' }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean; variant?: 'primary' | 'secondary' }) {
  const t = useTheme();
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: t.accentFill } : { borderWidth: 1, borderColor: t.borderStrong },
        { opacity: disabled ? 0.45 : pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={primary ? t.onAccent : t.ink} /> : null}
      <Text style={{ fontFamily: FONT.medium, fontSize: 15, color: primary ? t.onAccent : t.ink }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, error, ...input }: { label: string; error?: string | null } & TextInputProps) {
  const t = useTheme();
  return (
    <View style={{ marginTop: 14 }}>
      <Txt variant="small" tone="muted">
        {label}
      </Txt>
      <TextInput
        {...input}
        accessibilityLabel={label}
        placeholderTextColor={t.subtle}
        style={{ marginTop: 6, borderWidth: 1, borderColor: error ? t.accent : t.borderStrong, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontFamily: FONT.mono, fontSize: 16, color: t.ink, backgroundColor: t.bg }}
      />
      {error ? (
        <Txt variant="small" tone="accent" style={{ marginTop: 4 }}>
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

export function Pill({ label, tone = 'plain' }: { label: string; tone?: 'plain' | 'good' | 'bad' | 'live' }) {
  const t = useTheme();
  const color = tone === 'good' ? t.positive : tone === 'bad' || tone === 'live' ? t.accentText : t.muted;
  const border = tone === 'good' ? t.positive : tone === 'bad' || tone === 'live' ? t.accent : t.border;
  return (
    <View style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: tone === 'good' ? t.positiveBg : 'transparent' }}>
      <Text style={{ fontFamily: FONT.medium, fontSize: 12, color }}>{label}</Text>
    </View>
  );
}

export function Notice({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'error' }) {
  const t = useTheme();
  return (
    <View accessibilityRole={tone === 'error' ? 'alert' : undefined} style={{ borderRadius: 14, padding: 14, backgroundColor: t.surface, borderWidth: 1, borderColor: tone === 'error' ? t.accent : t.border }}>
      <Txt variant="small" tone={tone === 'error' ? 'accent' : 'muted'}>
        {children}
      </Txt>
    </View>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, minWidth: '45%', marginTop: 14 }}>
      <Txt variant="small" tone="muted">
        {label}
      </Txt>
      <Txt variant="mono" style={{ marginTop: 2 }}>
        {value}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 48, borderRadius: 999, paddingHorizontal: 20, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10 },
});
