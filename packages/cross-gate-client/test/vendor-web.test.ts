import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain ES module without declarations
import { differences, expected, rewrite } from '../scripts/vendor-web.mjs';

describe('the web app\'s copy of the client', () => {
  it('is current: no file missing, stale or left over (run `pnpm vendor:web` after changing src)', () => {
    expect(differences()).toEqual({ missing: [], extra: [], changed: [] });
  });

  it('differs from the source only in the relative import specifiers', () => {
    const copy = expected() as Map<string, string>;
    expect(copy.size).toBeGreaterThan(80);
    for (const text of copy.values()) expect(text).not.toMatch(/from '\.{1,2}\/[^']*\.js'/);
  });

  it('drops the extension from relative imports and re-exports and touches nothing else', () => {
    expect(rewrite("import { a } from './a.js';\nexport * from '../b/index.js';\nexport { c } from \"./c.js\";")).toBe("import { a } from './a';\nexport * from '../b/index';\nexport { c } from \"./c\";");
    expect(rewrite("import x from '@solana/kit';\nimport y from 'pkg/file.js';\nconst s = './not-an-import.js';")).toBe("import x from '@solana/kit';\nimport y from 'pkg/file.js';\nconst s = './not-an-import.js';");
  });
});
