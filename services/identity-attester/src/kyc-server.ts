// The attester's HTTP API, for the web app (through the main API's proxy, or directly from the wallet's browser).
//   GET  /v1/identity/challenge?wallet=   ->  { wallet, issuedAt, expiresAt, message }   the text the wallet signs (needs a challenge secret)
//   POST /v1/identity/attest   { "wallet": "<address>", "issuedAt": <unix>, "signature": "<base64>" }  or, from the main API, a Bearer token
//                                         ->  { status, reasons[], attestation?, expiry?, country?, tier?, flags? }
//   GET  /v1/identity/:wallet             ->  the attestation as it is on chain
//   GET  /v1/health
// Who may ask: recording a verification publishes the wallet's country and tier on chain, so only the wallet itself (a
// signature over a fresh challenge) or the operator's own API (the bearer token) may. With neither a token nor a challenge
// secret configured the endpoint is open, for loopback use only. Input is validated before anything else happens; requests
// are limited per client address, and a wallet may trigger a provider lookup at most once per cooldown. No personal data is
// accepted, stored or returned.
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { Attester, InvalidWalletError } from './attester.js';
import { IDENTITY_CHALLENGE_TTL_SECONDS, identityChallengeMessage, verifyIdentityChallenge } from './identity-challenge.js';

export type ServerOptions = {
  /** Requests per client address per minute (default 60; 0 disables). */
  perMinute?: number;
  /** Minimum time between provider lookups for one wallet (default 10 s). */
  walletCooldownMs?: number;
  /** Shared secret the main API presents (Authorization: Bearer) to request an attestation for any wallet. */
  authToken?: string | null;
  /**
   * Turns on wallet-signed requests: the secret (32 bytes or more) the challenges are derived from. With it set and no token,
   * a request must carry the wallet's own signature; with both, either is accepted.
   */
  challengeSecret?: Uint8Array | null;
  trustProxy?: boolean;
  /** Allowed browser origins; default none (the main API is the browser-facing server). */
  corsOrigin?: string | null;
  now?: () => number;
};

export async function buildKycServer(attester: Attester, o: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024, ...(o.trustProxy ? { trustProxy: true } : {}) });
  const now = o.now ?? Date.now;
  const perMinute = o.perMinute ?? 60;
  const cooldown = o.walletCooldownMs ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  const lastLookup = new Map<string, number>();

  app.addHook('onRequest', async (req, reply) => {
    if (o.corsOrigin) {
      reply.header('access-control-allow-origin', o.corsOrigin).header('access-control-allow-methods', 'GET, POST').header('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') return reply.code(204).send();
    }
    if (perMinute <= 0 || req.url === '/v1/health') return;
    const t = now();
    for (const [k, w] of windows) if (t - w.start >= 60_000) windows.delete(k);
    const w = windows.get(req.ip);
    if (!w) windows.set(req.ip, { start: t, count: 1 });
    else if (++w.count > perMinute) {
      const retry = Math.max(1, Math.ceil((w.start + 60_000 - t) / 1000));
      return reply.header('retry-after', String(retry)).code(429).send({ error: `too many requests; retry in ${retry} s` });
    }
  });

  app.get('/v1/health', async () => ({ ok: true, provider: attester.provider.name }));

  app.get('/v1/identity/:wallet', async (req, reply) => {
    const wallet = (req.params as { wallet: string }).wallet;
    if (!isAddress(wallet)) return reply.code(400).send({ error: 'wallet must be a base58 Solana address' });
    return { wallet, ...(await attester.onChain(wallet)) };
  });

  const tokenOk = (header: string | undefined) => {
    if (!o.authToken) return false;
    const given = Buffer.from(/^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '');
    const want = Buffer.from(o.authToken);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const challengeSecret = o.challengeSecret ?? null;
  if (challengeSecret && challengeSecret.length < 32) throw new RangeError('the challenge secret must be at least 32 bytes');

  app.get('/v1/identity/challenge', async (req, reply) => {
    if (!challengeSecret) return reply.code(404).send({ error: 'this attester does not take wallet-signed requests' });
    const wallet = (req.query as { wallet?: string }).wallet;
    if (typeof wallet !== 'string' || !isAddress(wallet)) return reply.code(400).send({ error: 'wallet must be a base58 Solana address' });
    const issuedAt = Math.floor(now() / 1000);
    return { wallet, issuedAt, expiresAt: issuedAt + IDENTITY_CHALLENGE_TTL_SECONDS, message: identityChallengeMessage(challengeSecret, wallet as Address, issuedAt) };
  });

  app.post('/v1/identity/attest', async (req, reply) => {
    const b = req.body;
    if (typeof b !== 'object' || b === null || Array.isArray(b) || Object.keys(b).some((k) => !['wallet', 'issuedAt', 'signature'].includes(k))) {
      return reply.code(400).send({ error: 'body must be a JSON object with "wallet" and, for a wallet-signed request, "issuedAt" and "signature"' });
    }
    const { wallet, issuedAt, signature } = b as { wallet?: unknown; issuedAt?: unknown; signature?: unknown };
    if (typeof wallet !== 'string' || !isAddress(wallet)) return reply.code(400).send({ error: 'wallet must be a base58 Solana address' });
    if ((issuedAt === undefined) !== (signature === undefined)) return reply.code(400).send({ error: '"issuedAt" and "signature" go together' });

    // Who is asking. The operator's own API (token) may ask for any wallet; anyone else must prove they hold the wallet.
    if (!tokenOk(req.headers.authorization) && (o.authToken || challengeSecret)) {
      if (!challengeSecret || issuedAt === undefined) {
        return reply.code(401).send({ error: challengeSecret ? 'sign the challenge with the wallet first (GET /v1/identity/challenge)' : 'attestation requests are accepted from the Opening Bell API only' });
      }
      if (!Number.isInteger(issuedAt) || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return reply.code(400).send({ error: 'issuedAt must be unix seconds and signature the 64-byte signature as base64' });
      const verdict = await verifyIdentityChallenge({ secret: challengeSecret, wallet: wallet as Address, issuedAt: issuedAt as number, signature: Uint8Array.from(Buffer.from(signature, 'base64')), now: Math.floor(now() / 1000) });
      if (!verdict.ok) return reply.code(401).send({ error: `the signature was not accepted (${verdict.reason}); request a new challenge` });
    }
    const t = now();
    const last = lastLookup.get(wallet);
    if (last !== undefined && t - last < cooldown) {
      const retry = Math.max(1, Math.ceil((last + cooldown - t) / 1000));
      return reply.header('retry-after', String(retry)).code(429).send({ error: `this wallet was checked a moment ago; retry in ${retry} s` });
    }
    lastLookup.set(wallet, t);
    if (lastLookup.size > 10_000) for (const [k, v] of lastLookup) if (t - v >= cooldown) lastLookup.delete(k);
    try {
      const out = await attester.attest(wallet);
      return reply.code(out.status === 'provider_unavailable' ? 503 : 200).send({ wallet, ...out, ...(out.status === 'provider_unavailable' ? { error: 'the identity provider did not answer; nothing was recorded or removed, try again shortly' } : {}) });
    } catch (e) {
      if (e instanceof InvalidWalletError) return reply.code(400).send({ error: e.message });
      return reply.code(500).send({ error: 'the attester could not complete the request' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'invalid request' });
    return reply.code(500).send({ error: 'internal error' });
  });
  return app;
}
