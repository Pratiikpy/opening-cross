// How the web app reaches the operations console service. The service listens on a private address and is not published by the
// reverse proxy (docs/CONFIGURATION.md), so the browser talks to this app, and this app talks to the service on the server side.
// The browser's Authorization header is passed through unchanged; nothing else of the request is. The path is checked here, not
// trusted: only `/v1/ops/...` on the configured service is reachable, and never the monitor webhook, which is authenticated by a
// secret in its path and belongs to the monitor alone.

/** The service's address on the server side. */
export function opsServiceUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.OPS_CONSOLE_URL ?? 'http://127.0.0.1:8792').replace(/\/+$/, '');
}

/** What a request may carry to the service: reads and the console's own writes. */
export const ALLOWED_METHODS = ['GET', 'POST'] as const;
/** Larger than any console request (the longest field is a 4,000-character note) and far below anything that could hurt. */
export const MAX_BODY_BYTES = 64 * 1024;

export type Upstream = { ok: true; url: string } | { ok: false; status: 400 | 404; error: string };

/**
 * The service URL for a request to `/ops/api/<segments>?<search>`. Rejects anything that is not a plain `v1/ops/...` path:
 * empty, dot or encoded-separator segments, the webhook, and any path that would resolve outside the service's console routes.
 */
export function upstreamFor(base: string, segments: readonly string[], search: string): Upstream {
  if (segments.length < 3 || segments[0] !== 'v1' || segments[1] !== 'ops') return { ok: false, status: 404, error: 'only the console routes (/v1/ops/...) are served here' };
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || /[\\/\u0000-\u001f]/.test(s) || /%(2f|5c|2e|00)/i.test(s)) return { ok: false, status: 400, error: 'the path is not valid' };
  }
  if (segments[2] === 'hooks') return { ok: false, status: 404, error: 'the monitor webhook is not served here' };
  const url = new URL(`${base}/${segments.map(encodeURIComponent).join('/')}`);
  const root = new URL(base);
  if (url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname.replace(/\/$/, '')}/v1/ops/`)) return { ok: false, status: 400, error: 'the path is not valid' };
  const q = search.startsWith('?') ? search.slice(1) : search;
  if (q) url.search = `?${q}`;
  return { ok: true, url: url.toString() };
}

/** The headers sent on: the bearer token and the body's type. A cookie, a forwarded address or anything else the browser sent is dropped. */
export function forwardHeaders(incoming: Headers): Headers {
  const out = new Headers();
  const auth = incoming.get('authorization');
  if (auth) out.set('authorization', auth);
  const type = incoming.get('content-type');
  if (type) out.set('content-type', type);
  out.set('accept', 'application/json');
  return out;
}
