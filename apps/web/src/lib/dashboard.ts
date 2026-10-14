// The public dashboard (O1): what GET /v1/dashboard serves and how a page reads it. The route computes nothing: each section is the answer of a route
// that already exists, named in its `source`. This page does the same: it shows what the section holds, in the section's own words, and says so when a
// section failed, is stale, or holds a value that is missing (a missing value is never drawn as zero). Pure and free of React.

export type Section = ({ ok: true; source: string; data: unknown } | { ok: false; source: string; error: string }) & { stale?: boolean; staleSeconds?: number; staleBecause?: string };
export type Dashboard = { schema: string; network: string; generatedAt: string; note: string; sections: Record<string, Section> };

export const SECTIONS: { id: string; title: string; about: string }[] = [
  { id: 'health', title: 'Is it running', about: 'The API, the indexer and how far behind the chain the indexer is.' },
  { id: 'totals', title: 'Totals', about: 'Crosses run, buyers filled and money moved, counted from the index.' },
  { id: 'execution', title: 'Execution quality', about: 'How buyers fared against the clearing price, and how long a cross takes to settle.' },
  { id: 'fairness', title: 'Fairness', about: 'How concentrated the bidders and the fills are.' },
  { id: 'externalFlow', title: 'External flow', about: 'Orders that came through aggregators, blinks and market makers.' },
  { id: 'accuracy', title: 'Accuracy record', about: 'Signed bands for the price a cross will clear at, and how they turned out.' },
  { id: 'fees', title: 'Fee ledger', about: 'What the protocol and integrators have earned.' },
  { id: 'protocol', title: 'The protocol', about: 'Whether it is paused, who receives the fee, and the schedule.' },
  { id: 'ratings', title: 'Rating track record', about: 'How the issuer ratings held up.' },
  { id: 'programs', title: 'The five programs', about: 'When each was last deployed and who can replace it.' },
];

const HIDE = new Set(['how', 'method', 'note', 'notes', 'schema', 'generatedAt']);

/** `quote_to_sellers` and `quoteToSellers` read as "Quote to sellers". */
export function humanize(key: string): string {
  const s = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const scalar = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** How a leaf reads: a missing value says so; a ratio is left as the route gave it. */
export function leaf(v: string | number | boolean | null): string {
  if (v === null) return 'no data';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : String(v);
  return v === '' ? 'empty' : v;
}

export type Rows = { rows: [string, string][]; notes: string[]; truncated: number };

/** The leaves of a section's data, as label and value, to three levels deep, with the route's own method text kept apart as notes. */
export function rowsOf(data: unknown, limit = 40): Rows {
  const rows: [string, string][] = [];
  const notes: string[] = [];
  let truncated = 0;
  const walk = (v: unknown, path: string[], depth: number) => {
    if (v === undefined) return;
    if (scalar(v)) {
      if (rows.length >= limit) truncated += 1;
      else rows.push([path.map(humanize).join(' · ') || 'Value', leaf(v)]);
      return;
    }
    if (Array.isArray(v)) {
      if (v.every(scalar)) {
        if (rows.length >= limit) truncated += 1;
        else rows.push([path.map(humanize).join(' · '), v.length === 0 ? 'none' : v.map((x) => leaf(x as never)).join(', ')]);
      } else if (rows.length >= limit) truncated += 1;
      else rows.push([path.map(humanize).join(' · '), `${v.length} item${v.length === 1 ? '' : 's'}`]);
      return;
    }
    if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (HIDE.has(k)) {
          if (typeof x === 'string' && depth === 0) notes.push(x);
          continue;
        }
        if (depth >= 3) {
          if (rows.length >= limit) truncated += 1;
          else rows.push([[...path, k].map(humanize).join(' · '), scalar(x) ? leaf(x) : 'see the route']);
        } else walk(x, [...path, k], depth + 1);
      }
    }
  };
  walk(data, [], 0);
  return { rows, notes, truncated };
}

export type ProgramRow = { name: string; address: string; deployed: boolean; upgradeable: boolean | null; lastDeployedSlot: string | null; upgradeAuthority: string | null | undefined; error: string | null };

/** The programs section as one row per program. A program whose bytes could not be read keeps its error, and an authority that is revoked is shown as such, not as missing. */
export function programRows(data: unknown): ProgramRow[] {
  if (!Array.isArray(data)) return [];
  return data.map((x) => {
    const p = x as Record<string, unknown>;
    return {
      name: String(p.name ?? ''),
      address: String(p.address ?? ''),
      deployed: p.deployed === true,
      upgradeable: typeof p.upgradeable === 'boolean' ? p.upgradeable : null,
      lastDeployedSlot: typeof p.lastDeployedSlot === 'string' ? p.lastDeployedSlot : null,
      upgradeAuthority: p.upgradeAuthority === null ? null : typeof p.upgradeAuthority === 'string' ? p.upgradeAuthority : undefined,
      error: typeof p.error === 'string' ? p.error : null,
    };
  });
}

export function authorityText(p: ProgramRow): string {
  if (!p.deployed) return 'not deployed on this network';
  if (p.error) return `could not be read: ${p.error}`;
  if (p.upgradeable === false) return 'not upgradeable';
  if (p.upgradeAuthority === null) return 'none: it can never be changed';
  if (p.upgradeAuthority === undefined) return 'not read';
  return p.upgradeAuthority;
}

/** How old a stale section is, in words. */
export function staleText(s: Section): string | null {
  if (!s.stale) return null;
  const secs = s.staleSeconds ?? 0;
  const age = secs < 90 ? `${secs} seconds` : secs < 5400 ? `${Math.round(secs / 60)} minutes` : `${Math.round(secs / 3600)} hours`;
  return `Showing the last good answer, ${age} old${s.staleBecause ? `, because the route now says: ${s.staleBecause}` : ''}.`;
}
