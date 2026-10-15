// The browser's side of the operations console API (services/ops). Every call goes through this app's own `/ops/api` route with the
// person's token; the service decides what that person may do, and these helpers only check what the service would refuse for being
// malformed, so a form can say so before anything is sent. The checks mirror services/ops/src/routes.ts and are never the authority.

export type Role = 'viewer' | 'reviewer' | 'admin';
const RANK: Record<Role, number> = { viewer: 1, reviewer: 2, admin: 3 };
export const allows = (have: Role, need: Role): boolean => RANK[have] >= RANK[need];

export type Principal = { name: string; role: Role };
export type EvidenceItem = { ok: boolean; data?: unknown; error?: string };
export type Evidence = Record<string, EvidenceItem>;

export type ListingStatus = 'pending' | 'approved' | 'rejected' | 'needs-info';
export const LISTING_STATUSES: readonly ListingStatus[] = ['pending', 'approved', 'rejected', 'needs-info'];
export type Listing = {
  id: string;
  mint: string | null;
  cross_address: string | null;
  requested_by: string;
  note: string;
  status: ListingStatus;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  /** Sources that could not be gathered when the review was opened (the queue carries this; the detail carries `evidence`). */
  evidence_failed?: string[];
  evidence?: Evidence;
};
export type Decision = 'approve' | 'reject' | 'needs-info';

export type Severity = 'critical' | 'warning' | 'info';
export const SEVERITIES: readonly Severity[] = ['critical', 'warning', 'info'];
export type IncidentState = 'open' | 'acknowledged' | 'resolved';
export const INCIDENT_STATES: readonly IncidentState[] = ['open', 'acknowledged', 'resolved'];
export type Incident = {
  id: string;
  severity: Severity;
  title: string;
  source: 'monitor' | 'manual';
  state: IncidentState;
  detail: unknown;
  opened_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
};

export type CaseKind = 'sanctions' | 'fraud' | 'support' | 'other';
export const CASE_KINDS: readonly CaseKind[] = ['sanctions', 'fraud', 'support', 'other'];
export type CaseStatus = 'open' | 'closed';
export type CaseRow = { id: string; kind: CaseKind; subject: string; summary: string; status: CaseStatus; assignee: string | null; opened_by: string; opened_at: string; closed_by: string | null; closed_at: string | null; resolution: string | null };
export type CaseNote = { id: string; at: string; author: string; text: string };
export type CaseDetail = CaseRow & { notes: CaseNote[] };

export type LogEntry = { seq: number; at: number; actor: string; action: string; subject: string; detail: unknown; prevHash: string; hash: string };
export type ChainCheck = { ok: boolean; length: number; head: string; brokenAt?: { seq: number; why: string } };
export type SignedHead = { check: ChainCheck; signed: boolean; document?: unknown; note?: string };

/** What a call failed with. `status` 0 is "never reached this app". */
export class OpsApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OpsApiError';
  }
  /** The token was not accepted: the session is over. */
  get signedOut(): boolean {
    return this.status === 401;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const OPS_API_BASE = '/ops/api/v1/ops';

export interface OpsClient {
  me(): Promise<Principal>;
  listings(status?: ListingStatus): Promise<Listing[]>;
  listing(id: string): Promise<Listing>;
  openListing(input: { mint?: string; cross?: string; note: string }): Promise<{ id: string; status: string; evidence: Evidence }>;
  decideListing(id: string, input: { decision: Decision; reason: string; acknowledgeMissingEvidence?: boolean }): Promise<{ id: string; status: ListingStatus }>;
  crossReview(address: string): Promise<{ cross: string; evidence: Evidence }>;
  incidents(state?: IncidentState): Promise<Incident[]>;
  openIncident(input: { title: string; severity: Severity; note?: string }): Promise<{ id: string; fresh: boolean }>;
  ackIncident(id: string): Promise<void>;
  resolveIncident(id: string, resolution: string): Promise<void>;
  cases(status?: CaseStatus): Promise<CaseRow[]>;
  caseDetail(id: string): Promise<CaseDetail>;
  openCase(input: { kind: CaseKind; subject: string; summary: string }): Promise<{ id: string }>;
  addNote(id: string, text: string): Promise<void>;
  closeCase(id: string, resolution: string): Promise<void>;
  log(o?: { before?: number; limit?: number }): Promise<LogEntry[]>;
  verifyLog(): Promise<ChainCheck>;
  logHead(): Promise<SignedHead>;
}

export function createOpsClient(token: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): OpsClient {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${OPS_API_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
      });
    } catch {
      throw new OpsApiError(0, 'Could not reach the console. Check your connection and try again.');
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* a non-JSON body is reported by status below */
    }
    if (!res.ok) {
      const said = (parsed as { error?: unknown } | null)?.error;
      throw new OpsApiError(res.status, typeof said === 'string' ? said : `The console answered with HTTP ${res.status}.`);
    }
    return parsed as T;
  }
  const q = (params: Record<string, string | number | undefined>): string => {
    const e = Object.entries(params).filter(([, v]) => v !== undefined);
    return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
  };
  const id = encodeURIComponent;
  return {
    me: () => call('GET', '/me'),
    listings: async (status) => (await call<{ listings: Listing[] }>('GET', `/listings${q({ status })}`)).listings,
    listing: (i) => call('GET', `/listings/${id(i)}`),
    openListing: (input) => call('POST', '/listings', input),
    decideListing: (i, input) => call('POST', `/listings/${id(i)}/decision`, input),
    crossReview: (address) => call('GET', `/review/cross/${id(address)}`),
    incidents: async (state) => (await call<{ incidents: Incident[] }>('GET', `/incidents${q({ state })}`)).incidents,
    openIncident: ({ title, severity, note }) => call('POST', '/incidents', { title, severity, ...(note ? { detail: { note } } : {}) }),
    ackIncident: async (i) => void (await call('POST', `/incidents/${id(i)}/ack`, {})),
    resolveIncident: async (i, resolution) => void (await call('POST', `/incidents/${id(i)}/resolve`, { resolution })),
    cases: async (status) => (await call<{ cases: CaseRow[] }>('GET', `/cases${q({ status })}`)).cases,
    caseDetail: (i) => call('GET', `/cases/${id(i)}`),
    openCase: (input) => call('POST', '/cases', input),
    addNote: async (i, text) => void (await call('POST', `/cases/${id(i)}/notes`, { text })),
    closeCase: async (i, resolution) => void (await call('POST', `/cases/${id(i)}/close`, { resolution })),
    log: async (o = {}) => (await call<{ entries: LogEntry[] }>('GET', `/log${q({ order: 'desc', before: o.before, limit: o.limit ?? 50 })}`)).entries,
    verifyLog: () => call('GET', '/log/verify'),
    logHead: () => call('GET', '/log/head'),
  };
}

// ------------------------------------------------------------------------------------------------------------- checks

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const text = (v: string, min: number, max: number): boolean => v.trim().length >= min && v.length <= max;

/** The message a form shows for a problem, or null when the input would be accepted. */
export function listingProblem(i: { mint: string; cross: string; note: string }): string | null {
  const mint = i.mint.trim();
  const cross = i.cross.trim();
  if (!mint && !cross) return 'Give a mint, a cross, or both.';
  if (mint && !BASE58.test(mint)) return 'The mint must be a base58 address.';
  if (cross && !BASE58.test(cross)) return 'The cross must be a base58 address.';
  if (!text(i.note, 3, 1000)) return 'Say why in 3 to 1,000 characters.';
  return null;
}

export function decisionProblem(i: { decision: Decision | ''; reason: string; failedSources: readonly string[]; acknowledged: boolean }): string | null {
  if (!i.decision) return 'Choose a decision.';
  if (!text(i.reason, 10, 2000)) return 'Give a reason of at least 10 characters (up to 2,000).';
  if (i.decision === 'approve' && i.failedSources.length > 0 && !i.acknowledged) return `Evidence could not be gathered for ${i.failedSources.join(', ')}. Tick the box to approve anyway; it is recorded.`;
  return null;
}

export function incidentProblem(i: { title: string; note: string }): string | null {
  if (!text(i.title, 3, 200)) return 'The title must be 3 to 200 characters.';
  if (i.note.length > 4000) return 'The note is too long (4,000 characters at most).';
  return null;
}

export function caseProblem(i: { subject: string; summary: string }): string | null {
  if (!text(i.subject, 3, 100)) return 'The subject (a wallet, cross or mint) must be 3 to 100 characters.';
  if (!text(i.summary, 10, 2000)) return 'The summary must be 10 to 2,000 characters.';
  return null;
}

export const resolutionProblem = (v: string): string | null => (text(v, 10, 2000) ? null : 'Give a resolution of at least 10 characters (up to 2,000).');
export const noteProblem = (v: string): string | null => (text(v, 1, 4000) ? null : 'A note is 1 to 4,000 characters.');

// ---------------------------------------------------------------------------------------------------------- display

/** `2026-10-13 21:05:12 UTC` from unix seconds (the service stores seconds; it may hand them over as text). */
export function when(seconds: string | number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds === '') return '';
  const n = Number(seconds);
  if (!Number.isFinite(n)) return String(seconds);
  return `${new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** An address or hash shortened in the middle, for lists. The full value stays in the title and in the detail view. */
export function shorten(v: string | null | undefined, head = 6, tail = 6): string {
  if (!v) return '';
  return v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
}

export const failedSources = (e: Evidence | undefined): string[] => Object.entries(e ?? {}).filter(([, v]) => !v.ok).map(([k]) => k).sort();

/** A single line saying what a gathered source holds, for the evidence table; the full JSON is one click away. */
export function evidenceSummary(item: EvidenceItem): string {
  if (!item.ok) return item.error ?? 'could not be gathered';
  const d = item.data;
  if (d === null || d === undefined) return 'no data';
  if (typeof d !== 'object') return String(d);
  const flat = Object.entries(d as Record<string, unknown>)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${String(v)}`);
  const line = flat.join(' · ');
  return line.length > 160 ? `${line.slice(0, 157)}…` : line || 'structured data (open to read)';
}

/** The next page of the log is the entries older than the last one shown; null when the log has been read to its start. */
export function olderThan(entries: readonly LogEntry[]): number | null {
  const last = entries.at(-1);
  return last && last.seq > 1 ? last.seq : null;
}

/** Whether each entry's `prevHash` is the hash of the entry before it in the log, within what is loaded (newest first). The service's verify is the authority. */
export function linkedWithinPage(entries: readonly LogEntry[]): boolean[] {
  return entries.map((e, i) => {
    const older = entries[i + 1];
    return older ? e.prevHash === older.hash : true;
  });
}
