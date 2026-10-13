// Comments on a cross (M8; ADR-0406): the text a wallet signs, the rules a comment must meet before it is sent, and the calls. The
// rules are the server's own, repeated here so a person is told before a wallet prompt appears and not after it.
import { HOLDER_API_URL } from './holder-api';

export const MAX_BODY = 500;

export const commentMessage = (cross: string, signedAt: number, body: string) => `Opening Bell comment\ncross: ${cross}\nsigned at: ${signedAt}\n\n${body}`;

/** Why a body cannot be posted, or null. Mirrors services/api/src/routes/holder-social.ts. */
export function bodyProblem(body: string): string | null {
  const t = body.trim();
  if (t.length === 0) return 'Write something first.';
  if (t.length > MAX_BODY) return `Comments are at most ${MAX_BODY} characters.`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(t)) return 'The comment contains control or direction-changing characters.';
  if (/(https?:\/\/|www\.|[a-z0-9-]+\.(com|io|xyz|app|net|org|co|gg|me|sol)\b)/i.test(t)) return 'Links are not allowed in comments.';
  return null;
}

export type Comment = { id: string; author: string; body: string; signedAt: number; signature: string; weightBps: number | null; role: 'holder' | 'bidder'; createdAt: number };

export async function listComments(cross: string): Promise<Comment[] | null> {
  try {
    const r = await fetch(`${HOLDER_API_URL}/v1/crosses/${cross}/comments`, { cache: 'no-store' });
    return r.ok ? ((await r.json()) as { comments: Comment[] }).comments : null;
  } catch {
    return null;
  }
}

export async function postComment(cross: string, payload: { author: string; signedAt: number; body: string; signature: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${HOLDER_API_URL}/v1/crosses/${cross}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? { ok: true } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: 'The Opening Cross API could not be reached.' };
  }
}

/** `held 25% of what the cross matched`, or a plain role line when the weight is not known. */
export function weightLabel(c: Pick<Comment, 'weightBps' | 'role'>): string {
  if (c.weightBps === null) return c.role === 'holder' ? 'holds the token' : 'bid in this cross';
  if (c.weightBps === 0) return c.role === 'holder' ? 'holds a very small amount' : 'bid in this cross';
  const pct = c.weightBps / 100;
  return `held ${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% of what the cross matched`;
}
