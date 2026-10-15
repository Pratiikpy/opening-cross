// The pages a person reads: a search page, a document and a not-found page. Server-rendered, no script at all, light and dark by the
// reader's setting, readable down to a phone. Every value that came from a document or from the address is escaped.
import type { DocInfo, DocKind, SearchHit } from '@opening-cross/mcp';
import { escapeHtml as e } from './markdown.js';

export const KIND_LABEL: Record<DocKind, string> = {
  overview: 'Overview',
  spec: 'Specification',
  adr: 'Decisions (ADRs)',
  reference: 'Reference',
  guide: 'Guides',
  package: 'Packages and services',
  evidence: 'Evidence',
  security: 'Security',
  runbook: 'Runbooks',
};
const KIND_ORDER: DocKind[] = ['overview', 'spec', 'reference', 'guide', 'adr', 'package', 'evidence', 'security', 'runbook'];

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--surface:#f7f7f8;--ink:#0b0b0f;--muted:#5a5a62;--border:#d7d7dc;--accent:#c2380a;--link:#a8320a}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0f;--surface:#17171c;--ink:#f4f4f2;--muted:#a3a3ab;--border:#34343c;--accent:#ff7a4a;--link:#ff8d63}}
*{box-sizing:border-box}html{background:var(--bg);color:var(--ink)}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--link);text-underline-offset:3px}a:focus-visible,input:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
header,main,footer{max-width:900px;margin:0 auto;padding:0 16px}
header{padding-top:20px;padding-bottom:12px;display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
header a.brand{font-weight:650;color:var(--ink);text-decoration:none}
nav a{margin-right:16px}
main{padding-top:24px;padding-bottom:48px}
h1{font-size:30px;line-height:1.2;margin:0 0 8px}h2{font-size:22px;margin:32px 0 8px}h3{font-size:18px}h4,h5,h6{font-size:16px}
.lede{color:var(--muted);margin:0 0 20px;max-width:62ch}
form.search{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 24px}
form.search input[type=search]{flex:1 1 260px;min-width:0;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
form.search select,form.search button{padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit}
form.search button{background:var(--ink);color:var(--bg);border-color:var(--ink);cursor:pointer}
.hit{padding:14px 0;border-top:1px solid var(--border)}.hit h3{margin:0 0 2px}.hit p{margin:4px 0;color:var(--muted);overflow-wrap:anywhere}
.meta{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.kinds{columns:2 280px;gap:24px}.kinds section{break-inside:avoid;margin-bottom:20px}.kinds h3{margin:0 0 4px}.kinds ul{margin:0;padding-left:18px}
pre{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;overflow:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
code{font:0.92em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface);padding:1px 4px;border-radius:4px}pre code{background:none;padding:0}
blockquote{margin:12px 0;padding:2px 16px;border-left:3px solid var(--border);color:var(--muted)}
.table{overflow-x:auto;margin:12px 0}table{border-collapse:collapse;min-width:100%}th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--surface)}
article{overflow-wrap:anywhere}article img{max-width:100%}
.toc{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 16px;margin:16px 0}.toc ul{margin:4px 0;padding-left:18px}
footer{padding-top:16px;padding-bottom:32px;border-top:1px solid var(--border);color:var(--muted);font-size:14px}
.sr{position:absolute;left:-9999px}
`;

export function layout(o: { title: string; body: string; revision: string; description?: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(o.title)}</title>
<meta name="description" content="${e(o.description ?? 'The Opening Cross documentation: specification, decisions, reference, runbooks and the evidence behind each claim.')}">
<link rel="alternate" type="text/plain" href="/llms.txt" title="For AI agents">
<style>${CSS}</style></head>
<body><a class="sr" href="#main">Skip to content</a>
<header><a class="brand" href="/">Opening Cross documentation</a><nav aria-label="Site"><a href="/">Search</a><a href="/llms.txt">For AI agents</a></nav></header>
<main id="main">${o.body}</main>
<footer>Read from the repository at revision <code>${e(o.revision.slice(0, 12))}</code>. Every page is the author's own text; nothing is summarised.</footer>
</body></html>`;
}

const docHref = (path: string, section?: string): string => `/doc?path=${encodeURIComponent(path)}${section ? `&section=${encodeURIComponent(section)}` : ''}`;

export function searchPage(o: { revision: string; docs: readonly DocInfo[]; kinds: readonly DocKind[]; query: string; kind: string; hits: readonly SearchHit[] | null }): string {
  const options = ['<option value="">All kinds</option>', ...o.kinds.map((k) => `<option value="${k}"${o.kind === k ? ' selected' : ''}>${e(KIND_LABEL[k])}</option>`)].join('');
  const form = `<form class="search" role="search" action="/" method="get"><label class="sr" for="q">Search the documentation</label><input id="q" type="search" name="q" value="${e(o.query)}" placeholder="clearing price tie break, OWN_WALLETS, sealed bid reveal" maxlength="200" autocomplete="off"><label class="sr" for="kind">Kind of document</label><select id="kind" name="kind">${options}</select><button type="submit">Search</button></form>`;
  let results = '';
  if (o.hits) {
    results = o.hits.length === 0
      ? `<p role="status">No section matches “${e(o.query)}”. Try fewer or different words.</p>`
      : `<h2>${o.hits.length} result${o.hits.length === 1 ? '' : 's'}</h2>${o.hits
          .map((h) => `<div class="hit"><h3><a href="${e(docHref(h.path, h.heading === '(top)' ? undefined : h.heading))}">${e(h.title)}${h.heading !== '(top)' && h.heading !== h.title ? `: ${e(h.heading)}` : ''}</a></h3><p class="meta">${e(h.path)}:${h.line} · ${e(KIND_LABEL[h.kind])}</p><p>${e(h.snippet)}</p></div>`)
          .join('')}`;
  }
  const grouped = KIND_ORDER.filter((k) => o.kinds.includes(k))
    .map((k) => ({ k, docs: o.docs.filter((d) => d.kind === k) }))
    .filter((g) => g.docs.length > 0);
  const index = o.hits
    ? ''
    : `<h2>Every document</h2><div class="kinds">${grouped.map((g) => `<section><h3>${e(KIND_LABEL[g.k])} (${g.docs.length})</h3><ul>${g.docs.map((d) => `<li><a href="${e(docHref(d.path))}">${e(d.title)}</a></li>`).join('')}</ul></section>`).join('')}</div>`;
  return layout({
    title: o.query ? `${o.query}: search · Opening Cross documentation` : 'Opening Cross documentation',
    revision: o.revision,
    body: `<h1>Opening Cross documentation</h1><p class="lede">The specification, the decisions behind it, the configuration reference, runbooks and the evidence for each claim. For an AI agent, the same documents are served over MCP: see <a href="/llms.txt">/llms.txt</a>.</p>${form}${results}${index}`,
  });
}

export function docPage(o: { revision: string; path: string; title: string; kind: DocKind; section: string | null; line: number; html: string; toc: { level: number; text: string; id: string }[]; truncated: boolean; sections: readonly string[] }): string {
  const toc = o.section === null && o.toc.filter((h) => h.level === 2).length > 2
    ? `<nav class="toc" aria-label="On this page"><strong>On this page</strong><ul>${o.toc.filter((h) => h.level === 2).map((h) => `<li><a href="#${e(h.id)}">${e(h.text)}</a></li>`).join('')}</ul></nav>`
    : '';
  // A section is shown under its document's title, so every page has one top-level heading and a reader knows where they are.
  const crumbs = o.section !== null ? `<h1>${e(o.title)}</h1><p><a href="${e(docHref(o.path))}">Read the whole document</a></p>` : '';
  return layout({
    title: `${o.title}${o.section ? `: ${o.section}` : ''} · Opening Cross documentation`,
    revision: o.revision,
    body: `<p class="meta">${e(o.path)}${o.section ? `:${o.line}` : ''} · ${e(KIND_LABEL[o.kind])} · <a href="/v1/docs/read?path=${encodeURIComponent(o.path)}${o.section ? `&section=${encodeURIComponent(o.section)}` : ''}">raw text (JSON)</a></p>${crumbs}${toc}<article>${o.html}</article>${o.truncated ? '<p role="status"><strong>This document is long and was cut here.</strong> Open a section from the list on this page to read the rest.</p>' : ''}`,
  });
}

export function notFoundPage(revision: string, what: string): string {
  return layout({ title: 'Not found · Opening Cross documentation', revision, body: `<h1>Not found</h1><p>${e(what)}</p><p><a href="/">Search the documentation</a></p>` });
}
