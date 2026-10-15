// The operations console API. Every route needs a token (`Authorization: Bearer ...`) except the monitor's webhook, which needs the
// secret in its path. With no tokens configured every request is refused: a console that is open by default is not a console.
//
//   GET  /v1/ops/me
//   POST /v1/ops/listings                   reviewer   { mint?, cross?, note }  open a listing review; the console gathers evidence
//   GET  /v1/ops/listings[?status=]         viewer     each row names the evidence sources that failed
//   GET  /v1/ops/listings/:id               viewer     one review with the evidence gathered when it was opened
//   POST /v1/ops/listings/:id/decision      reviewer   { decision: approve|reject|needs-info, reason, acknowledgeMissingEvidence? }
//   POST /v1/ops/incidents                  reviewer   { title, severity, detail? }
//   GET  /v1/ops/incidents[?state=]         viewer
//   POST /v1/ops/incidents/:id/ack          reviewer
//   POST /v1/ops/incidents/:id/resolve      admin      { resolution }
//   POST /v1/ops/hooks/monitor/:secret      (secret)   the monitor's webhook events
//   POST /v1/ops/cases                      reviewer   { kind, subject, summary }
//   GET  /v1/ops/cases[?status=]            viewer
//   GET  /v1/ops/cases/:id                  viewer     with its notes
//   POST /v1/ops/cases/:id/notes            reviewer   { text }   notes are never edited or removed
//   POST /v1/ops/cases/:id/close            admin      { resolution }
//   GET  /v1/ops/review/cross/:address      viewer     the evidence pack on one cross
//   GET  /v1/ops/log[?after=&limit=]        viewer     the audit log, oldest first from `after`; `?order=desc[&before=<seq>]` reads the newest first
//   GET  /v1/ops/log/verify                 admin      recompute the hash chain
//   GET  /v1/ops/log/head                   admin      the chain head, signed when a key is configured
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { type Json } from '@opening-cross/promises';
import { type Principal, type Role, type TokenEntry, allows, authenticate, secretMatches } from './auth.js';
import { append, entries, entriesNewestFirst, signedHead, verifyChain } from './log.js';

export interface OpsOptions {
  tokens: readonly TokenEntry[];
  /** Gathers what a reviewer should see about a mint or a cross. Failures of one source never stop the others. */
  evidence?: (subject: { mint?: string; cross?: string }) => Promise<Record<string, { ok: boolean; data?: unknown; error?: string }>>;
  /** Signs the audit-log head. Without it the head is returned unsigned and says so. */
  signer?: { keyPair: CryptoKeyPair; address: string } | null;
  /** The secret in the monitor webhook's path. Without it the webhook is off. */
  webhookSecret?: string;
  clock?: () => number;
}

class OpsError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const str = (v: unknown, field: string, min = 1, max = 4000): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new OpsError(400, `${field} must be text of ${min} to ${max} characters`);
  return v.trim();
};
const pick = <T extends string>(v: unknown, field: string, allowed: readonly T[]): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new OpsError(400, `${field} must be one of ${allowed.join(', ')}`);
  return v as T;
};
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function registerOps(app: FastifyInstance, d: { db: pg.Pool }, o: OpsOptions): void {
  const now = () => o.clock?.() ?? Math.floor(Date.now() / 1000);
  const db = d.db;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof OpsError) return send(reply, { error: err.message }, err.status);
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return send(reply, { error: e.message ?? 'bad request' }, e.statusCode);
    console.error(JSON.stringify({ at: new Date().toISOString(), ops: String(err) }));
    return send(reply, { error: 'internal error' }, 500);
  });

  const principals = new WeakMap<FastifyRequest, Principal>();
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/v1/ops') || path.startsWith('/v1/ops/hooks/')) return;
    if (o.tokens.length === 0) throw new OpsError(503, 'no tokens are configured (OPS_TOKENS), so the console refuses every request');
    const who = authenticate(req.headers.authorization, o.tokens);
    if (!who) throw new OpsError(401, 'a valid bearer token is required');
    principals.set(req, who);
  });
  const as = (req: FastifyRequest, need: Role): Principal => {
    const p = principals.get(req)!;
    if (!allows(p.role, need)) throw new OpsError(403, `this needs the ${need} role; you are ${p.role}`);
    return p;
  };

  /** Runs `fn` and its audit entry in one transaction. */
  async function recorded<T>(actor: string, action: string, subject: string, fn: (c: pg.PoolClient) => Promise<{ result: T; detail: Json }>): Promise<T> {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const { result, detail } = await fn(c);
      await append(c, { at: now(), actor, action, subject, detail });
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  app.get('/v1/ops/me', async (req, reply) => send(reply, principals.get(req)));

  // ---------------------------------------------------------------------------------------------------------- listings
  app.post('/v1/ops/listings', async (req, reply) => {
    const me = as(req, 'reviewer');
    const b = (req.body ?? {}) as { mint?: unknown; cross?: unknown; note?: unknown };
    const mint = b.mint === undefined ? undefined : str(b.mint, 'mint', 32, 44);
    const cross = b.cross === undefined ? undefined : str(b.cross, 'cross', 32, 44);
    if (!mint && !cross) throw new OpsError(400, 'give a mint, a cross, or both');
    for (const [n, v] of [['mint', mint], ['cross', cross]] as const) if (v && !BASE58.test(v)) throw new OpsError(400, `${n} must be a base58 address`);
    const note = str(b.note, 'note', 3, 1000);
    const evidence = o.evidence ? await o.evidence({ ...(mint ? { mint } : {}), ...(cross ? { cross } : {}) }).catch((e: unknown) => ({ gathering: { ok: false, error: String(e) } })) : {};
    const id = randomUUID();
    const t = now();
    await recorded(me.name, 'listing.open', id, async (c) => {
      await c.query('INSERT INTO ops_listings (id, mint, cross_address, requested_by, note, status, evidence, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, mint ?? null, cross ?? null, me.name, note, 'pending', JSON.stringify(evidence), t]);
      return { result: null, detail: { mint: mint ?? null, cross: cross ?? null, note, evidenceSources: Object.keys(evidence), evidenceFailed: Object.entries(evidence).filter(([, v]) => !v.ok).map(([k]) => k) } };
    });
    return send(reply, { id, status: 'pending', evidence }, 201);
  });

  app.get('/v1/ops/listings', async (req, reply) => {
    as(req, 'viewer');
    const status = (req.query as { status?: string }).status;
    if (status !== undefined) pick(status, 'status', ['pending', 'approved', 'rejected', 'needs-info']);
    // `evidence_failed` names the sources that could not be gathered, so the queue shows which reviews would need an acknowledgement to approve.
    const { rows } = await db.query(
      "SELECT id, mint, cross_address, requested_by, note, status, reason, created_at::text, decided_at::text, decided_by, ARRAY(SELECT e.key FROM jsonb_each(ops_listings.evidence) AS e WHERE e.value->>'ok' IS DISTINCT FROM 'true' ORDER BY e.key) AS evidence_failed FROM ops_listings WHERE ($1::text IS NULL OR status = $1) ORDER BY ops_listings.created_at DESC LIMIT 200",
      [status ?? null],
    );
    return send(reply, { listings: rows });
  });

  // The person who decides a review is not the person who opened it, so they read the evidence from here: what the console gathered when the review was opened.
  app.get('/v1/ops/listings/:id', async (req, reply) => {
    as(req, 'viewer');
    const id = (req.params as { id: string }).id;
    const row = (await db.query('SELECT id, mint, cross_address, requested_by, note, status, reason, evidence, created_at::text, decided_at::text, decided_by FROM ops_listings WHERE id = $1', [id])).rows[0];
    if (!row) throw new OpsError(404, 'no such listing review');
    return send(reply, row);
  });

  app.post('/v1/ops/listings/:id/decision', async (req, reply) => {
    const me = as(req, 'reviewer');
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { decision?: unknown; reason?: unknown; acknowledgeMissingEvidence?: unknown };
    const decision = pick(b.decision, 'decision', ['approve', 'reject', 'needs-info']);
    const reason = str(b.reason, 'reason', 10, 2000);
    const row = (await db.query<{ status: string; requested_by: string; evidence: Record<string, { ok: boolean }> }>('SELECT status, requested_by, evidence FROM ops_listings WHERE id = $1', [id])).rows[0];
    if (!row) throw new OpsError(404, 'no such listing review');
    if (row.status === 'approved' || row.status === 'rejected') throw new OpsError(409, `this review is already ${row.status}; open a new one to reconsider`);
    if (row.requested_by === me.name) throw new OpsError(403, 'you opened this review; someone else decides it');
    const missing = Object.entries(row.evidence).filter(([, v]) => !v.ok).map(([k]) => k);
    if (decision === 'approve' && missing.length > 0 && b.acknowledgeMissingEvidence !== true) throw new OpsError(409, `evidence could not be gathered for ${missing.join(', ')}; approve only with acknowledgeMissingEvidence: true`);
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'needs-info';
    await recorded(me.name, `listing.${decision}`, id, async (c) => {
      await c.query('UPDATE ops_listings SET status = $2, reason = $3, decided_at = $4, decided_by = $5 WHERE id = $1', [id, status, reason, now(), me.name]);
      return { result: null, detail: { status, reason, missingEvidenceAcknowledged: missing.length > 0 && decision === 'approve' ? missing : [] } };
    });
    return send(reply, { id, status });
  });

  // --------------------------------------------------------------------------------------------------------- incidents
  async function openIncident(actor: string, i: { title: string; severity: 'critical' | 'warning' | 'info'; source: 'monitor' | 'manual'; dedupeKey: string | null; detail: Json }): Promise<{ id: string; fresh: boolean }> {
    const id = randomUUID();
    return recorded<{ id: string; fresh: boolean }>(actor, 'incident.open', id, async (c) => {
      const r = await c.query('INSERT INTO ops_incidents (id, dedupe_key, severity, title, source, state, detail, opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [id, i.dedupeKey, i.severity, i.title, i.source, 'open', JSON.stringify(i.detail), now()]);
      if ((r.rowCount ?? 0) === 0) {
        const existing = (await c.query<{ id: string }>("SELECT id FROM ops_incidents WHERE dedupe_key = $1 AND state <> 'resolved'", [i.dedupeKey])).rows[0]!;
        return { result: { id: existing.id, fresh: false }, detail: { duplicateOf: existing.id, title: i.title } };
      }
      return { result: { id, fresh: true }, detail: { title: i.title, severity: i.severity, source: i.source, dedupeKey: i.dedupeKey } };
    });
  }

  app.post('/v1/ops/incidents', async (req, reply) => {
    const me = as(req, 'reviewer');
    const b = (req.body ?? {}) as { title?: unknown; severity?: unknown; detail?: unknown };
    const out = await openIncident(me.name, { title: str(b.title, 'title', 3, 200), severity: pick(b.severity, 'severity', ['critical', 'warning', 'info']), source: 'manual', dedupeKey: null, detail: (b.detail ?? {}) as Json });
    return send(reply, out, 201);
  });

  app.get('/v1/ops/incidents', async (req, reply) => {
    as(req, 'viewer');
    const state = (req.query as { state?: string }).state;
    if (state !== undefined) pick(state, 'state', ['open', 'acknowledged', 'resolved']);
    const { rows } = await db.query('SELECT id, severity, title, source, state, detail, opened_at::text, acknowledged_by, acknowledged_at::text, resolved_by, resolved_at::text, resolution FROM ops_incidents WHERE ($1::text IS NULL OR state = $1) ORDER BY ops_incidents.opened_at DESC LIMIT 200', [state ?? null]);
    return send(reply, { incidents: rows });
  });

  app.post('/v1/ops/incidents/:id/ack', async (req, reply) => {
    const me = as(req, 'reviewer');
    const id = (req.params as { id: string }).id;
    const row = (await db.query<{ state: string }>('SELECT state FROM ops_incidents WHERE id = $1', [id])).rows[0];
    if (!row) throw new OpsError(404, 'no such incident');
    if (row.state !== 'open') throw new OpsError(409, `the incident is ${row.state}`);
    await recorded(me.name, 'incident.ack', id, async (c) => {
      await c.query("UPDATE ops_incidents SET state = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3 WHERE id = $1", [id, me.name, now()]);
      return { result: null, detail: {} };
    });
    return send(reply, { id, state: 'acknowledged' });
  });

  app.post('/v1/ops/incidents/:id/resolve', async (req, reply) => {
    const me = as(req, 'admin');
    const id = (req.params as { id: string }).id;
    const resolution = str((req.body as { resolution?: unknown } | null)?.resolution, 'resolution', 10, 2000);
    const row = (await db.query<{ state: string }>('SELECT state FROM ops_incidents WHERE id = $1', [id])).rows[0];
    if (!row) throw new OpsError(404, 'no such incident');
    if (row.state === 'resolved') throw new OpsError(409, 'the incident is already resolved');
    await recorded(me.name, 'incident.resolve', id, async (c) => {
      await c.query("UPDATE ops_incidents SET state = 'resolved', resolved_by = $2, resolved_at = $3, resolution = $4 WHERE id = $1", [id, me.name, now(), resolution]);
      return { result: null, detail: { resolution } };
    });
    return send(reply, { id, state: 'resolved' });
  });

  app.post('/v1/ops/hooks/monitor/:secret', async (req, reply) => {
    if (!o.webhookSecret) throw new OpsError(404, 'the monitor webhook is not enabled');
    if (!secretMatches((req.params as { secret: string }).secret, o.webhookSecret)) throw new OpsError(401, 'wrong secret');
    const ev = req.body as { kind?: string; body?: Record<string, unknown> } | null;
    if (!ev || typeof ev.kind !== 'string' || typeof ev.body !== 'object' || ev.body === null) throw new OpsError(400, 'expected a monitor event { kind, at, body }');
    const body = ev.body;
    // What becomes an incident: an incident event (a pause happened or was lifted), a pause that failed, and a critical finding that has persisted.
    if (ev.kind === 'incident') {
      const out = await openIncident('monitor', { title: String(body.event ?? 'monitor incident').slice(0, 200), severity: 'critical', source: 'monitor', dedupeKey: `incident:${String(body.event)}:${String(body.signature ?? '')}`, detail: body as Json });
      return send(reply, { accepted: true, incident: out.id, fresh: out.fresh });
    }
    if (ev.kind === 'decision' && body.decision === 'pause-failed') {
      const out = await openIncident('monitor', { title: 'the monitor tried to pause the protocol and failed', severity: 'critical', source: 'monitor', dedupeKey: 'decision:pause-failed', detail: body as Json });
      return send(reply, { accepted: true, incident: out.id, fresh: out.fresh });
    }
    if (ev.kind === 'finding' && body.severity === 'critical' && typeof body.streak === 'number' && typeof body.needed === 'number' && body.streak >= body.needed) {
      const out = await openIncident('monitor', { title: String(body.message ?? 'critical finding').slice(0, 200), severity: 'critical', source: 'monitor', dedupeKey: `finding:${String(body.check)}:${String(body.subject)}`, detail: body as Json });
      return send(reply, { accepted: true, incident: out.id, fresh: out.fresh });
    }
    return send(reply, { accepted: true, incident: null, note: 'recorded nowhere: only incidents, failed pauses and persisted critical findings open an incident' });
  });

  // ------------------------------------------------------------------------------------------------------------ cases
  app.post('/v1/ops/cases', async (req, reply) => {
    const me = as(req, 'reviewer');
    const b = (req.body ?? {}) as { kind?: unknown; subject?: unknown; summary?: unknown };
    const kind = pick(b.kind, 'kind', ['sanctions', 'fraud', 'support', 'other']);
    const subject = str(b.subject, 'subject', 3, 100);
    const summary = str(b.summary, 'summary', 10, 2000);
    const id = randomUUID();
    await recorded(me.name, 'case.open', id, async (c) => {
      await c.query('INSERT INTO ops_cases (id, kind, subject, summary, status, opened_by, opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, kind, subject, summary, 'open', me.name, now()]);
      return { result: null, detail: { kind, subject, summary } };
    });
    return send(reply, { id, status: 'open' }, 201);
  });

  app.get('/v1/ops/cases', async (req, reply) => {
    as(req, 'viewer');
    const status = (req.query as { status?: string }).status;
    if (status !== undefined) pick(status, 'status', ['open', 'closed']);
    const { rows } = await db.query('SELECT id, kind, subject, summary, status, assignee, opened_by, opened_at::text, closed_by, closed_at::text, resolution FROM ops_cases WHERE ($1::text IS NULL OR status = $1) ORDER BY ops_cases.opened_at DESC LIMIT 200', [status ?? null]);
    return send(reply, { cases: rows });
  });

  app.get('/v1/ops/cases/:id', async (req, reply) => {
    as(req, 'viewer');
    const id = (req.params as { id: string }).id;
    const c = (await db.query('SELECT id, kind, subject, summary, status, assignee, opened_by, opened_at::text, closed_by, closed_at::text, resolution FROM ops_cases WHERE id = $1', [id])).rows[0];
    if (!c) throw new OpsError(404, 'no such case');
    const notes = (await db.query('SELECT id::text, at::text, author, text FROM ops_case_notes WHERE case_id = $1 ORDER BY ops_case_notes.id', [id])).rows;
    return send(reply, { ...c, notes });
  });

  app.post('/v1/ops/cases/:id/notes', async (req, reply) => {
    const me = as(req, 'reviewer');
    const id = (req.params as { id: string }).id;
    const text = str((req.body as { text?: unknown } | null)?.text, 'text', 1, 4000);
    const row = (await db.query<{ status: string }>('SELECT status FROM ops_cases WHERE id = $1', [id])).rows[0];
    if (!row) throw new OpsError(404, 'no such case');
    if (row.status === 'closed') throw new OpsError(409, 'the case is closed; open a new one');
    await recorded(me.name, 'case.note', id, async (c) => {
      await c.query('INSERT INTO ops_case_notes (case_id, at, author, text) VALUES ($1,$2,$3,$4)', [id, now(), me.name, text]);
      return { result: null, detail: { chars: text.length } }; // the audit log holds that a note was added, not its text; the note stays in the case
    });
    return send(reply, { id, added: true }, 201);
  });

  app.post('/v1/ops/cases/:id/close', async (req, reply) => {
    const me = as(req, 'admin');
    const id = (req.params as { id: string }).id;
    const resolution = str((req.body as { resolution?: unknown } | null)?.resolution, 'resolution', 10, 2000);
    const row = (await db.query<{ status: string }>('SELECT status FROM ops_cases WHERE id = $1', [id])).rows[0];
    if (!row) throw new OpsError(404, 'no such case');
    if (row.status === 'closed') throw new OpsError(409, 'the case is already closed');
    await recorded(me.name, 'case.close', id, async (c) => {
      await c.query("UPDATE ops_cases SET status = 'closed', closed_by = $2, closed_at = $3, resolution = $4 WHERE id = $1", [id, me.name, now(), resolution]);
      return { result: null, detail: { resolution } };
    });
    return send(reply, { id, status: 'closed' });
  });

  // ---------------------------------------------------------------------------------------------------- review, log
  app.get('/v1/ops/review/cross/:address', async (req, reply) => {
    as(req, 'viewer');
    const address = (req.params as { address: string }).address;
    if (!BASE58.test(address)) throw new OpsError(400, 'address must be a base58 address');
    if (!o.evidence) throw new OpsError(503, 'no evidence source is configured (OPS_API_URL)');
    return send(reply, { cross: address, evidence: await o.evidence({ cross: address }) });
  });

  app.get('/v1/ops/log', async (req, reply) => {
    as(req, 'viewer');
    const q = req.query as { after?: string; before?: string; limit?: string; order?: string };
    const after = q.after === undefined ? 0 : Number(q.after);
    const before = q.before === undefined ? undefined : Number(q.before);
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || (before !== undefined && (!Number.isInteger(before) || before < 1))) throw new OpsError(400, 'after, before and limit must be whole numbers');
    if (q.order !== undefined && q.order !== 'asc' && q.order !== 'desc') throw new OpsError(400, 'order must be asc or desc');
    if (q.order === 'asc' && before !== undefined) throw new OpsError(400, 'before reads backward; it cannot be combined with order=asc');
    if (q.order === 'desc' || before !== undefined) {
      if (q.after !== undefined) throw new OpsError(400, 'after reads forward and before reads backward; give one of them');
      return send(reply, { entries: await entriesNewestFirst(db, { ...(before !== undefined ? { before } : {}), limit }) });
    }
    return send(reply, { entries: await entries(db, { after, limit }) });
  });

  app.get('/v1/ops/log/verify', async (req, reply) => {
    as(req, 'admin');
    return send(reply, await verifyChain(db));
  });

  app.get('/v1/ops/log/head', async (req, reply) => {
    as(req, 'admin');
    if (!o.signer) {
      const check = await verifyChain(db);
      return send(reply, { check, signed: false, note: 'No signing key is configured, so the head is not signed. An unsigned head proves nothing to someone who kept no earlier copy.' });
    }
    const { check, document } = await signedHead(db, o.signer.keyPair, now());
    return send(reply, { check, signed: document !== null, document });
  });
}
