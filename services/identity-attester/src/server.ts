// HTTP surface of the devnet test attester.
//   GET  /v1/attester                       what this attester checks (and does not), its credential and schema, the attestation lifetime
//   GET  /v1/attester/challenge?wallet=     the text the wallet signs
//   POST /v1/attester/attest                { wallet, issuedAt, signature (base64) } -> the attestation, once the signature verifies
import Fastify, { type FastifyReply } from 'fastify';
import { type Address, isAddress } from '@solana/kit';
import { CHALLENGE_TTL_SECONDS, CHECK_LABEL, challengeMessage, verifyChallenge } from './challenge.js';
import type { Issued } from './chain.js';

export type AttesterDeps = {
  credential: Address;
  schema: Address;
  /** Public key of the attester (the credential's authority). */
  attester: Address;
  secret: Uint8Array;
  ttlSeconds: number;
  /** Most attestations issued per hour across all wallets: every one costs the operator rent on devnet. */
  hourlyCap: number;
  issue: (wallet: Address) => Promise<Issued>;
  clock?: () => number;
  cluster?: string;
};

export async function buildAttester(d: AttesterDeps) {
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 });
  const now = () => (d.clock ? d.clock() : Math.floor(Date.now() / 1000));
  const issuedAt: number[] = [];
  const inflight = new Map<string, Promise<Issued>>();

  app.addHook('onSend', async (_req, reply) => {
    reply.header('access-control-allow-origin', '*').header('access-control-allow-methods', 'GET, POST, OPTIONS').header('access-control-allow-headers', 'content-type');
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());

  const fail = (reply: FastifyReply, status: number, error: string) => reply.code(status).send({ error });
  const walletOf = (v: unknown): Address | null => (typeof v === 'string' && isAddress(v) ? v : null);

  app.get('/v1/attester', async () => ({
    label: CHECK_LABEL,
    cluster: d.cluster ?? 'devnet',
    attester: d.attester,
    credential: d.credential,
    schema: d.schema,
    check: 'The requester signs a short text with the wallet key. That proves control of the wallet and nothing else.',
    notChecked: ['who holds the wallet', 'residence or nationality', 'accredited-investor status', 'sanctions screening'],
    attestationLifetimeSeconds: d.ttlSeconds,
    challengeValiditySeconds: CHALLENGE_TTL_SECONDS,
  }));

  app.get('/v1/attester/challenge', async (req, reply) => {
    const wallet = walletOf((req.query as { wallet?: string }).wallet);
    if (!wallet) return fail(reply, 400, 'wallet must be a base58 Solana address');
    const at = now();
    return { wallet, issuedAt: at, message: challengeMessage(d.secret, wallet, at), expiresAt: at + CHALLENGE_TTL_SECONDS, label: CHECK_LABEL };
  });

  app.post('/v1/attester/attest', async (req, reply) => {
    const b = req.body as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(reply, 400, 'request body must be a JSON object');
    const wallet = walletOf(b.wallet);
    if (!wallet) return fail(reply, 400, 'wallet must be a base58 Solana address');
    if (typeof b.issuedAt !== 'number' || !Number.isInteger(b.issuedAt)) return fail(reply, 400, 'issuedAt must be the integer from the challenge');
    if (typeof b.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(b.signature)) return fail(reply, 400, 'signature must be the 64-byte Ed25519 signature, base64 encoded');
    const verdict = await verifyChallenge({ secret: d.secret, wallet, issuedAt: b.issuedAt, signature: new Uint8Array(Buffer.from(b.signature, 'base64')), now: now() });
    if (!verdict.ok) return fail(reply, verdict.reason === 'expired' ? 410 : 403, `the challenge was refused: ${verdict.reason}. Ask for a new one.`);

    // One issuance per wallet at a time, and a ceiling per hour so a flood cannot drain the operator's devnet SOL.
    let job = inflight.get(wallet);
    if (!job) {
      const cutoff = now() - 3600;
      while (issuedAt.length > 0 && issuedAt[0]! < cutoff) issuedAt.shift();
      if (issuedAt.length >= d.hourlyCap) return fail(reply, 429, `this attester issues at most ${d.hourlyCap} attestations an hour; try again later`);
      issuedAt.push(now());
      job = d.issue(wallet).finally(() => inflight.delete(wallet));
      inflight.set(wallet, job);
    }
    try {
      const r = await job;
      return { wallet, attestation: r.attestation, credential: d.credential, schema: d.schema, expiry: r.expiry.toString(), reused: r.reused, signature: r.signature, label: CHECK_LABEL };
    } catch (e) {
      console.error(JSON.stringify({ at: new Date().toISOString(), route: '/v1/attester/attest', error: String(e) }));
      return fail(reply, 502, 'the attestation could not be written to the cluster; nothing was issued. Try again in a moment.');
    }
  });

  return app;
}
