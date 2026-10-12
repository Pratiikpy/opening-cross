// Mounts a paid route on a Fastify app. The route's `prepare` validates the request and loads whatever it needs; if it
// throws, the buyer gets the ordinary 4xx and is never offered a payment. Only a request that can be answered reaches
// the gate, so an unpaid call returns real requirements plus a real sample of what payment buys.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Delivery, HEADER_SIGNATURE, type X402Gate, requestKeyOf } from './gate.js';
import type { PaymentRequired } from './types.js';

export type Prepared = {
  /** Price in the asset's base units. May depend on the validated request. */
  amount: bigint;
  /** A small, real, useful part of the paid response. Shown with the requirements. */
  preview: () => Promise<unknown>;
  /** The paid response. Runs before payment settles, so it must not change anything. */
  full: () => Promise<unknown>;
};

export type PaidRouteOptions = {
  method: 'GET' | 'POST';
  /** Fastify route template, e.g. `/v1/paid/proof/:cross`. */
  url: string;
  description: string;
  mimeType?: string;
  /** Absolute origin used in `resource.url`; the request's own host is used when absent. */
  publicOrigin?: string;
  prepare: (req: FastifyRequest) => Promise<Prepared>;
};

const EXPOSE = 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After';

/** Amounts are bigint in this code base; JSON carries them as decimal strings. */
const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function howToPay(required: PaymentRequired): string {
  const a = required.accepts[0]!;
  return `Pay ${a.amount} base units of mint ${a.asset} to the associated token account of ${a.payTo} on ${a.network}, then repeat this exact request with a ${HEADER_SIGNATURE} header. The header is base64 of the x402 v2 payment payload (scheme "exact"): the transaction is a partially signed SPL TransferChecked with fee payer ${a.extra.feePayer} and the memo ${a.extra.memo} (the PAYMENT-REQUIRED response header carries the same requirements). The requirements expire in two minutes and cover this request only. @opening-cross/x402 \`createPayFetch\` does all of it. The same request can also be paid over MPP: answer the WWW-Authenticate: Payment challenge with Authorization: Payment <credential> (draft-solana-charge-00, type=transaction).`;
}

/** What a route needs of a gate; a wrapper that builds the real one on first use satisfies it. */
export type GateLike = Pick<X402Gate, 'run'>;

export function registerPaidRoute(app: FastifyInstance, gate: GateLike, o: PaidRouteOptions): void {
  app.route({
    method: o.method,
    url: o.url,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('access-control-expose-headers', EXPOSE);
      reply.header('cache-control', 'no-store');
      // Validation and data loading happen here, before any offer of payment. A throw is the route's own 4xx/5xx.
      const prepared = await o.prepare(req);
      const path = req.url.split('?')[0] ?? req.url;
      const origin = o.publicOrigin ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`;
      const raw = req.headers[HEADER_SIGNATURE.toLowerCase()] ?? req.headers['x-payment'];
      const paymentHeader = Array.isArray(raw) ? raw[0] : raw;
      // The sample is read before the challenge is minted: a request that cannot be answered is never offered for payment.
      const preview = paymentHeader ? undefined : await prepared.preview();
      const outcome = await gate.run(
        {
          route: o.url,
          resource: { url: origin + req.url, description: o.description, mimeType: o.mimeType ?? 'application/json' },
          requestKey: requestKeyOf({ method: req.method, path, query: req.query as Record<string, string | string[] | undefined>, body: req.body }),
          amount: prepared.amount,
          paymentHeader,
          authorization: typeof req.headers.authorization === 'string' && /^Payment\s/i.test(req.headers.authorization) ? req.headers.authorization : undefined,
        },
        async (): Promise<Delivery<unknown>> => ({ status: 200, body: await prepared.full() }),
      );
      for (const [k, v] of Object.entries(outcome.headers)) reply.header(k, v);
      switch (outcome.kind) {
        case 'challenge':
          return reply.code(402).type('application/json').send(json({ ...outcome.required, preview, howToPay: howToPay(outcome.required) }));
        case 'rejected':
          if (outcome.problem) return reply.code(outcome.status).type('application/problem+json').send(outcome.problem);
          return reply.code(outcome.status).type('application/json').send(json({ error: outcome.message, code: outcome.code, ...(outcome.required ? { x402: outcome.required, howToPay: howToPay(outcome.required) } : {}) }));
        case 'passthrough':
          return reply.code(outcome.status).type('application/json').send(json(outcome.body));
        case 'paid': {
          reply.raw.once('finish', () => void outcome.delivered().catch(() => undefined));
          return reply.code(outcome.status).type('application/json').send(json(outcome.body));
        }
      }
    },
  });
}
