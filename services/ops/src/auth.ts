// Who is calling. A token is a long random string given to one person; the server holds only its sha-256, so a leaked configuration
// does not leak a login, and each token has a name that goes into the audit log beside everything the person does.
import { createHash, timingSafeEqual } from 'node:crypto';

export type Role = 'viewer' | 'reviewer' | 'admin';
const RANK: Record<Role, number> = { viewer: 1, reviewer: 2, admin: 3 };

export interface TokenEntry {
  name: string;
  role: Role;
  /** sha-256 of the token, lower-case hex. */
  sha256: string;
}
export interface Principal {
  name: string;
  role: Role;
}

export function parseTokens(raw: string | undefined): TokenEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('OPS_TOKENS must be JSON: [{ "name": "...", "role": "viewer|reviewer|admin", "sha256": "<hex of the token>" }]');
  }
  if (!Array.isArray(parsed)) throw new Error('OPS_TOKENS must be a JSON list');
  const seen = new Set<string>();
  return parsed.map((e: Partial<TokenEntry>, i) => {
    if (typeof e?.name !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(e.name)) throw new Error(`OPS_TOKENS[${i}].name must be 1 to 40 letters, digits, dot, dash or underscore`);
    if (e.role !== 'viewer' && e.role !== 'reviewer' && e.role !== 'admin') throw new Error(`OPS_TOKENS[${i}].role must be viewer, reviewer or admin`);
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`OPS_TOKENS[${i}].sha256 must be 64 lower-case hex characters`);
    if (seen.has(e.name)) throw new Error(`OPS_TOKENS has the name ${e.name} twice`);
    seen.add(e.name);
    return { name: e.name, role: e.role, sha256: e.sha256 };
  });
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The principal for an `Authorization: Bearer <token>` header, or null. Every entry is compared, so the time taken does not say which one matched. */
export function authenticate(header: string | undefined, tokens: readonly TokenEntry[]): Principal | null {
  const m = /^Bearer\s+(\S{16,200})$/.exec(header ?? '');
  if (!m) return null;
  const given = Buffer.from(hashToken(m[1]!), 'hex');
  let hit: TokenEntry | null = null;
  for (const t of tokens) if (timingSafeEqual(given, Buffer.from(t.sha256, 'hex'))) hit = t;
  return hit ? { name: hit.name, role: hit.role } : null;
}

export const allows = (have: Role, need: Role): boolean => RANK[have] >= RANK[need];

/** Compares a secret in a URL to the configured one without leaking where they differ. */
export function secretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
