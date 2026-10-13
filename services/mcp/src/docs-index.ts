// The documentation corpus behind the docs MCP server (PRODUCT_FEATURES L7, J4: "docs for humans and AI ... docs MCP").
//
// The corpus is the repository's own markdown: the README, the OCIP-1 specification, the ADRs, the configuration reference, the
// agent skill, runbooks, security documents, package READMEs and the evidence files. Documents are split into sections at
// their headings and ranked with BM25. Nothing is summarised or rewritten: a search returns the author's own words with the file
// and line, and a read returns the file. `revision` is the git commit the corpus was read at, so an answer can be matched to
// the code that exists (the "version-matched docs" of L5).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type DocKind = 'overview' | 'spec' | 'adr' | 'reference' | 'guide' | 'package' | 'evidence' | 'security' | 'runbook';

export type DocChunk = {
  readonly path: string;
  readonly title: string;
  readonly heading: string;
  readonly level: number;
  /** 1-based line of the heading in the file. */
  readonly line: number;
  readonly kind: DocKind;
  readonly text: string;
};

export type DocInfo = { readonly path: string; readonly title: string; readonly kind: DocKind; readonly bytes: number; readonly sections: readonly string[] };

export type SearchHit = { readonly path: string; readonly title: string; readonly heading: string; readonly line: number; readonly kind: DocKind; readonly score: number; readonly snippet: string };

export type DocsCorpus = { readonly revision: string; readonly files: readonly { readonly path: string; readonly kind: DocKind; readonly text: string }[] };

/** Where the corpus is read from, and how each document is classed. First match wins. */
const SOURCES: readonly { readonly match: RegExp; readonly kind: DocKind }[] = [
  { match: /^README\.md$/, kind: 'overview' },
  { match: /^PRODUCT_FEATURES\.md$/, kind: 'overview' },
  { match: /^docs\/FEATURE_STATUS\.md$/, kind: 'overview' },
  { match: /^docs\/spec\/.+\.md$/, kind: 'spec' },
  { match: /^docs\/standard\/.+\.md$/, kind: 'spec' },
  { match: /^docs\/adr\/.+\.md$/, kind: 'adr' },
  { match: /^docs\/CONFIGURATION\.md$/, kind: 'reference' },
  { match: /^docs\/economics\/.+\.md$/, kind: 'reference' },
  { match: /^docs\/agent-skill\/.+\.md$/, kind: 'guide' },
  { match: /^docs\/runbooks\/.+\.md$/, kind: 'runbook' },
  { match: /^docs\/security\/.+\.md$/, kind: 'security' },
  { match: /^docs\/evidence\/[^/]+\.md$/, kind: 'evidence' },
  { match: /^packages\/[^/]+\/README\.md$/, kind: 'package' },
  { match: /^services\/[^/]+\/README\.md$/, kind: 'package' },
  { match: /^examples\/[^/]+\/README\.md$/, kind: 'guide' },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '.next', 'research', 'colosseum-solana-resources', 'meteora-resources', 'ux_teardown', 'video', '.keys', '.secrets']);
const MAX_FILE_BYTES = 600_000;

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(root, full, out);
    else if (name.endsWith('.md') && st.size <= MAX_FILE_BYTES) out.push(relative(root, full).split(sep).join('/'));
  }
}

/** The commit `.git/HEAD` points at, or `unknown` when the corpus is not read from a git checkout. */
export function gitRevision(root: string): string {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 40);
    const ref = head.slice(5);
    const loose = join(root, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim();
    const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.split(' ')[0]! : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function readCorpus(root: string): DocsCorpus {
  const paths: string[] = [];
  walk(root, root, paths);
  const files: { path: string; kind: DocKind; text: string }[] = [];
  for (const path of paths.sort()) {
    const src = SOURCES.find((s) => s.match.test(path));
    if (src) files.push({ path, kind: src.kind, text: readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n') });
  }
  return { revision: gitRevision(root), files };
}

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

function sectionsOf(path: string, kind: DocKind, text: string): { title: string; chunks: DocChunk[] } {
  const lines = text.split('\n');
  let title = path;
  const chunks: DocChunk[] = [];
  let heading = '(top)';
  let level = 0;
  let line = 1;
  let buf: string[] = [];
  let fence = false;
  // A section longer than this is cut at line boundaries (a configuration table becomes groups of rows), so one long section
  // does not drown the short, exact one in its ranking.
  const WINDOW = 1_500;
  const flush = () => {
    let start = line;
    let piece: string[] = [];
    let size = 0;
    const emit = () => {
      const body = piece.join('\n').trim();
      if (body) chunks.push({ path, title, heading, level, line: start, kind, text: body });
      piece = [];
      size = 0;
    };
    for (const [j, l] of buf.entries()) {
      if (size + l.length > WINDOW && piece.length > 0) {
        emit();
        start = line + 1 + j;
      }
      piece.push(l);
      size += l.length + 1;
    }
    emit();
    buf = [];
  };
  for (const [i, l] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = fence ? null : HEADING.exec(l);
    if (m) {
      flush();
      level = m[1]!.length;
      heading = m[2]!.replace(/[`*]/g, '');
      line = i + 1;
      if (level === 1 && title === path) title = heading;
    } else buf.push(l);
  }
  flush();
  // The title is known only after the first heading; chunks cut before it carry the path.
  return { title, chunks: chunks.map((c) => (c.title === path ? { ...c, title } : c)) };
}

const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were will with not no do does how what when which who why can if you your we our they their than then there these those so such into over per via also any all each both more most other some only same too very'.split(' '));
export const tokenize = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

type Posting = { chunk: number; tf: number };

export class DocsIndex {
  readonly revision: string;
  readonly docs: readonly DocInfo[];
  private readonly chunks: DocChunk[] = [];
  private readonly lengths: number[] = [];
  private readonly postings = new Map<string, Posting[]>();
  private avgLen = 1;
  private readonly files: ReadonlyMap<string, string>;

  constructor(corpus: DocsCorpus) {
    this.revision = corpus.revision;
    const docs: DocInfo[] = [];
    const files = new Map<string, string>();
    for (const f of corpus.files) {
      const { title, chunks } = sectionsOf(f.path, f.kind, f.text);
      files.set(f.path, f.text);
      docs.push({ path: f.path, title, kind: f.kind, bytes: Buffer.byteLength(f.text), sections: chunks.map((c) => c.heading) });
      this.chunks.push(...chunks);
    }
    this.docs = docs;
    this.files = files;
    let total = 0;
    this.chunks.forEach((c, i) => {
      // The heading and the file name count three times: a section about "fees" should beat a passing mention.
      const tokens = [...tokenize(c.text), ...tokenize(c.heading), ...tokenize(c.heading), ...tokenize(c.heading), ...tokenize(c.path), ...tokenize(c.title)];
      this.lengths.push(tokens.length);
      total += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        const list = this.postings.get(t) ?? [];
        list.push({ chunk: i, tf: n });
        this.postings.set(t, list);
      }
    });
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
  }

  get sectionCount(): number {
    return this.chunks.length;
  }

  search(query: string, o: { limit?: number; kind?: DocKind } = {}): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const k1 = 1.2;
    const b = 0.75;
    const n = this.chunks.length;
    const scores = new Map<number, number>();
    for (const t of terms) {
      const list = this.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const p of list) {
        const len = this.lengths[p.chunk]!;
        scores.set(p.chunk, (scores.get(p.chunk) ?? 0) + (idf * p.tf * (k1 + 1)) / (p.tf + k1 * (1 - b + (b * len) / this.avgLen)));
      }
    }
    // Evidence files and the status documents restate what the reference documents define, so on equal words the definition ranks first.
    for (const [i, v] of scores) if (this.chunks[i]!.kind === 'evidence' || this.chunks[i]!.kind === 'overview') scores.set(i, v * 0.7);
    const hits = [...scores.entries()]
      .filter(([i]) => !o.kind || this.chunks[i]!.kind === o.kind)
      .sort((a, c) => c[1] - a[1] || a[0] - c[0])
      .slice(0, Math.max(1, Math.min(o.limit ?? 8, 25)));
    return hits.map(([i, score]) => {
      const c = this.chunks[i]!;
      return { path: c.path, title: c.title, heading: c.heading, line: c.line, kind: c.kind, score: Math.round(score * 1000) / 1000, snippet: snippetOf(c.text, terms) };
    });
  }

  list(o: { prefix?: string; kind?: DocKind } = {}): readonly DocInfo[] {
    return this.docs.filter((d) => (!o.prefix || d.path.startsWith(o.prefix)) && (!o.kind || d.kind === o.kind));
  }

  /** The text of a document, or of one section of it (matched on the heading, case-insensitively). Null when it is not in the corpus. */
  read(path: string, section?: string): { title: string; sections: readonly string[]; text: string; line: number } | null {
    const info = this.docs.find((d) => d.path === path);
    if (!info) return null;
    if (!section) return { title: info.title, sections: info.sections, text: this.files.get(path)!, line: 1 };
    const want = section.replace(/[`*]/g, '').toLowerCase();
    const parts = this.chunks.filter((c) => c.path === path && c.heading.toLowerCase() === want);
    const loose = parts.length ? parts : this.chunks.filter((c) => c.path === path && c.heading.toLowerCase().includes(want));
    if (loose.length === 0) return { title: info.title, sections: info.sections, text: '', line: 0 };
    return { title: info.title, sections: info.sections, text: loose.map((c) => `${'#'.repeat(Math.max(1, c.level))} ${c.heading}\n\n${c.text}`).join('\n\n'), line: loose[0]!.line };
  }
}

function snippetOf(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - 80);
  const out = flat.slice(start, start + 320);
  return `${start > 0 ? '…' : ''}${out}${start + 320 < flat.length ? '…' : ''}`;
}

export function buildIndex(root: string): DocsIndex {
  return new DocsIndex(readCorpus(root));
}
