// Where the documents come from: the repository checkout (the default), or a corpus file written by `docs:corpus` for a host that has
// no checkout. Only the kinds the operator publishes are kept; the rest never enter the index, so no search or read can reach them.
import { readFileSync } from 'node:fs';
import { type DocKind, DocsIndex, readCorpus } from '@opening-cross/mcp';
import { ALL_KINDS, DEFAULT_KINDS } from './app.js';

export function parseKinds(raw: string | undefined): DocKind[] {
  if (!raw || raw.trim() === '') return [...DEFAULT_KINDS];
  const kinds = raw.split(',').map((k) => k.trim()).filter(Boolean);
  const bad = kinds.filter((k) => !(ALL_KINDS as readonly string[]).includes(k));
  if (bad.length > 0) throw new Error(`DOCS_KINDS has unknown kinds: ${bad.join(', ')}. Known: ${ALL_KINDS.join(', ')}`);
  return kinds as DocKind[];
}

export function loadIndex(o: { root: string; corpusFile?: string | undefined; kinds: readonly DocKind[] }): DocsIndex {
  const corpus = o.corpusFile ? (JSON.parse(readFileSync(o.corpusFile, 'utf8')) as ReturnType<typeof readCorpus>) : readCorpus(o.root);
  return new DocsIndex({ revision: corpus.revision, files: corpus.files.filter((f) => o.kinds.includes(f.kind)) });
}
