// A social layer that holdings decide (ROADMAP M8; ADR-0406): comments on a cross, signed by the wallet that writes them, open only
// to wallets that took part in the cross or hold its token, and shown with the weight that participation carries.
//
//   GET  /v1/crosses/:address/comments          the visible comments, heaviest first, each with its author's weight when posted
//   POST /v1/crosses/:address/comments          { author, signedAt, body, signature } : the message below, signed with the author's key
//   POST /v1/comments/:id/hide                  moderator only (Authorization: Bearer MODERATOR_TOKEN); hides, never deletes
//
// The signed message is the plain text the wallet shows when asked to sign, so the author sees what is being said and where:
//   Opening Bell comment\ncross: <address>\nsigned at: <unix seconds>\n\n<body>
// Spam is made expensive rather than policed: a wallet with no order in the cross and no balance of its token cannot post at all,
// one comment a minute and twenty a day per wallet, no links, 500 characters. The weight is the share of the cross's matched
// amount the author held in the token when posting (basis points), or null where it cannot be known; it orders comments and is
// shown beside them, and a comment is never promoted by anything else.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Address, getBase58Encoder, getPublicKeyFromAddress, isAddress, verifySignature } from '@solana/kit';
import { ata } from '@opening-cross/sdk';
import { decodeCross } from '@opening-cross/client';
import { RequestError } from '../tx.js';
import type { Db } from './holder-alerts-store.js';

type ChainAccount = { data: Uint8Array; owner: Address };

export type HolderSocialDeps = {
  db: Db;
  account: (a: Address) => Promise<ChainAccount | null>;
  clock?: () => number;
  /** Bearer token that may hide comments; default MODERATOR_TOKEN. With none set, nothing can be hidden. */
  moderatorToken?: string | null;
};

export const MAX_BODY = 500;
export const SIGNATURE_WINDOW = 300;
export const PER_MINUTE_GAP = 60;
export const PER_DAY = 20;

export const commentMessage = (cross: string, signedAt: number, body: string) => `Opening Bell comment\ncross: ${cross}\nsigned at: ${signedAt}\n\n${body}`;

/** Why a body cannot be posted, or null. */
export function bodyProblem(body: unknown): string | null {
  if (typeof body !== 'string') return 'body must be text';
  const t = body.trim();
  if (t.length === 0) return 'say something: the comment is empty';
  if (t.length > MAX_BODY) return `comments are at most ${MAX_BODY} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(t)) return 'the comment contains control or direction-changing characters';
  if (/(https?:\/\/|www\.|[a-z0-9-]+\.(com|io|xyz|app|net|org|co|gg|me|sol)\b)/i.test(t)) return 'links are not allowed in comments';
  return null;
}

/** Share of `matched` the author holds, in basis points, capped at 100%; null when the cross printed nothing. */
export function weightBps(held: bigint, matched: bigint | null): number | null {
  if (matched === null || matched <= 0n) return null;
  const bps = (held * 10_000n) / matched;
  return Number(bps > 10_000n ? 10_000n : bps);
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const send = (reply: FastifyReply, v: unknown, status = 200) => reply.code(status).type('application/json').send(json(v));

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cross_comments (
     id         text PRIMARY KEY,
     cross_address text NOT NULL,
     author     text    NOT NULL,
     body       text    NOT NULL,
     signed_at  bigint  NOT NULL,
     signature  text    NOT NULL,
     weight_bps integer,
     role       text    NOT NULL,
     created_at bigint  NOT NULL,
     hidden     boolean NOT NULL DEFAULT false
   )`,
  `CREATE INDEX IF NOT EXISTS cross_comments_cross ON cross_comments (cross_address, created_at)`,
  `CREATE INDEX IF NOT EXISTS cross_comments_author ON cross_comments (author, created_at)`,
];

export function registerHolderSocial(app: FastifyInstance, deps: HolderSocialDeps) {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  const moderator = deps.moderatorToken === undefined ? process.env.MODERATOR_TOKEN?.trim() || null : deps.moderatorToken;
  let ready: Promise<unknown> | null = null;
  const q = async (text: string, params: unknown[] = []) => {
    ready ??= (async () => {
      for (const s of SCHEMA) await deps.db.query(s);
    })().catch((e) => {
      ready = null;
      throw e;
    });
    await ready;
    return (await deps.db.query(text, params)).rows;
  };

  async function crossFacts(raw: string) {
    if (!isAddress(raw)) throw new RequestError(400, 'cross must be a base58 Solana address');
    const acct = await deps.account(raw);
    const data = acct ? decodeCross(acct) : null;
    if (!data) throw new RequestError(404, `${raw} is not an Opening Cross account on this cluster`);
    return data;
  }

  app.get('/v1/crosses/:address/comments', async (req, reply) => {
    const address = (req.params as { address: string }).address;
    if (!isAddress(address)) throw new RequestError(400, 'cross must be a base58 Solana address');
    const limit = Math.min(100, Math.max(1, Number((req.query as { limit?: string }).limit ?? 50) || 50));
    const rows = await q(
      `SELECT id, author, body, signed_at, signature, weight_bps, role, created_at FROM cross_comments
       WHERE cross_address = $1 AND NOT hidden ORDER BY weight_bps DESC NULLS LAST, created_at DESC LIMIT $2`,
      [address, limit],
    );
    return send(reply, {
      cross: address,
      comments: rows.map((r) => ({ id: r.id, author: r.author, body: r.body, signedAt: Number(r.signed_at), signature: r.signature, weightBps: r.weight_bps === null ? null : Number(r.weight_bps), role: r.role, createdAt: Number(r.created_at) })),
      note: 'Each comment is signed by its author’s wallet; the signature can be checked against the message "Opening Bell comment, cross, signed at, body". Weight is the author’s share of the cross’s matched amount in the token when posting.',
    });
  });

  app.post('/v1/crosses/:address/comments', async (req, reply) => {
    const crossAddress = (req.params as { address: string }).address;
    const data = await crossFacts(crossAddress);
    const b = req.body as { author?: unknown; signedAt?: unknown; body?: unknown; signature?: unknown } | null;
    if (!b || typeof b !== 'object') throw new RequestError(400, 'request body must be a JSON object');
    if (typeof b.author !== 'string' || !isAddress(b.author)) throw new RequestError(400, 'author must be a base58 Solana address');
    const author = b.author as Address;
    const problem = bodyProblem(b.body);
    if (problem) throw new RequestError(400, problem);
    const body = (b.body as string).trim();
    const now = clock();
    const signedAt = b.signedAt;
    if (typeof signedAt !== 'number' || !Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > SIGNATURE_WINDOW) throw new RequestError(400, `signedAt must be unix seconds within ${SIGNATURE_WINDOW} seconds of now`);
    if (typeof b.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(b.signature)) throw new RequestError(400, 'signature must be the base58 Ed25519 signature of the message');
    let ok = false;
    try {
      const sig = getBase58Encoder().encode(b.signature);
      ok = sig.length === 64 && (await verifySignature(await getPublicKeyFromAddress(author), sig as never, new TextEncoder().encode(commentMessage(crossAddress, signedAt, body))));
    } catch {
      ok = false;
    }
    if (!ok) throw new RequestError(400, 'the signature does not match this author, cross, time and text');

    // Who may speak: a wallet that placed an order here, or one that holds the cross's token.
    const orders = await q(`SELECT 1 FROM orders WHERE cross_address = $1 AND owner = $2 AND status <> 'cancelled' LIMIT 1`, [crossAddress, author]);
    let held = 0n;
    if (data.baseBound) {
      const t = await deps.account(await ata(author, data.baseMint, data.baseTokenProgram));
      if (t && t.data.length >= 72) held = new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(64, true);
    }
    if (orders.length === 0 && held === 0n) throw new RequestError(409, 'only a wallet that placed an order in this cross, or holds its token, can comment on it');
    const matched = data.clearing.__option === 'Some' ? data.clearing.value.matched : null;
    const role = held > 0n ? 'holder' : 'bidder';

    const recent = await q('SELECT created_at FROM cross_comments WHERE author = $1 AND created_at > $2 ORDER BY created_at DESC', [author, now - 86_400]);
    if (recent.length >= PER_DAY) throw new RequestError(409, `a wallet can post ${PER_DAY} comments a day`);
    if (recent[0] && now - Number(recent[0].created_at) < PER_MINUTE_GAP) throw new RequestError(409, 'one comment a minute: wait a little and post again');

    const id = createHash('sha256').update(`${crossAddress}\n${author}\n${signedAt}\n${body}`).digest('hex').slice(0, 24);
    const inserted = await q(
      `INSERT INTO cross_comments (id, cross_address, author, body, signed_at, signature, weight_bps, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, crossAddress, author, body, signedAt, b.signature, weightBps(held, matched), role, now],
    );
    if (inserted.length === 0) throw new RequestError(409, 'this exact comment was already posted');
    return send(reply, { id, role, weightBps: weightBps(held, matched) }, 201);
  });

  app.post('/v1/comments/:id/hide', async (req, reply) => {
    const auth = String(req.headers.authorization ?? '');
    if (!moderator || auth !== `Bearer ${moderator}`) return send(reply, { error: 'moderation is not available to this caller' }, 403);
    const id = (req.params as { id: string }).id;
    const rows = await q('UPDATE cross_comments SET hidden = true WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) throw new RequestError(404, 'no such comment');
    return send(reply, { hidden: true, id });
  });
}
