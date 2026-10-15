// The cited research-note service (J3). It reads a cross's cited facts from the Opening Cross API (the template brief and its citations), asks the language model for a fluent note over
// them, passes every sentence through the gate, and answers with what passed, what was dropped, and what could not be said. With no model key it answers with the template brief and says
// so: the route works, and is honest about which kind of note it returned, from the first deploy.
//
//   GET /v1/research/cross/:address     the note
//   GET /healthz
//
// Cost control: a note for the same facts is served from memory for `ttlSecs` (the facts change when the cross does), at most `maxInFlight` model calls run at once, and at most
// `maxNotesPerHour` model-written notes are made in an hour; past that the template note is served and the response says why.
import { createHash } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { isAddress } from '@solana/kit';
import { type FactTable, type LlmClient, type ResearchNote, tableFromBrief, writeResearchNote } from '@opening-cross/research';

export type BriefWire = { statements: { text: string; cites: { metric: string; value: string; source: string }[] }[]; abstentions: string[] };

export type BriefServiceDeps = {
  apiBase: string;
  llm: LlmClient | null;
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => number;
  ttlSecs?: number;
  maxInFlight?: number;
  maxNotesPerHour?: number;
};

export type BriefAnswer = { status: number; body: unknown };

const DISCLOSURE =
  'Sentences marked llm were written by a language model and each passed an automatic check that every number equals a cited fact, that no advice, verdict or instruction is present, and that every citation is stated. The check cannot see what the facts leave out; the abstentions list what is missing. This is not financial advice.';

const defaultFetch = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
};

function readBrief(j: unknown): BriefWire {
  const o = j as { statements?: unknown; abstentions?: unknown };
  if (!Array.isArray(o?.statements) || !Array.isArray(o.abstentions)) throw new Error('the brief has no statements and abstentions');
  const statements = o.statements.map((s) => {
    const st = s as { text?: unknown; cites?: unknown };
    if (typeof st.text !== 'string' || !Array.isArray(st.cites)) throw new Error('a brief statement is not { text, cites }');
    return { text: st.text, cites: st.cites.map((c) => { const k = c as { metric?: unknown; value?: unknown; source?: unknown }; if (typeof k.metric !== 'string' || typeof k.value !== 'string' || typeof k.source !== 'string') throw new Error('a cite is not { metric, value, source }'); return { metric: k.metric, value: k.value, source: k.source }; }) };
  });
  return { statements, abstentions: o.abstentions.map(String) };
}

export function createBriefService(d: BriefServiceDeps) {
  const fetchJson = d.fetchJson ?? defaultFetch;
  const now = d.now ?? (() => Date.now());
  const ttl = (d.ttlSecs ?? 600) * 1000;
  const cache = new Map<string, { at: number; note: ResearchNote }>();
  const made: number[] = [];
  let inFlight = 0;

  async function note(address: string): Promise<BriefAnswer> {
    if (!isAddress(address)) return { status: 400, body: { error: 'the address must be a base58 Solana address' } };
    let brief: BriefWire;
    try {
      brief = readBrief(await fetchJson(`${d.apiBase}/v1/integrity/cross/${address}/brief`));
    } catch (e) {
      return { status: 502, body: { error: `the facts for this cross could not be read: ${e instanceof Error ? e.message : String(e)}` } };
    }
    const table: FactTable = tableFromBrief(brief);
    const key = createHash('sha256').update(JSON.stringify([address, [...table.values()], brief.abstentions])).digest('hex');
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return respond(address, hit.note, true, null);

    let limited: string | null = null;
    const hour = now() - 3_600_000;
    while (made.length && made[0]! < hour) made.shift();
    const maxPerHour = d.maxNotesPerHour ?? 60;
    if (d.llm && made.length >= maxPerHour) limited = `the hourly limit of ${maxPerHour} model-written notes is used`;
    else if (d.llm && inFlight >= (d.maxInFlight ?? 4)) limited = 'the service is busy writing other notes';
    const useModel = d.llm !== null && limited === null;
    if (useModel) {
      inFlight += 1;
      made.push(now());
    }
    let result: ResearchNote;
    try {
      result = await writeResearchNote(table, { llm: useModel ? d.llm : null, template: brief });
    } finally {
      if (useModel) inFlight -= 1;
    }
    // A template note made because of a limit is not cached: the next request can still get the model's.
    if (result.generated === 'llm-gated' || limited === null) cache.set(key, { at: now(), note: result });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    return respond(address, result, false, limited);
  }

  function respond(address: string, n: ResearchNote, cached: boolean, limited: string | null): BriefAnswer {
    return {
      status: 200,
      body: {
        schema: 'opening-cross/research-note/v1',
        cross: address,
        generated: n.generated,
        ...(n.fallbackReason && { fallbackReason: n.fallbackReason }),
        ...(limited && { limited }),
        ...(n.generated === 'template' && n.fallbackReason === 'NO_MODEL' && !limited && { note: 'This deployment has no language-model key, so this is the template brief: every sentence is a template filled from the cited facts.' }),
        sentences: n.sentences,
        abstentions: n.abstentions,
        dropped: n.dropped.map((x) => ({ text: x.text, why: [...new Set(x.rejections.map((r) => r.code))] })),
        model: n.model ?? null,
        usage: n.usage,
        cached,
        disclosure: DISCLOSURE,
      },
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (a: BriefAnswer) => {
      res.writeHead(a.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(a.body));
    };
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method !== 'GET') return send({ status: 405, body: { error: 'GET only' } });
    if (url.pathname === '/healthz') return send({ status: 200, body: { ok: true, model: d.llm?.name ?? null } });
    const m = /^\/v1\/research\/cross\/([^/]+)$/.exec(url.pathname);
    if (!m) return send({ status: 404, body: { error: 'GET /v1/research/cross/:address' } });
    try {
      send(await note(decodeURIComponent(m[1]!)));
    } catch (e) {
      send({ status: 500, body: { error: e instanceof Error ? e.message : String(e) } });
    }
  }

  return { note, handle, listen: (port: number, host = '127.0.0.1'): Promise<Server> => new Promise((resolve) => { const s = createServer((q, r) => void handle(q, r)); s.listen(port, host, () => resolve(s)); }) };
}
