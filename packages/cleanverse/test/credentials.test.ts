import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SANDBOX_URL } from '../src/client.js';
import { loadCredentials, parseEnvFile } from '../src/credentials.js';

describe('credentials', () => {
  it('parses env-style files with comments, quotes and export', () => {
    expect(parseEnvFile('# c\nappId=abc\nexport apiKey = "k=="\nCLEANVERSE_BASE_URL: https://x\n\nbad line')).toEqual({ APPID: 'abc', APIKEY: 'k==', CLEANVERSE_BASE_URL: 'https://x' });
  });
  it('prefers the environment, then the file, and defaults to the sandbox host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv-'));
    try {
      const f = join(dir, 'cleanverse.env');
      writeFileSync(f, 'appId=fileid\napiKey=ZmlsZWtleQ==\n');
      const fromFile = loadCredentials({}, f);
      expect(fromFile.config).toEqual({ baseUrl: SANDBOX_URL, apiId: 'fileid', apiKey: 'ZmlsZWtleQ==' });
      const fromEnv = loadCredentials({ CLEANVERSE_API_ID: 'envid', CLEANVERSE_API_KEY: 'ZW52' }, f);
      expect(fromEnv).toEqual({ config: { baseUrl: SANDBOX_URL, apiId: 'envid', apiKey: 'ZW52' }, source: 'environment' });
      writeFileSync(f, 'appId=only\n');
      const partial = loadCredentials({}, f);
      expect(partial.config).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reports a missing file without throwing and without echoing values', () => {
    const r = loadCredentials({}, join(tmpdir(), 'does-not-exist', 'cleanverse.env'));
    expect(r.config).toBeNull();
    expect((r as { reason: string }).reason).toContain('no readable file');
  });
});
