// The open preset registry (PRODUCT_FEATURES L2, X15).
//
//   POST /v1/presets                                  a preset document signed by its author
//   GET  /v1/presets[?tag=&kind=]                     the newest version of every preset, with how its crosses fared
//   GET  /v1/presets/:author/:id                      every version of one preset
//   GET  /v1/presets/:author/:id/:version/use         the create-cross fields the preset sets and the memo to put in the creation transaction
//   GET  /v1/presets/:author/:id/performance[?version=]  outcomes of the crosses that carried the preset memo
//
// What this is not: a ranking, advice, or a payment. A royalty an author declares is a claim in the document; nothing on chain pays it
// (sharing a fee with a preset's author needs a program change, recorded under HUMAN_TASKS). Performance counts only crosses whose creation
// transaction carries the memo, read from the chain, so an author cannot claim a cross that did not use the preset.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { type Address, isAddress } from '@solana/kit';
import { MEMO_PREFIX, type SignedPreset, type UsedCross, checkSignedPreset, parsePresetMemo, performance, presetMemo, PresetError } from '@opening-cross/preset-registry';
import { RequestError } from '../tx.js';
import type { ApiDeps } from '../server.js';

export type PresetsDeps = Pick<ApiDeps, 'db' | 'clock' | 'network'>;
export type PresetsOptions = {
  /** The memos of a transaction, or null if it cannot be read. Default: JSON-RPC `getTransaction` at RPC_URL. */
  memosOf?: (signature: string) => Promise<string[] | null>;
  /** Wallets the operator runs, excluded from "external". */
  ownWallets?: ReadonlySet<string>;
  /** Most creation transactions read in one request. Default 20. */
  maxScan?: number;
  minimumSample?: number;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

async function rpcMemos(url: string, signature: string): Promise<string[] | null> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }] }), signal: AbortSignal.timeout(15_000) });
  if (res.status === 429 || res.status >= 500) throw new Error(`HTTP error (${res.status}) from the RPC endpoint`);
  const j = (await res.json()) as { result?: { transaction: { message: { instructions: { program?: string; parsed?: unknown }[] } }; meta?: { innerInstructions?: { instructions: { program?: string; parsed?: unknown }[] }[] } } | null; error?: { message: string } };
  if (j.error && /rate limit|429/i.test(j.error.message)) throw new Error(`HTTP error (429): ${j.error.message}`);
  if (!j.result) return null;
  const all = [...j.result.transaction.message.instructions, ...(j.result.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  return all.filter((i) => i.program === 'spl-memo' && typeof i.parsed === 'string').map((i) => i.parsed as string);
}

export function registerPresets(app: FastifyInstance, d: PresetsDeps, o: PresetsOptions = {}): void {
  const cluster = d.network ?? 'unknown';
  const memosOf = o.memosOf ?? (process.env.RPC_URL ? (s: string) => rpcMemos(process.env.RPC_URL!, s) : async () => null);
  const own = o.ownWallets ?? new Set<string>();
  const maxScan = o.maxScan ?? 20;
  const min = o.minimumSample ?? 5;

  /** Reads the creation transactions of crosses not yet looked at, so memos are attributed. A read that fails is tried again next time. */
  async function scan(): Promise<{ scanned: number; remaining: number }> {
    const { rows } = await d.db.query<{ address: string; signature: string }>(
      `SELECT c.address, e.signature FROM crosses c JOIN events e ON e.cross_address = c.address AND e.name = 'CrossCreated'
        WHERE NOT EXISTS (SELECT 1 FROM preset_uses u WHERE u.cross_address = c.address) ORDER BY c.created_slot DESC`,
    );
    let done = 0;
    for (const r of rows.slice(0, maxScan)) {
      let memos: string[] | null;
      try {
        memos = await memosOf(r.signature);
      } catch {
        continue;
      }
      if (memos === null) continue;
      const hit = memos.map(parsePresetMemo).find((x) => x !== null) ?? null;
      await d.db.query('INSERT INTO preset_uses (cross_address, author, preset_id, version, signature) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [r.address, hit?.author ?? null, hit?.id ?? null, hit?.version ?? null, r.signature]);
      done += 1;
    }
    return { scanned: done, remaining: Math.max(0, rows.length - done) };
  }

  async function usedBy(author: string, id: string, version?: number): Promise<UsedCross[]> {
    const { rows } = await d.db.query<{ address: string; state: string; creator: string; orders: number; wallets: number; external: number; matched_bps: string | null }>(
      `SELECT c.address, c.state, c.creator,
              (SELECT count(*)::int FROM orders o WHERE o.cross_address = c.address AND o.status <> 'cancelled') AS orders,
              (SELECT count(DISTINCT o.owner)::int FROM orders o WHERE o.cross_address = c.address AND o.status <> 'cancelled') AS wallets,
              (SELECT count(DISTINCT o.owner)::int FROM orders o WHERE o.cross_address = c.address AND o.status <> 'cancelled' AND o.owner <> c.creator AND NOT (o.owner = ANY($4::text[]))) AS external,
              CASE WHEN c.matched IS NULL OR c.clearing_price IS NULL THEN NULL
                   ELSE (c.matched * 10000 / NULLIF(GREATEST((SELECT coalesce(sum(o.quantity),0) FROM orders o WHERE o.cross_address = c.address AND o.side = 0 AND o.price >= c.clearing_price), (SELECT coalesce(sum(o.quantity),0) FROM orders o WHERE o.cross_address = c.address AND o.side = 1 AND o.price <= c.clearing_price)), 0))::text END AS matched_bps
         FROM preset_uses u JOIN crosses c ON c.address = u.cross_address
        WHERE u.author = $1 AND u.preset_id = $2 AND ($3::int IS NULL OR u.version = $3)`,
      [author, id, version ?? null, [...own]],
    );
    return rows.map((r) => ({ cross: r.address, state: r.state as UsedCross['state'], creator: r.creator, orders: r.orders, wallets: r.wallets, matchedBps: r.matched_bps === null ? null : Math.min(10_000, Number(r.matched_bps)), externalWallets: r.external }));
  }

  app.post('/v1/presets', async (req, reply) => {
    const doc = req.body as SignedPreset | null;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.body !== 'object' || doc.body === null) throw new RequestError(400, 'request body must be a signed preset { body, id, signer, signature }');
    try {
      await checkSignedPreset(doc);
    } catch (e) {
      if (e instanceof PresetError) throw new RequestError(400, e.message);
      throw e;
    }
    const b = doc.body;
    // A new version of a preset has to be a higher version than any the author has published: a published version never changes.
    const latest = (await d.db.query<{ version: number }>('SELECT max(version) AS version FROM presets WHERE author = $1 AND preset_id = $2', [b.author, b.id])).rows[0]?.version ?? 0;
    if (b.version <= latest) throw new RequestError(409, `version ${b.version} is not above the latest published version, ${latest}; a published version is never changed, publish a higher one`);
    await d.db.query('INSERT INTO presets (author, preset_id, version, doc_id, doc, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [b.author, b.id, b.version, doc.id, JSON.stringify(doc), b.createdAt]);
    return send(reply, { stored: true, author: b.author, id: b.id, version: b.version, memo: presetMemo(b.author, b.id, b.version), royaltyNote: b.royaltyBps > 0 ? 'The royalty is a declared claim; nothing on chain pays it.' : undefined }, 201);
  });

  app.get('/v1/presets', async (req, reply) => {
    const q = req.query as { tag?: string; kind?: string };
    const { rows } = await d.db.query<{ doc: SignedPreset }>(
      `SELECT DISTINCT ON (author, preset_id) doc FROM presets ORDER BY author, preset_id, version DESC`,
    );
    const scanned = await scan();
    const out = [];
    for (const r of rows) {
      const b = r.doc.body;
      if (q.tag && !b.tags.includes(q.tag)) continue;
      if (q.kind && b.fields.kind !== q.kind) continue;
      out.push({ author: b.author, id: b.id, version: b.version, name: b.name, summary: b.summary, kind: b.fields.kind, disclosure: b.fields.disclosure, tags: b.tags, royaltyBps: b.royaltyBps, performance: performance(await usedBy(b.author, b.id), min) });
    }
    return send(reply, { schema: 'opening-cross/presets/v1', network: cluster, presets: out, attribution: { ...scanned, note: 'Crosses count once their creation transaction has been read; "remaining" are read on later requests.' }, notice: 'Not a ranking and not advice. Royalties are declared claims, not payments.' });
  });

  const author = (v: string) => {
    if (!isAddress(v)) throw new RequestError(400, 'author must be a base58 address');
    return v as Address;
  };

  app.get('/v1/presets/:author/:id', async (req, reply) => {
    const p = req.params as { author: string; id: string };
    const { rows } = await d.db.query<{ doc: SignedPreset }>('SELECT doc FROM presets WHERE author = $1 AND preset_id = $2 ORDER BY version DESC', [author(p.author), p.id]);
    if (rows.length === 0) throw new RequestError(404, 'no such preset');
    return send(reply, { author: p.author, id: p.id, versions: rows.map((r) => r.doc) });
  });

  app.get('/v1/presets/:author/:id/performance', async (req, reply) => {
    const p = req.params as { author: string; id: string };
    const raw = (req.query as { version?: string }).version;
    const version = raw === undefined ? undefined : Number(raw);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new RequestError(400, 'version must be a positive whole number');
    if ((await d.db.query('SELECT 1 FROM presets WHERE author = $1 AND preset_id = $2', [author(p.author), p.id])).rowCount === 0) throw new RequestError(404, 'no such preset');
    const scanned = await scan();
    return send(reply, { author: p.author, id: p.id, version: version ?? 'all', network: cluster, ...performance(await usedBy(p.author, p.id, version), min), attribution: scanned });
  });

  app.get('/v1/presets/:author/:id/:version/use', async (req, reply) => {
    const p = req.params as { author: string; id: string; version: string };
    const v = Number(p.version);
    if (!Number.isInteger(v) || v < 1) throw new RequestError(400, 'version must be a positive whole number');
    const row = (await d.db.query<{ doc: SignedPreset }>('SELECT doc FROM presets WHERE author = $1 AND preset_id = $2 AND version = $3', [author(p.author), p.id, v])).rows[0];
    if (!row) throw new RequestError(404, 'no such preset version');
    const b = row.doc.body;
    return send(reply, { preset: { author: b.author, id: b.id, version: b.version, name: b.name }, fields: b.fields, memo: presetMemo(b.author, b.id, b.version), memoPrefix: MEMO_PREFIX, howToUse: 'Set the fields in the create-cross form (every field stays editable) and add the memo to the creation transaction, so the cross is counted in this preset\'s performance. A cross without the memo is not attributed. The preset sets no price, supply or raise.', royaltyBps: b.royaltyBps, royaltyNote: 'Declared by the author. Nothing on chain pays it.', document: row.doc });
  });
}
