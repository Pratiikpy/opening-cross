// Text normalisation for impersonation checks. Pure and deterministic.
//
// A forged token copies a genuine name or ticker with characters that read the same to a person: Cyrillic or
// Greek letters, zero-width characters, a zero for an O, a one for an L. Both sides of every comparison go through
// the same fold, so the forgery and the original produce the same skeleton.

/** Letters from other scripts that render like Latin letters. Lower-case Latin on the right. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a', в: 'b', с: 'c', ԁ: 'd', е: 'e', һ: 'h', і: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', ԛ: 'q', ѕ: 's', т: 't', ѵ: 'v', ԝ: 'w', х: 'x', у: 'y',
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ϲ: 'c', ϳ: 'j',
  // Latin look-alikes outside ASCII
  ı: 'i', ɡ: 'g', ɑ: 'a', ɩ: 'i', ƅ: 'b', ǀ: 'l', ꞵ: 'b',
};

const INVISIBLE_CLASS = '[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]';
const INVISIBLE = new RegExp(INVISIBLE_CLASS, 'u');
const INVISIBLE_ALL = new RegExp(INVISIBLE_CLASS, 'gu');
const COMBINING = /\p{M}/gu;

export interface Look {
  /** Letters and digits only, lower-case, other-script and invisible characters folded. `TSLA-x` and `Tѕlax` both give `tslax`. */
  readonly skeleton: string;
  /** The skeleton with the look-alike swaps a person reads past as well: 0 for o, 1 and I for l. `AIon` and `ALON` match. */
  readonly loose: string;
  /** Distinctive words of the text, folded the same way, for brand matching. */
  readonly words: readonly string[];
  /** Whether any character had to be folded from another script or was invisible: a forgery signal by itself. */
  readonly disguised: boolean;
}

export function lookOf(text: string): Look {
  let disguised = INVISIBLE.test(text);
  const base = text.normalize('NFKD').replace(INVISIBLE_ALL, '').replace(COMBINING, '').toLowerCase();
  let folded = '';
  for (const ch of base) {
    const mapped = CONFUSABLE[ch];
    if (mapped !== undefined) {
      folded += mapped;
      disguised = true;
    } else {
      folded += ch;
    }
  }
  const skeleton = folded.replace(/[^\p{L}\p{N}]/gu, '');
  // Applied on top of the strict skeleton, never instead of it: two honest tickers can differ only by an I and an L.
  const loose = skeleton.replace(/0/g, 'o').replace(/[1|i]/g, 'l');
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return { skeleton, loose, words, disguised };
}
