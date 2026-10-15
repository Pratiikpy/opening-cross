// Typed client of the Cleanverse cooperate API (reference v5.6). Every call goes through `call`, which owns the
// envelope: the api-id header, the AES body for the endpoints that need it, HTTP and envelope codes, retries on 5xx and
// timeouts only, and refusal of any body that is not the documented shape.
import { randomUUID } from 'node:crypto';
import { decryptText, encryptBody, keyFromApiKey } from './aes.js';
import {
  BadRequestError,
  BusinessError,
  CleanverseError,
  ConflictError,
  ForbiddenError,
  MalformedResponseError,
  NotFoundHttpError,
  OverrideRequiredError,
  ParameterError,
  ServerError,
  TransportError,
  subCodeOf,
} from './errors.js';
import { ShapeError } from './validate.js';
import * as p from './parsers.js';
import type { Chain } from './types.js';

export const SANDBOX_URL = 'https://uatapi.cleanverse.com/api/cooperate';
export const PRODUCTION_URL = 'https://api.cleanverse.com/api/cooperate';
const MAX_BODY_BYTES = 1_048_576;

export type ClientConfig = {
  /** `https://uatapi.cleanverse.com/api/cooperate` (sandbox) or the production URL. */
  baseUrl: string;
  /** Sent as the `api-id` header. */
  apiId: string;
  /** Base64 api-key: the AES key for encrypted bodies. Never sent. */
  apiKey: string;
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 15 s. */
  timeoutMs?: number;
  /** Attempts for calls that are safe to repeat (reads). Default 3. Writes are attempted once unless `retryWrites`. */
  maxAttempts?: number;
  /** First backoff; doubles each attempt with up to 25% jitter. Default 300 ms. */
  backoffMs?: number;
  retryWrites?: boolean;
  sleep?: (ms: number) => Promise<void>;
};

type CallOptions = { method: 'GET' | 'POST'; encrypted: boolean; write: boolean };

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CleanverseClient {
  private readonly key: Buffer;
  private readonly doFetch: typeof fetch;
  private readonly cfg: Required<Pick<ClientConfig, 'timeoutMs' | 'maxAttempts' | 'backoffMs' | 'retryWrites'>> & ClientConfig;

  constructor(cfg: ClientConfig) {
    if (!/^https:\/\//.test(cfg.baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(cfg.baseUrl)) throw new Error('baseUrl must be https (or a loopback address in tests)');
    if (!cfg.apiId || /[\r\n]/.test(cfg.apiId)) throw new Error('apiId is required and must be a single line');
    this.key = keyFromApiKey(cfg.apiKey);
    this.doFetch = cfg.fetch ?? fetch;
    this.cfg = { timeoutMs: 15_000, maxAttempts: 3, backoffMs: 300, retryWrites: false, ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, '') };
  }

  // ---- A-Pass management (encrypted bodies)

  async generateApass(input: p.GenerateApassInput): Promise<p.GenerateApassResult> {
    const body = p.generateApassBody(input);
    return this.call('/generate_apass', body, { method: 'POST', encrypted: true, write: true }, p.parseGenerateApass);
  }

  async updateStatus(input: { chain: Chain; address: string; status: 'activate' | 'freeze'; customerId?: string; cvRecordId?: string; blacklistReason?: string }): Promise<{ txHash: string }> {
    return this.call('/update_status', p.updateStatusBody(input), { method: 'POST', encrypted: true, write: true }, p.parseTxHash);
  }

  // ---- common queries (plain JSON)

  async queryApass(chain: Chain, address: string): Promise<p.ApassRecord> {
    return this.call('/query_apass', { chain: p.chain(chain), address: p.nonEmpty(address, 'address') }, { method: 'POST', encrypted: false, write: false }, p.parseApass);
  }

  async queryApassList(filter: p.ApassListFilter = {}): Promise<p.ApassList> {
    return this.call('/query_apass_list', p.apassListBody(filter), { method: 'POST', encrypted: false, write: false }, p.parseApassList);
  }

  async verifyApass(chain: Chain, atoken: string, address: string): Promise<p.VerifyApassResult> {
    return this.call('/verify_apass', { chain: p.chain(chain), atoken: p.nonEmpty(atoken, 'atoken'), address: p.nonEmpty(address, 'address') }, { method: 'POST', encrypted: false, write: false }, p.parseVerifyApass);
  }

  async queryDepositAtokenList(chain: Chain): Promise<p.AtokenList> {
    return this.call('/query_deposit_atoken_list', { chain: p.chain(chain) }, { method: 'POST', encrypted: false, write: false }, p.parseAtokenList);
  }

  async faucet(input: { chain: Chain; symbol: string; depositAddress: string; amount: string }): Promise<p.FaucetResult> {
    return this.call('/faucet', p.faucetBody(input), { method: 'POST', encrypted: false, write: true }, p.parseFaucet);
  }

  // ---- validator compliance reads (plain JSON)

  async validatorIsRegistered(chain: Chain, contractAddress: string): Promise<boolean> {
    return this.call('/validator/is_register', p.poolBody(chain, contractAddress), { method: 'POST', encrypted: false, write: false }, p.parseRegistered);
  }

  async validatorRules(chain: Chain, contractAddress: string): Promise<p.PoolRule[]> {
    return this.call('/validator/rules', p.poolBody(chain, contractAddress), { method: 'POST', encrypted: false, write: false }, p.parsePoolRules);
  }

  /** `valid` is the compliance outcome; a paused pool answers with a 12027 business error instead. */
  async validatorVerify(chain: Chain, contractAddress: string, userAddress: string): Promise<boolean> {
    return this.call('/validator/verify', { ...p.poolBody(chain, contractAddress), user_address: p.nonEmpty(userAddress, 'user_address') }, { method: 'POST', encrypted: false, write: false }, p.parseValid);
  }

  async validatorIsPaused(chain: Chain, contractAddress: string): Promise<boolean> {
    return this.call('/validator/is_paused', p.poolBody(chain, contractAddress), { method: 'POST', encrypted: false, write: false }, p.parsePaused);
  }

  // ---- transport

  private async call<T>(endpoint: string, body: unknown, o: CallOptions, parse: (data: unknown) => T): Promise<T> {
    const payload = JSON.stringify(o.encrypted ? encryptBody(body, this.key) : body);
    const attempts = !o.write || this.cfg.retryWrites ? this.cfg.maxAttempts : 1;
    let last: CleanverseError | undefined;
    for (let i = 1; i <= attempts; i++) {
      try {
        const raw = await this.once(endpoint, payload, o.method);
        return this.interpret(endpoint, raw, o.encrypted, parse);
      } catch (e) {
        if (!(e instanceof ServerError || e instanceof TransportError) || i === attempts) throw e;
        last = e;
        const wait = this.cfg.backoffMs * 2 ** (i - 1) * (1 + Math.random() * 0.25);
        await (this.cfg.sleep ?? sleepMs)(wait);
      }
    }
    throw last ?? new TransportError('no attempt was made', endpoint);
  }

  private async once(endpoint: string, payload: string, method: 'GET' | 'POST'): Promise<{ status: number; text: string }> {
    let res: Response;
    try {
      res = await this.doFetch(this.cfg.baseUrl + endpoint, {
        method,
        headers: { 'content-type': 'application/json', accept: 'application/json', 'api-id': this.cfg.apiId, 'x-request-id': randomUUID() },
        ...(method === 'POST' ? { body: payload } : {}),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new TransportError(`${(e as Error).name === 'TimeoutError' ? 'timed out' : 'connection failed'}: ${(e as Error).message}`, endpoint);
    }
    let text: string;
    try {
      text = await readLimited(res, MAX_BODY_BYTES, endpoint);
    } catch (e) {
      if (e instanceof CleanverseError) throw e;
      throw new TransportError(`reading the response failed: ${(e as Error).message}`, endpoint);
    }
    return { status: res.status, text };
  }

  private interpret<T>(endpoint: string, raw: { status: number; text: string }, encrypted: boolean, parse: (data: unknown) => T): T {
    const gist = raw.text.replace(/\s+/g, ' ').slice(0, 200);
    if (raw.status >= 500) throw new ServerError(`HTTP ${raw.status}: ${gist}`, endpoint, raw.status);
    if (raw.status === 400) throw new BadRequestError(`HTTP 400: ${gist}`, endpoint);
    if (raw.status === 403) throw new ForbiddenError(`HTTP 403: ${gist}`, endpoint);
    if (raw.status === 404) throw new NotFoundHttpError(`HTTP 404: ${gist}`, endpoint);
    if (raw.status === 409) throw new ConflictError(`HTTP 409: ${gist}`, endpoint);
    if (raw.status !== 200) throw new MalformedResponseError(`unexpected HTTP ${raw.status}: ${gist}`, endpoint);

    let envelope: unknown = tryJson(raw.text);
    // The reference describes an encrypted response for encrypted requests, though its examples are plain JSON: accept both.
    if (encrypted && !(isRecord(envelope) && 'code' in envelope)) {
      const cipher = typeof envelope === 'string' ? envelope : isRecord(envelope) && typeof envelope.data === 'string' && !('code' in envelope) ? envelope.data : raw.text.trim();
      try {
        envelope = tryJson(decryptText(cipher, this.key));
      } catch {
        throw new MalformedResponseError('the response is neither the documented envelope nor decryptable ciphertext', endpoint);
      }
    }
    if (!isRecord(envelope)) throw new MalformedResponseError('the response is not a JSON object', endpoint);
    const code = typeof envelope.code === 'number' ? String(envelope.code) : envelope.code;
    const message = typeof envelope.message === 'string' ? envelope.message : '';
    if (typeof code !== 'string' || code.length === 0) throw new MalformedResponseError('the response envelope has no code', endpoint);

    switch (code) {
      case '0000': {
        try {
          return parse(unwrapData(envelope.data));
        } catch (e) {
          if (e instanceof ShapeError) throw new MalformedResponseError(e.message, endpoint);
          throw e;
        }
      }
      case '0001':
        throw new ParameterError(message || 'the parameter is incorrect', endpoint, code);
      case '1000':
        throw new OverrideRequiredError(message || 'an A-Pass group would change; repeat with override', endpoint);
      case '0002':
      case '12026':
      case '12027':
        throw new BusinessError(message || 'business failure', endpoint, code, subCodeOf(message) ?? (code === '0002' ? null : code));
      default:
        throw new MalformedResponseError(`unknown envelope code ${JSON.stringify(code)}: ${message.slice(0, 120)}`, endpoint);
    }
  }
}

/** Reads a response body, stopping (and cancelling the transfer) as soon as it exceeds `limit` bytes. */
async function readLimited(res: Response, limit: number, endpoint: string): Promise<string> {
  const tooBig = () => new MalformedResponseError(`response larger than ${limit} bytes`, endpoint);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Some responses carry `data` as a JSON string (`"{}"` in the reference's error examples); decode a string that holds JSON. */
function unwrapData(data: unknown): unknown {
  if (typeof data === 'string') {
    const inner = tryJson(data);
    if (inner !== undefined) return inner;
  }
  return data;
}
