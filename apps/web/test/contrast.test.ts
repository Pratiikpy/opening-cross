// WCAG AA for every token pairing the UI uses, in both themes (ROADMAP W1, decision 6).
// Body text ≥ 4.5:1; large text, icons, borders of controls and chart marks ≥ 3:1.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
function theme(selector: string): Record<string, string> {
  const block = css.slice(css.indexOf(selector)).match(/\{([^}]*)\}/)![1]!;
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
}
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const TEXT: [string, string][] = [
  ['ink', 'bg'], ['ink', 'surface'], ['ink', 'surface-2'], ['muted', 'bg'], ['muted', 'surface'], ['subtle', 'bg'], ['subtle', 'surface'],
  ['accent-text', 'bg'], ['accent-text', 'surface'], ['on-accent', 'accent-fill'], ['positive', 'positive-bg'], ['positive', 'bg'],
  ['inverse-ink', 'inverse-bg'], ['inverse-muted', 'inverse-bg'], ['accent', 'inverse-bg'],
];
const UI: [string, string][] = [['accent', 'bg'], ['accent', 'surface'], ['border-strong', 'bg'], ['border-strong', 'surface'], ['focus', 'bg'], ['accent-fill', 'bg']];

describe.each([['light', ':root {'], ['dark', ':root[data-theme="dark"] {']])('%s theme', (_name, selector) => {
  const t = theme(selector);
  it.each(TEXT)('text %s on %s ≥ 4.5:1', (fg, bg) => expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5));
  it.each(UI)('UI %s on %s ≥ 3:1', (fg, bg) => expect(ratio(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(3));
});
