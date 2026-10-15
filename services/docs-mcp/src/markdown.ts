// A small, safe markdown renderer for the documents in the repository: headings, paragraphs, lists, tables, block quotes, fenced code,
// emphasis, inline code and links. Every character of the source is escaped before any markup is added, raw HTML in a document is shown
// as text, and a link is kept only when it is http(s), a page of this site, or an anchor, so a document cannot inject script or send a
// reader to a `javascript:` address. It is not a full CommonMark implementation; what it does not understand is shown as plain text.

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The anchor id for a heading, the way a reader would expect it: lower case words joined by dashes. */
export const slug = (s: string): string => s.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Resolves a link written in the document at `from` against the corpus: a repository path becomes a page of this site. */
export type LinkResolver = (href: string) => string | null;

function inline(raw: string, link: LinkResolver): string {
  // Code spans first, so their contents are never read as emphasis or links.
  const parts = raw.split(/(`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let t = escapeHtml(part);
      t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_m, text: string, href: string) => {
        const target = link(href.replace(/&amp;/g, '&'));
        return target ? `<a href="${escapeHtml(target)}">${text}</a>` : text;
      });
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
      return t;
    })
    .join('');
}

const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/**
 * `shiftTo` renders the document's shallowest heading as that level and the rest relative to it: a section shown under its document's
 * title starts at h2, so the page's headings never skip a level.
 */
export function renderMarkdown(source: string, link: LinkResolver, opts: { shiftTo?: number } = {}): { html: string; headings: { level: number; text: string; id: string }[] } {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let offset = 0;
  if (opts.shiftTo !== undefined) {
    let fenced = false;
    let min = 7;
    for (const l of lines) {
      if (/^(```|~~~)/.test(l)) fenced = !fenced;
      const m = fenced ? null : /^(#{1,6})\s+\S/.exec(l);
      if (m) min = Math.min(min, m[1]!.length);
    }
    if (min < 7) offset = min - opts.shiftTo;
  }
  const out: string[] = [];
  const headings: { level: number; text: string; id: string }[] = [];
  const used = new Map<string, number>();
  const id = (text: string): string => {
    const base = slug(text) || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
  let i = 0;
  const startsBlock = (l: string): boolean => /^(#{1,6}\s|```|~~~|>\s?|\s*([-*+]|\d+\.)\s|\|.*\|\s*$|\s*(-{3,}|\*{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^(```|~~~)\s*([\w-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      out.push(`<pre><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = h[2]!.replace(/[`*]/g, '');
      const hid = id(text);
      const level = Math.max(1, Math.min(6, h[1]!.length - offset));
      headings.push({ level, text, id: hid });
      out.push(`<h${level} id="${escapeHtml(hid)}">${inline(h[2]!, link)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c, link)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), link).html}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[2]!) !== ordered) break;
        let item = m[3]!;
        i++;
        // A wrapped continuation line belongs to the item above it.
        while (i < lines.length && lines[i]!.trim() !== '' && /^\s{2,}\S/.test(lines[i]!) && !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[i]!)) item += ` ${lines[i++]!.trim()}`;
        items.push(`<li>${inline(item, link)}</li>`);
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines[i]!)) para.push(lines[i++]!.trim());
    out.push(`<p>${inline(para.join(' '), link)}</p>`);
  }
  return { html: out.join('\n'), headings };
}
