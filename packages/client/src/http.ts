// Requests with the one behaviour a public deployment needs: ride out HTTP 429 and brief upstream failures instead of
// showing a person an error for a read that would work a second later. Only safe requests are retried here (reads, and
// builders that return an unsigned transaction without sending anything); the caller decides which those are.

export type Fetched<T> = { ok: true; data: T; status: number } | { ok: false; status: number; error: string; retryAfterSeconds?: number };

export type HttpDeps = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };

const RETRYABLE = new Set([429, 502, 503, 504]);

/** How long to wait before attempt n+1: the server's Retry-After when it gave one, else exponential, capped. */
export function retryDelayMs(attempt: number, retryAfter: string | null, jitter = Math.random()): number {
  const asked = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
  const backoff = Math.min(8_000, 400 * 2 ** (attempt - 1));
  return Math.min(15_000, Math.max(asked, backoff) + Math.floor(jitter * 250));
}

export const defaultSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function once(f: typeof fetch, url: string, init: RequestInit | undefined): Promise<{ res: Response } | { networkError: string }> {
  try {
    return { res: await f(url, init) };
  } catch (e) {
    return { networkError: e instanceof Error ? e.message : String(e) };
  }
}

/** Fetches JSON; retries 429, 502, 503, 504 and dropped connections up to `attempts` times. */
export async function fetchJson<T>(url: string, init?: RequestInit, opts: HttpDeps & { attempts?: number } = {}): Promise<Fetched<T>> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = opts.attempts ?? 4;
  let last: Fetched<T> = { ok: false, status: 0, error: 'The request could not be sent.' };
  for (let n = 1; n <= attempts; n++) {
    const r = await once(f, url, init);
    if ('networkError' in r) {
      last = { ok: false, status: 0, error: 'The server could not be reached.' };
      if (n < attempts) await sleep(retryDelayMs(n, null));
      continue;
    }
    const { res } = r;
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (res.ok) return { ok: true, data: body as T, status: res.status };
    const retryAfter = res.headers.get('retry-after');
    last = { ok: false, status: res.status, error: body?.error ?? `The server answered HTTP ${res.status}.`, ...(retryAfter && /^\d+$/.test(retryAfter) ? { retryAfterSeconds: Number(retryAfter) } : {}) };
    if (!RETRYABLE.has(res.status) || n === attempts) return last;
    await sleep(retryDelayMs(n, retryAfter));
  }
  return last;
}
