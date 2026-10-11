import { describe, expect, it } from 'vitest';
import { BUNDLED_REGISTRY, type MintObservation, type Fingerprint, classifyMint, endsOf, lookOf, loadBundledBook, parseCsv } from '../../src/index.js';

const book = loadBundledBook();
const rule = (f: 'xstock' | 'ondo'): Fingerprint => {
  const r = book.rules.get(f)!;
  return Object.fromEntries(Object.entries(r.accepted).map(([k, v]) => [k, v![0]!])) as Fingerprint;
};
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Valid base58, not listed.
const STRANGER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const obs = (o: Partial<MintObservation> & { mint: string }): MintObservation => ({
  exists: true, owner: TOKEN_2022, isMint: true, decimals: 8, fingerprint: {}, name: null, symbol: null, ...o,
});

describe('normalise', () => {
  it('folds case, punctuation, other-script letters and invisible characters to one skeleton', () => {
    for (const t of ['TSLAx', 'tslax', 'TSLA-x', 'TSLA.x', 'TЅLAx', 'TS​LAx']) expect(lookOf(t).skeleton).toBe('tslax');
    expect(lookOf('TЅLAx').disguised).toBe(true);
    expect(lookOf('TSLAx').disguised).toBe(false);
  });
});

describe('the registry snapshot', () => {
  it('lists every mint once and covers both stock families from the issuers own lists', () => {
    expect(book.entries.length).toBe(BUNDLED_REGISTRY.mints.length);
    expect(book.coverage).toEqual({ xstock: true, ondo: true, canonical: true });
    expect(book.entries.filter((e) => e.mint.family === 'xstock').length).toBeGreaterThan(1000);
    expect(book.entries.filter((e) => e.mint.family === 'ondo').length).toBeGreaterThan(400);
    expect(book.byMint.get(TSLAX)?.mint.symbol).toBe('TSLAx');
  });
});

describe('classifyMint', () => {
  it('passes a listed xStock whose authorities are the issuer keys', () => {
    const v = classifyMint(book, obs({ mint: TSLAX, fingerprint: rule('xstock'), name: 'Tesla xStock', symbol: 'TSLAx' }));
    expect(v.verdict).toBe('GENUINE');
    expect(v.listing?.symbol).toBe('TSLAx');
    expect(v.reasons.map((r) => r.code)).toEqual(['ISSUER_LISTED', 'AUTHORITIES_MATCH_ISSUER']);
  });

  it('never trusts a listing over the chain: a listed address held by a stranger is UNKNOWN', () => {
    const v = classifyMint(book, obs({ mint: TSLAX, fingerprint: { ...rule('xstock'), MINT_AUTHORITY: STRANGER }, symbol: 'TSLAx' }));
    expect(v.verdict).toBe('UNKNOWN');
    expect(v.reasons.map((r) => r.code)).toContain('CHAIN_CONTRADICTS_LISTING');
  });

  it('refuses a listed stock token that has lost its mint authority entirely', () => {
    const fp = { ...rule('xstock') };
    delete fp.MINT_AUTHORITY;
    expect(classifyMint(book, obs({ mint: TSLAX, fingerprint: fp })).verdict).toBe('UNKNOWN');
  });

  it('calls an unlisted copy of a genuine symbol an impersonator, whatever the case or punctuation', () => {
    for (const symbol of ['TSLAx', 'tslax', 'TSLA-x', 'TSLAon', 'xTSLA', 'TЅLAx']) {
      const v = classifyMint(book, obs({ mint: STRANGER, symbol, name: 'whatever' }));
      expect(v.verdict, symbol).toBe('IMPERSONATOR');
      expect(v.impersonates.map((m) => m.mint)).toContain(TSLAX);
    }
  });

  it('flags disguised characters as their own reason', () => {
    const v = classifyMint(book, obs({ mint: STRANGER, symbol: 'TЅLAx' }));
    expect(v.reasons.map((r) => r.code)).toContain('DISGUISED_CHARACTERS');
  });

  it('catches a copied name even when the symbol is different', () => {
    const v = classifyMint(book, obs({ mint: STRANGER, symbol: 'TSL2', name: 'Tesla xStock' }));
    expect(v.verdict).toBe('IMPERSONATOR');
    expect(v.reasons.map((r) => r.code)).toContain('CLAIMS_ISSUER_NAME');
  });

  it('separates another issuers tokenized stock from a copy of a covered issuers token', () => {
    const other = classifyMint(book, obs({ mint: STRANGER, symbol: 'DJT', name: 'Trump Media & Technology Group Corp. Common Stock - Backpack Securities' }));
    expect(other.verdict).toBe('UNVERIFIED_STOCK_TOKEN');
    expect(other.reasons.map((r) => r.code)).toEqual(['SAME_COMPANY_OTHER_ISSUER']);
    expect(classifyMint(book, obs({ mint: STRANGER, symbol: 'DJT2', name: 'Trump Media & Technology Group xStock' })).verdict).toBe('IMPERSONATOR');
  });

  it('catches an unlisted USDC', () => {
    const v = classifyMint(book, obs({ mint: STRANGER, symbol: 'USDC', name: 'USD Coin' }));
    expect(v.verdict).toBe('IMPERSONATOR');
    expect(v.impersonates.map((m) => m.mint)).toContain(USDC);
  });

  it('passes the real USDC by its issuer-published address', () => {
    const v = classifyMint(book, obs({ mint: USDC, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: 6, symbol: 'USDC' }));
    expect(v.verdict).toBe('GENUINE');
  });

  it('identifies an unlisted mint held by the issuer own keys as a likely newer listing, not a forgery', () => {
    const v = classifyMint(book, obs({ mint: STRANGER, fingerprint: rule('xstock'), symbol: 'NEWx', name: 'New Company xStock' }));
    expect(v.verdict).toBe('FAMILY_UNLISTED');
  });

  it('does not accept the issuer key on only some powers: a forger holding the mint authority alone is not the issuer', () => {
    const v = classifyMint(book, obs({ mint: STRANGER, fingerprint: { MINT_AUTHORITY: rule('xstock').MINT_AUTHORITY!, PAUSE_AUTHORITY: STRANGER } }));
    expect(v.verdict).not.toBe('FAMILY_UNLISTED');
  });

  it('flags an address that copies the first and last six characters of a listed mint', () => {
    const real = NVDAX;
    const fake = real.slice(0, 6) + 'Z'.repeat(real.length - 12) + real.slice(-6);
    expect(endsOf(fake)).toBe(endsOf(real));
    const v = classifyMint(book, obs({ mint: fake }));
    expect(v.verdict).toBe('ADDRESS_LOOKALIKE');
    expect(v.impersonates[0]?.mint).toBe(real);
  });

  it('treats a symbol that differs from an issuer one only by I/l or 0/o as a resemblance, not a copy', () => {
    const v = classifyMint(book, obs({ mint: STRANGER, symbol: 'ALON', name: 'Alon' }));
    expect(v.verdict).toBe('UNRELATED_TOKEN');
    expect(v.reasons.map((r) => r.code)).toContain('RESEMBLES_ISSUER_SYMBOL');
  });

  it('leaves unrelated tokens alone, including a coin that only shares a ticker', () => {
    expect(classifyMint(book, obs({ mint: STRANGER, symbol: 'BONK', name: 'Bonk' })).verdict).toBe('UNRELATED_TOKEN');
    const shared = classifyMint(book, obs({ mint: STRANGER, symbol: 'TSLA', name: 'Tesla Inu' }));
    expect(shared.verdict).toBe('UNRELATED_TOKEN');
    expect(shared.reasons.map((r) => r.code)).toContain('TICKER_COLLISION');
  });

  it('does not mistake a short-ticker marker form for a stock token', () => {
    // Ford's xStock is "Fx": a coin written "FX" is a different token, but the exact "Fx" is a copy.
    expect(classifyMint(book, obs({ mint: STRANGER, symbol: 'FX', name: 'Some FX token' })).verdict).toBe('UNRELATED_TOKEN');
    expect(classifyMint(book, obs({ mint: STRANGER, symbol: 'Fx', name: 'Some token' })).verdict).toBe('IMPERSONATOR');
  });

  it('handles an absent account, a non-mint account, and a mint with no name', () => {
    expect(classifyMint(book, { mint: STRANGER, exists: false, owner: null, isMint: false, decimals: null, fingerprint: {}, name: null, symbol: null }).verdict).toBe('NOT_A_MINT');
    expect(classifyMint(book, obs({ mint: STRANGER, isMint: false, owner: '11111111111111111111111111111111' })).verdict).toBe('NOT_A_MINT');
    const bare = classifyMint(book, obs({ mint: STRANGER }));
    expect(bare.verdict).toBe('UNRELATED_TOKEN');
    expect(bare.reasons.map((r) => r.code)).toContain('NO_ON_CHAIN_NAME');
  });
});

describe('over every listed token', () => {
  it('passes each listed mint carrying its family fingerprint', () => {
    for (const e of book.entries) {
      const fp = e.mint.family === 'canonical' ? {} : rule(e.mint.family);
      expect(classifyMint(book, obs({ mint: e.mint.mint, fingerprint: fp })).verdict, e.mint.symbol).toBe('GENUINE');
    }
  });

  it('calls an unlisted token carrying any listed symbol an impersonator', () => {
    const misses: string[] = [];
    for (const e of book.entries) {
      const v = classifyMint(book, obs({ mint: STRANGER, symbol: e.mint.symbol, name: 'x' }));
      if (v.verdict !== 'IMPERSONATOR') misses.push(`${e.mint.symbol}: ${v.verdict}`);
    }
    expect(misses).toEqual([]);
  });
});

describe('csv', () => {
  it('reads quoted fields with commas, quotes and newlines', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"line\nbreak",z\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['line\nbreak', 'z']]);
  });
});
