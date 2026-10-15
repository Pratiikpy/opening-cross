// Version-matched documentation in a diagnosis (L5). The links are checked against the real source and the real documentation capture
// held in this repository, not against the table that produced them: every source link is followed to its line, every documentation
// page is in the capture's URL list, and where documentation or source is for another release than the IDL, the diagnosis says so.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS, PROGRAMS, diagnose, docsFor } from '../src/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const DAMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const RAYDIUM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const CORE = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';
const hex = (n: number) => `0x${n.toString(16)}`;

const failure = (program: string, code: number) =>
  diagnose({ err: { InstructionError: [0, { Custom: code }] }, logs: [`Program ${program} invoke [1]`, `Program ${program} failed: custom program error: ${hex(code)}`] });

const SOURCE_DIRS: Record<string, string> = {
  'MeteoraAg/dynamic-bonding-curve': 'dynamic-bonding-curve',
  'MeteoraAg/damm-v2': 'damm-v2',
  'raydium-io/raydium-cp-swap': 'raydium-cp-swap',
};
const gitIn = (repo: string, ...args: string[]) => execFileSync('git', ['-C', join(root, 'research', 'repos', SOURCE_DIRS[repo]!), ...args], { encoding: 'utf8' }).trim();

describe('the documentation attached to a diagnosis', () => {
  it('gives a bonding-curve error the documentation\'s explanation, a link to its definition, and says the releases agree', () => {
    const d = failure(DBC, 6002);
    expect(d.error.name).toBe('ExceededSlippage');
    expect(d.docs).not.toBeNull();
    expect(d.docs!.cause).toMatch(/below the minimum output/);
    expect(d.docs!.pages.map((p) => p.url)).toEqual(['https://docs.meteora.ag/developer-guides/dbc/program/errors', 'https://docs.meteora.ag/developer-guides/dbc/changelog']);
    expect(d.docs!.versions).toEqual({ idl: '0.2.1', docs: '0.2.1', source: '0.2.1', docsMatchIdl: true, sourceMatchesIdl: true });
    expect(d.docs!.sourceLink).toMatch(/^https:\/\/github\.com\/MeteoraAg\/dynamic-bonding-curve\/blob\/[0-9a-f]{40}\/programs\/dynamic-bonding-curve\/src\/error\.rs#L\d+$/);
    expect(d.docs!.note).toMatch(/the IDL's/);
  });

  it('follows every source link to the line it names, at the commit it names', () => {
    let followed = 0;
    for (const [address, d] of Object.entries(DOCS)) {
      if (!d.source) continue;
      const table = PROGRAMS.find((p) => p.address === address)!;
      expect(gitIn(d.source.repo, 'rev-parse', 'HEAD')).toBe(d.source.commit); // the link is to the commit that was read
      const text = execFileSync('git', ['-C', join(root, 'research', 'repos', SOURCE_DIRS[d.source.repo]!), 'show', `${d.source.commit}:${d.source.file}`], { encoding: 'utf8' }).split(/\r?\n/);
      for (const [code, e] of Object.entries(d.errors)) {
        if (e.line === undefined) continue;
        expect(text[e.line - 1]!, `${table.label} ${code}`).toContain(table.errors[Number(code)]![0]);
        followed++;
      }
    }
    expect(followed).toBeGreaterThan(150);
  });

  it('puts only documentation pages that exist in the capture into a diagnosis', () => {
    const urls = new Set(readFileSync(join(root, 'meteora-resources', 'urls.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()));
    let pages = 0;
    for (const d of Object.values(DOCS)) {
      for (const p of d.pages) {
        expect(urls.has(`${p.url}.md`), p.url).toBe(true);
        pages++;
      }
    }
    expect(pages).toBe(8);
  });

  it('attaches the documentation\'s words only where the documentation and the IDL name the same error at the same code', () => {
    for (const [address, d] of Object.entries(DOCS)) {
      const table = PROGRAMS.find((p) => p.address === address)!;
      for (const code of Object.keys(d.errors)) expect(table.errors[Number(code)], `${table.label} ${code}`).toBeDefined();
    }
    // 73 DAMM v2 errors in the IDL; each documented one carries a cause.
    expect(Object.values(DOCS[DAMM]!.errors).filter((e) => e.cause).length).toBeGreaterThan(60);
  });

  it('says so when the documentation and the source are for another release than the IDL', () => {
    const d = failure(DAMM, 6002).docs!;
    expect(d.versions).toEqual({ idl: '0.2.5', docs: '0.2.4', source: '0.2.4', docsMatchIdl: false, sourceMatchesIdl: false });
    expect(d.note).toMatch(/latest release is 0\.2\.4 but the IDL is 0\.2\.5/);
    expect(d.note).toMatch(/line numbers may have moved/);
    expect(d.cause).not.toBeNull();
    expect(d.sourceLink).not.toBeNull();
  });

  it('for DLMM, which has documentation but no source here, says where in the program each error is raised', () => {
    const slippage = PROGRAMS.find((p) => p.address === DLMM)!;
    const code = Number(Object.entries(slippage.errors).find(([, e]) => e[0] === 'ExceededAmountSlippageTolerance')?.[0] ?? NaN);
    expect(Number.isInteger(code)).toBe(true);
    const d = failure(DLMM, code).docs!;
    expect(d.sourceLink).toBeNull();
    expect(d.raisedIn).toMatch(/swap2/);
    expect(d.raisedIn).not.toMatch(/[\\<>]/); // the documentation's HTML list and escaped underscores are plain text here
    expect(d.cause).toMatch(/slippage limit/);
    expect(d.versions.source).toBeNull();
    expect(d.versions.docsMatchIdl).toBe(true);
  });

  it('for Raydium, which has source but no documentation here, links the source and never a page', () => {
    const d = failure(RAYDIUM, 6000).docs!;
    expect(d.pages).toEqual([]);
    expect(d.cause).toBeNull();
    expect(d.sourceLink).toMatch(/raydium-io\/raydium-cp-swap\/blob\/[0-9a-f]{40}\/programs\/cp-swap\/src\/error\.rs#L\d+/);
    expect(d.versions).toMatchObject({ idl: '0.2.0', source: '0.2.0', docs: null, docsMatchIdl: null, sourceMatchesIdl: true });
  });

  it('attaches nothing to an error of a program it holds no documentation for, to framework errors and to runtime errors', () => {
    expect(failure(CORE, 6000).docs).toBeNull();
    expect(failure(DBC, 3012).docs).toBeNull(); // an Anchor framework error: AccountNotInitialized
    expect(diagnose({ err: { InstructionError: [0, 'ComputationalBudgetExceeded'] }, logs: [] }).docs).toBeNull();
    expect(diagnose({ err: 'BlockhashNotFound', logs: [] }).docs).toBeNull();
    expect(docsFor(CORE, 6000)).toBeNull();
  });

  it('for a code the documentation does not list, still offers the pages and says that no explanation is attached', () => {
    const d = failure(DBC, 6999).docs!;
    expect(d.cause).toBeNull();
    expect(d.sourceLink).toBeNull();
    expect(d.pages).toHaveLength(2);
    expect(d.note).toMatch(/no explanation is attached/);
  });
});
