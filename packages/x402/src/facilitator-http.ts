// A facilitator over HTTP: the client a resource server uses to reach one (this repository's or a public one), and the
// routes that expose a Facilitator as one. The wire format is the standard one: POST /verify, POST /settle, GET /supported.
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { X402_VERSION } from './constants.js';
import type { Facilitator } from './facilitator.js';
import {
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
  WireError,
  parsePaymentPayload,
  parseRequirements,
  parseSettleResponse,
  parseVerifyResponse,
} from './types.js';

export type HttpFacilitatorOptions = {
  /** Sent as `Authorization: Bearer`. */
  token?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class HttpFacilitator implements Facilitator {
  private readonly base: string;
  constructor(baseUrl: string, private readonly o: HttpFacilitatorOptions = {}) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await (this.o.fetch ?? fetch)(this.base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}) },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (text.length > 1_000_000) throw new Error('the facilitator answered with more than 1 MB');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`the facilitator answered HTTP ${res.status} with something that is not JSON`);
    }
    // /verify and /settle report refusals in the body of a 200; any other status is the facilitator itself failing.
    if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 404) throw new Error(`the facilitator answered HTTP ${res.status}`);
    return json;
  }

  async supported(): Promise<SupportedResponse> {
    const j = (await this.call('GET', '/supported')) as SupportedResponse;
    if (!j || !Array.isArray(j.kinds) || typeof j.signers !== 'object') throw new WireError('invalid_facilitator_response', 'a supported response needs kinds and signers');
    return j;
  }

  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return parseVerifyResponse(await this.call('POST', '/verify', { x402Version: X402_VERSION, paymentPayload, paymentRequirements }));
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return parseSettleResponse(await this.call('POST', '/settle', { x402Version: X402_VERSION, paymentPayload, paymentRequirements }));
  }
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Mounts /verify, /settle and /supported for a facilitator. With a token, the first two require it. */
export async function registerFacilitatorRoutes(app: FastifyInstance, facilitator: Facilitator, o: { token?: string } = {}): Promise<void> {
  const authorised = (header: string | undefined) => !o.token || (header?.startsWith('Bearer ') === true && same(header.slice(7), o.token));
  app.get('/supported', async (_req, reply) => reply.send(await facilitator.supported()));
  for (const op of ['verify', 'settle'] as const) {
    app.post(`/${op}`, async (req, reply) => {
      if (!authorised(req.headers.authorization)) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'a facilitator token is required' });
      try {
        const b = req.body as { paymentPayload?: unknown; paymentRequirements?: unknown } | null;
        const payload = parsePaymentPayload(b?.paymentPayload);
        const requirements = parseRequirements(b?.paymentRequirements, 'paymentRequirements');
        return reply.send(op === 'verify' ? await facilitator.verify(payload, requirements) : await facilitator.settle(payload, requirements));
      } catch (e) {
        if (e instanceof WireError) return reply.code(400).send({ error: e.code, message: e.message });
        throw e;
      }
    });
  }
}
