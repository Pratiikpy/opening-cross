// The issuer board: what an issuer publishes before and around a raise, each item a record the issuer's wallet signed.
//
//   draft        a shareable draft listing, labelled "not verified", that holders can soft-commit to (PRODUCT_FEATURES A3, S13)
//   softcommit   a non-binding statement: "at a limit price of P I would spend up to X". No funds move; the latest per wallet counts
//   application  an issuer's application for review against the published checklist (A2)
//   decision     a curator's decision on an application: accepted, changes-requested or declined
//   question     a holder's question about a cross or a treasury (A10, E5)
//   answer       the cross creator's or treasury authority's answer
//
//   GET  /v1/issuer/curators                          who may decide on applications (configured by the operator; empty means nobody yet)
//   POST /v1/issuer/records/prepare                   { kind, signer, body } -> { record, id, message }: validated, timestamped, ready to sign
//   POST /v1/issuer/records                           { record, signature } -> stores the record after checking the signature and the rules of its kind
//   GET  /v1/issuer/records?kind=&subject=&signer=    stored records, newest first
//   GET  /v1/issuer/drafts/:id                        a draft with its demand map (by price, by wallet track record)
//   GET  /v1/issuer/applications/:id                  an application with its latest decision
//   GET  /v1/issuer/qa?subject=                       the questions asked about a cross or treasury, with who may answer and which are overdue
//
// Everything is public: a record is readable by anyone, and the page says so before an issuer writes one. A record is immutable;
// a change is a new record. The only state kept off chain here is these records. A soft commit is evidence of interest, never of
// a bid: the page shows it as that.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAddress } from '@solana/kit';
import { LISTING_TYPES } from '@opening-cross/presets/launch';
import { RequestError } from '../tx.js';
import { KINDS, type Kind, MAX_SKEW_SECONDS, RECORD_SCHEMA, type RecordEnvelope, parseDecimal, recordId, signingMessage, verifyRecord } from './issuer-signed.js';

export type BoardDb = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export type BoardDeps = {
  db: BoardDb;
  /** Wallets that may record decisions on applications. The operator names them (ISSUER_CURATORS); none means no decision can be recorded. */
  curators?: ReadonlySet<string>;
  /** Unix seconds; defaults to the wall clock. Tests inject one. */
  clock?: () => number;
};

/** A question unanswered this long is shown as overdue. A convention of this board, not a rule any program enforces. */
export const QA_OVERDUE_SECS = 7 * 86_400;
/** Records one wallet may add per hour. */
export const HOURLY_LIMIT = 30;
export const MAX_RECORD_BYTES = 8 * 1024;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));
const tooMany = (msg: string) => Object.assign(new Error(msg), { statusCode: 429 });

// ---------------------------------------------------------------- bodies

type Spec = Record<string, (v: unknown) => unknown>;

const text = (min: number, max: number) => (v: unknown) => {
  if (typeof v !== 'string') throw new Error('must be text');
  const t = v.trim();
  if (t.length < min || t.length > max) throw new Error(min === 0 ? `must be at most ${max} characters` : `must be ${min} to ${max} characters`);
  return t;
};
const optText = (max: number) => (v: unknown) => (v === undefined || v === null || v === '' ? null : text(1, max)(v));
const addr = (v: unknown) => {
  if (typeof v !== 'string' || !isAddress(v)) throw new Error('must be a base58 Solana address');
  return v;
};
const optAddr = (v: unknown) => (v === undefined || v === null || v === '' ? null : addr(v));
const id64 = (v: unknown) => {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new Error('must be a record id (64 lowercase hex characters)');
  return v;
};
const intIn = (min: number, max: number) => (v: unknown) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`must be a whole number from ${min} to ${max}`);
  return v;
};
const oneOf = <T extends string>(set: readonly T[]) => (v: unknown) => {
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) throw new Error(`must be one of ${set.join(', ')}`);
  return v as T;
};
const decimalText = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{1,30}(\.\d{1,30})?$/.test(v.trim())) throw new Error('must be a decimal number');
  return v.trim();
};
const url = (v: unknown) => {
  if (v === undefined || v === null || v === '') return null;
  const t = text(1, 200)(v);
  try {
    const u = new URL(t);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x');
    return u.toString();
  } catch {
    throw new Error('must be a web address starting with https://');
  }
};

/** Validates `body` against `spec`: every field named is checked, any other field is refused, and the errors name each field. */
function shape(body: unknown, spec: Spec): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [k, check] of Object.entries(spec)) {
    try {
      out[k] = check(b[k]);
    } catch (e) {
      errors.push(`${k} ${(e as Error).message}`);
    }
  }
  for (const k of Object.keys(b)) if (!(k in spec)) errors.push(`${k} is not a field of this record`);
  if (errors.length) throw new RequestError(400, errors.join('; '), { fields: errors });
  return out;
}

const SUPPLY_MODES = ['mint', 'escrow'] as const;
const OUTCOMES = ['accepted', 'changes-requested', 'declined'] as const;
const SUBJECT_KINDS = ['cross', 'treasury'] as const;
const CHECK_STATUS = ['pass', 'fail', 'warn', 'wait'] as const;
const LISTING_IDS = LISTING_TYPES.map((t) => t.id);

const SPECS: Record<Kind, Spec> = {
  draft: {
    title: text(1, 80),
    summary: text(1, 1200),
    baseMint: optAddr,
    quoteMint: optAddr,
    baseDecimals: intIn(0, 18),
    quoteDecimals: intIn(0, 18),
    minPrice: decimalText,
    tick: decimalText,
    ticks: intIn(2, 256),
    offered: decimalText,
    supplyMode: oneOf(SUPPLY_MODES),
  },
  softcommit: {
    draft: id64,
    price: decimalText,
    amount: decimalText,
    note: optText(140),
  },
  application: {
    name: text(1, 80),
    description: text(1, 1500),
    website: url,
    team: text(1, 600),
    /** The accelerator or program the applicant says it belongs to (R7). Nothing verifies it; the page says so. */
    cohort: optText(80),
    listingType: oneOf(LISTING_IDS),
    draft: (v) => (v === undefined || v === null || v === '' ? null : id64(v)),
    baseMint: optAddr,
    contact: optText(120),
    selfChecks: (v) => {
      if (!Array.isArray(v) || v.length > 20) throw new Error('must be a list of at most 20 checks');
      return v.map((c) => {
        const o = shape(c, { id: text(1, 40), status: oneOf(CHECK_STATUS) });
        return { id: o.id, status: o.status };
      });
    },
    acknowledged: (v) => {
      if (v !== true) throw new Error('must be true: the applicant confirms the application is public and is not legal advice');
      return true;
    },
  },
  decision: { application: id64, outcome: oneOf(OUTCOMES), note: optText(1000) },
  question: { subject: addr, subjectKind: oneOf(SUBJECT_KINDS), text: text(1, 1000) },
  answer: { question: id64, text: text(1, 2000) },
};

// ---------------------------------------------------------------- storage

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS issuer_records (
  id         text PRIMARY KEY,
  kind       text NOT NULL,
  signer     text NOT NULL,
  subject    text,
  issued_at  bigint NOT NULL,
  body       jsonb NOT NULL,
  signature  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`,
  'CREATE INDEX IF NOT EXISTS issuer_records_kind_subject ON issuer_records (kind, subject, issued_at DESC)',
  'CREATE INDEX IF NOT EXISTS issuer_records_signer ON issuer_records (signer, issued_at DESC)',
];

type Row = { id: string; kind: Kind; signer: string; subject: string | null; issued_at: string | number; body: Record<string, unknown>; signature: string };
const view = (r: Row) => ({ id: r.id, kind: r.kind, signer: r.signer, subject: r.subject, issuedAt: Number(r.issued_at), body: r.body, signature: r.signature });

/** The record an item points at (its subject): a draft for a commit, an application for a decision, a question for an answer. */
function subjectOf(kind: Kind, body: Record<string, unknown>): string | null {
  switch (kind) {
    case 'softcommit':
      return body.draft as string;
    case 'decision':
      return body.application as string;
    case 'question':
      return body.subject as string;
    case 'answer':
      return body.question as string;
    case 'application':
      return (body.draft as string | null) ?? null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- draft maths

type DraftBody = { baseDecimals: number; quoteDecimals: number; minPrice: string; tick: string; ticks: number; offered: string; supplyMode: 'mint' | 'escrow' };

/** The grid in quote atoms per whole token, or the reason the draft's own grid is unusable. */
function gridOf(d: DraftBody): { min: bigint; tick: bigint } | null {
  const min = parseDecimal(d.minPrice, d.quoteDecimals);
  const tick = parseDecimal(d.tick, d.quoteDecimals);
  return min === null || tick === null || min === 0n || tick === 0n ? null : { min, tick };
}

/** A soft commit's price index on the draft's grid, its quote budget, and the tokens that budget buys at the limit price (floor). */
function commitTokens(d: DraftBody, c: { price: string; amount: string }): { index: number; budget: bigint; tokens: bigint; price: bigint } | string {
  const g = gridOf(d);
  if (!g) return 'the draft’s price grid is not valid';
  const price = parseDecimal(c.price, d.quoteDecimals);
  if (price === null || price === 0n) return `price must be above zero with at most ${d.quoteDecimals} decimal places`;
  const budget = parseDecimal(c.amount, d.quoteDecimals);
  if (budget === null || budget === 0n) return `amount must be above zero with at most ${d.quoteDecimals} decimal places`;
  if (price < g.min || (price - g.min) % g.tick !== 0n || (price - g.min) / g.tick >= BigInt(d.ticks)) return 'price is not on the draft’s price grid';
  const tokens = (budget * 10n ** BigInt(d.baseDecimals)) / price;
  if (tokens === 0n) return 'amount is too small to buy a single atom of the token at this price';
  return { index: Number((price - g.min) / g.tick), budget, tokens, price };
}

// ---------------------------------------------------------------- routes

export function registerIssuerBoard(app: FastifyInstance, d: BoardDeps): void {
  const now = () => d.clock?.() ?? Math.floor(Date.now() / 1000);
  const curators = d.curators ?? new Set<string>();
  let ready: Promise<unknown> | null = null;
  const init = () =>
    (ready ??= (async () => {
      for (const statement of SCHEMA) await d.db.query(statement);
    })().catch((e) => {
      ready = null;
      throw e;
    }));

  const byId = async (id: string, kind?: Kind): Promise<Row | null> => {
    await init();
    const r = (await d.db.query('SELECT id, kind, signer, subject, issued_at, body, signature FROM issuer_records WHERE id = $1', [id])).rows[0] as Row | undefined;
    return r && (!kind || r.kind === kind) ? r : null;
  };

  /** Rules that depend on what is already stored or on the chain index, checked at prepare and again at submit. */
  async function checkContext(kind: Kind, signer: string, body: Record<string, unknown>): Promise<void> {
    if (kind === 'softcommit') {
      const draft = await byId(body.draft as string, 'draft');
      if (!draft) throw new RequestError(404, 'no draft with that id');
      const bad = commitTokens(draft.body as unknown as DraftBody, body as { price: string; amount: string });
      if (typeof bad === 'string') throw new RequestError(400, bad);
    } else if (kind === 'application') {
      if (body.draft !== null && !(await byId(body.draft as string, 'draft'))) throw new RequestError(404, 'no draft with that id');
    } else if (kind === 'decision') {
      if (!curators.has(signer)) throw new RequestError(422, curators.size === 0 ? 'No curators are configured, so no decision can be recorded yet.' : 'Only a curator may record a decision.', { reason: 'NOT_A_CURATOR' });
      if (!(await byId(body.application as string, 'application'))) throw new RequestError(404, 'no application with that id');
    } else if (kind === 'question') {
      const o = await ownerOf(body.subject as string, body.subjectKind as 'cross' | 'treasury');
      if (!o) throw new RequestError(404, `no ${body.subjectKind as string} with that address is indexed`);
    } else if (kind === 'answer') {
      const q = await byId(body.question as string, 'question');
      if (!q) throw new RequestError(404, 'no question with that id');
      const o = await ownerOf(q.body.subject as string, q.body.subjectKind as 'cross' | 'treasury');
      if (!o) throw new RequestError(404, 'the question’s subject is no longer indexed');
      if (o !== signer) throw new RequestError(422, `Only ${o}, the ${q.body.subjectKind === 'cross' ? 'creator of the cross' : 'treasury authority'}, can answer this question.`, { reason: 'NOT_THE_OWNER', owner: o });
    }
  }

  /** Who may answer for a cross (its creator) or a treasury (its authority), from the indexer's tables. */
  async function ownerOf(subject: string, subjectKind: 'cross' | 'treasury'): Promise<string | null> {
    const sql = subjectKind === 'cross' ? 'SELECT creator AS owner FROM crosses WHERE address = $1' : 'SELECT authority AS owner FROM treasuries WHERE address = $1';
    const r = (await d.db.query(sql, [subject])).rows[0] as { owner: string } | undefined;
    return r?.owner ?? null;
  }

  app.get('/v1/issuer/curators', async (_req, reply) => send(reply, { configured: curators.size, curators: [...curators], note: curators.size === 0 ? 'No curators are configured, so applications can be submitted and read but not decided.' : 'These wallets may record decisions on applications.' }));

  app.post('/v1/issuer/records/prepare', async (req, reply) => {
    const b = req.body as { kind?: unknown; signer?: unknown; body?: unknown } | null;
    if (!b || typeof b !== 'object') throw new RequestError(400, 'body must be a JSON object');
    if (typeof b.kind !== 'string' || !(KINDS as readonly string[]).includes(b.kind)) throw new RequestError(400, `kind must be one of ${KINDS.join(', ')}`);
    if (typeof b.signer !== 'string' || !isAddress(b.signer)) throw new RequestError(400, 'signer must be a base58 Solana address');
    const kind = b.kind as Kind;
    const body = shape(b.body, SPECS[kind]);
    await init();
    await checkContext(kind, b.signer, body);
    const record: RecordEnvelope = { schema: RECORD_SCHEMA, kind, signer: b.signer, issuedAt: now(), body };
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD_BYTES) throw new RequestError(400, `the record is larger than ${MAX_RECORD_BYTES} bytes`);
    const id = recordId(record);
    return send(reply, { record, id, message: signingMessage(id) });
  });

  app.post('/v1/issuer/records', async (req, reply) => {
    const b = req.body as { record?: RecordEnvelope; signature?: unknown } | null;
    const r = b?.record;
    if (!r || typeof r !== 'object' || typeof b?.signature !== 'string') throw new RequestError(400, 'body must be { record, signature }');
    if (r.schema !== RECORD_SCHEMA) throw new RequestError(400, `schema must be ${RECORD_SCHEMA}`);
    if (typeof r.kind !== 'string' || !(KINDS as readonly string[]).includes(r.kind)) throw new RequestError(400, `kind must be one of ${KINDS.join(', ')}`);
    if (typeof r.signer !== 'string' || !isAddress(r.signer)) throw new RequestError(400, 'signer must be a base58 Solana address');
    if (!Number.isSafeInteger(r.issuedAt)) throw new RequestError(400, 'issuedAt must be unix seconds');
    // The body is re-validated: what was prepared is not trusted, since anyone can post anything here.
    const body = shape(r.body, SPECS[r.kind]);
    const record: RecordEnvelope = { schema: RECORD_SCHEMA, kind: r.kind, signer: r.signer, issuedAt: r.issuedAt, body };
    const id = recordId(record);
    const v = await verifyRecord(record, b.signature, id);
    if (!v.ok) throw new RequestError(400, `the record does not verify: ${v.reason}`);
    if (Math.abs(now() - record.issuedAt) > MAX_SKEW_SECONDS) throw new RequestError(400, `the record is dated ${record.issuedAt}, more than ${MAX_SKEW_SECONDS} s from this server’s clock; prepare it again`);
    await init();
    const dup = await byId(id);
    if (dup) return send(reply, { duplicate: true, record: view(dup) });
    const recent = (await d.db.query('SELECT count(*)::int AS n FROM issuer_records WHERE signer = $1 AND issued_at > $2', [record.signer, now() - 3600])).rows[0] as { n: number };
    if (recent.n >= HOURLY_LIMIT) throw tooMany(`This wallet has added ${HOURLY_LIMIT} records in the last hour. Try again later.`);
    await checkContext(record.kind, record.signer, body);
    const subject = subjectOf(record.kind, body);
    // The latest soft commit of a wallet on a draft replaces its earlier one: interest is a current statement, not a history.
    if (record.kind === 'softcommit') await d.db.query("DELETE FROM issuer_records WHERE kind = 'softcommit' AND signer = $1 AND subject = $2", [record.signer, subject]);
    await d.db.query('INSERT INTO issuer_records (id, kind, signer, subject, issued_at, body, signature) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)', [id, record.kind, record.signer, subject, record.issuedAt, JSON.stringify(body), b.signature]);
    return send(reply, { duplicate: false, record: view((await byId(id))!) }, 201);
  });

  app.get('/v1/issuer/records', async (req, reply) => {
    const q = req.query as { kind?: string; subject?: string; signer?: string; limit?: string };
    if (q.kind !== undefined && !(KINDS as readonly string[]).includes(q.kind)) throw new RequestError(400, `kind must be one of ${KINDS.join(', ')}`);
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RequestError(400, 'limit must be an integer in [1, 200]');
    if (q.signer !== undefined && !isAddress(q.signer)) throw new RequestError(400, 'signer must be a base58 Solana address');
    await init();
    const { rows } = await d.db.query(
      `SELECT id, kind, signer, subject, issued_at, body, signature FROM issuer_records
       WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR subject = $2) AND ($3::text IS NULL OR signer = $3)
       ORDER BY issued_at DESC, id LIMIT $4`,
      [q.kind ?? null, q.subject ?? null, q.signer ?? null, limit],
    );
    return send(reply, { records: (rows as Row[]).map(view) });
  });

  // ---- drafts and their demand

  app.get('/v1/issuer/drafts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f]{64}$/.test(id)) throw new RequestError(400, 'id must be a record id (64 lowercase hex characters)');
    const draft = await byId(id, 'draft');
    if (!draft) throw new RequestError(404, 'no draft with that id');
    const db = draft.body as unknown as DraftBody & { title: string };
    const commits = ((await d.db.query("SELECT id, signer, issued_at, body FROM issuer_records WHERE kind = 'softcommit' AND subject = $1 ORDER BY issued_at DESC", [id])).rows as Row[]).map((r) => ({ id: r.id, signer: r.signer, issuedAt: Number(r.issued_at), body: r.body as { price: string; amount: string; note: string | null } }));

    // Each committer's track record on chain: crosses they have bid in and crosses where they were filled. Read from the indexer's orders table.
    const wallets = [...new Set(commits.map((c) => c.signer))];
    const history = new Map<string, { crosses: number; filled: number }>();
    if (wallets.length) {
      const { rows } = await d.db.query(
        `SELECT owner, count(DISTINCT cross_address)::int AS crosses,
                count(DISTINCT cross_address) FILTER (WHERE fill IS NOT NULL AND fill > 0)::int AS filled
           FROM orders WHERE owner = ANY($1::text[]) GROUP BY owner`,
        [wallets],
      );
      for (const r of rows as { owner: string; crosses: number; filled: number }[]) history.set(r.owner, { crosses: r.crosses, filled: r.filled });
    }
    const quality = (w: string): 'filled-before' | 'bid-before' | 'no-history' => {
      const h = history.get(w);
      return h && h.filled > 0 ? 'filled-before' : h && h.crosses > 0 ? 'bid-before' : 'no-history';
    };

    const levels = new Map<number, { price: bigint; tokens: bigint; budget: bigint; wallets: number }>();
    const buckets = { 'filled-before': { wallets: 0, tokens: 0n }, 'bid-before': { wallets: 0, tokens: 0n }, 'no-history': { wallets: 0, tokens: 0n } };
    let totalBudget = 0n;
    let totalTokens = 0n;
    for (const c of commits) {
      const t = commitTokens(db, c.body);
      if (typeof t === 'string') continue; // cannot happen for a stored commit; skipped rather than guessed at
      const l = levels.get(t.index) ?? { price: t.price, tokens: 0n, budget: 0n, wallets: 0 };
      l.tokens += t.tokens;
      l.budget += t.budget;
      l.wallets += 1;
      levels.set(t.index, l);
      const bucket = buckets[quality(c.signer)];
      bucket.wallets += 1;
      bucket.tokens += t.tokens;
      totalBudget += t.budget;
      totalTokens += t.tokens;
    }
    const grid = gridOf(db);
    return send(reply, {
      id,
      status: 'not-verified',
      signer: draft.signer,
      issuedAt: Number(draft.issued_at),
      draft: draft.body,
      grid: grid && { minPrice: grid.min, tick: grid.tick, ticks: db.ticks, quoteDecimals: db.quoteDecimals, baseDecimals: db.baseDecimals },
      commits: { wallets: commits.length, totalBudget, totalTokens },
      levels: [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([index, l]) => ({ index, price: l.price, tokens: l.tokens, budget: l.budget, wallets: l.wallets })),
      byTrackRecord: buckets,
      notCollected: ['region', 'identity'],
      note: 'Soft commits are non-binding statements signed by wallets. No funds move and nothing here is a bid. Region is not collected: this service holds no location data and will not infer one.',
    });
  });

  // ---- applications

  app.get('/v1/issuer/applications/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!/^[0-9a-f]{64}$/.test(id)) throw new RequestError(400, 'id must be a record id (64 lowercase hex characters)');
    const a = await byId(id, 'application');
    if (!a) throw new RequestError(404, 'no application with that id');
    const dec = (await d.db.query("SELECT id, kind, signer, subject, issued_at, body, signature FROM issuer_records WHERE kind = 'decision' AND subject = $1 ORDER BY issued_at DESC LIMIT 1", [id])).rows[0] as Row | undefined;
    return send(reply, { application: view(a), decision: dec ? view(dec) : null, status: dec ? (dec.body.outcome as string) : 'submitted', curatorsConfigured: curators.size });
  });

  // ---- questions

  app.get('/v1/issuer/qa', async (req, reply) => {
    const subject = (req.query as { subject?: string }).subject;
    if (typeof subject !== 'string' || !isAddress(subject)) throw new RequestError(400, 'subject must be the base58 address of a cross or a treasury');
    const subjectKind = (await ownerOf(subject, 'cross')) ? 'cross' : (await ownerOf(subject, 'treasury')) ? 'treasury' : null;
    if (!subjectKind) throw new RequestError(404, 'no cross or treasury with that address is indexed');
    const owner = (await ownerOf(subject, subjectKind))!;
    await init();
    const qs = (await d.db.query("SELECT id, kind, signer, subject, issued_at, body, signature FROM issuer_records WHERE kind = 'question' AND subject = $1 ORDER BY issued_at DESC LIMIT 200", [subject])).rows as Row[];
    const ans = qs.length
      ? ((await d.db.query("SELECT id, kind, signer, subject, issued_at, body, signature FROM issuer_records WHERE kind = 'answer' AND subject = ANY($1::text[]) ORDER BY issued_at ASC", [qs.map((q) => q.id)])).rows as Row[])
      : [];
    const at = now();
    const questions = qs.map((q) => {
      const a = ans.find((x) => x.subject === q.id && x.signer === owner);
      const state = a ? 'answered' : at - Number(q.issued_at) > QA_OVERDUE_SECS ? 'overdue' : 'requested';
      return { ...view(q), state, answer: a ? view(a) : null };
    });
    return send(reply, { subject, subjectKind, owner, overdueAfterSecs: QA_OVERDUE_SECS, asOf: at, questions });
  });
}
