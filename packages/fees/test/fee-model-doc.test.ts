// docs/economics/FEE_MODEL.md carries tables generated from the model. If the model or the proposed rates change and the
// document is not regenerated (pnpm --filter @opening-cross/fees model), this fails.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BLOCKS, renderDocument } from '../src/index.js';

const doc = readFileSync(fileURLToPath(new URL('../../../docs/economics/FEE_MODEL.md', import.meta.url)), 'utf8');

describe('FEE_MODEL.md', () => {
  it('is exactly what the model renders', () => {
    expect(renderDocument(doc)).toBe(doc);
  });

  it('holds every table the model can render', () => {
    for (const name of Object.keys(BLOCKS)) expect(doc).toContain(`<!-- generated:${name} -->`);
  });

  it('states no figure for a competitor it could not verify', () => {
    expect(doc).toMatch(/MetaDAO launchpad \| NOT VERIFIED/);
  });
});
