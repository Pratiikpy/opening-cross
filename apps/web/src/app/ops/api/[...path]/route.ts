import type { NextRequest } from 'next/server';
import { MAX_BODY_BYTES, forwardHeaders, opsServiceUrl, upstreamFor } from '../../../../components/ops/proxy';

// The console's requests carry a person's token and answer with the log and with compliance notes: nothing here is cached, and
// nothing is rendered ahead of time.
export const dynamic = 'force-dynamic';

/** Evidence is gathered from several sources when a review is opened, each with a 25 second limit, in parallel. */
const UPSTREAM_TIMEOUT_MS = 50_000;

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } as const;

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

async function pass(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const target = upstreamFor(opsServiceUrl(), path, req.nextUrl.search);
  if (!target.ok) return refuse(target.status, target.error);

  let body: ArrayBuffer | undefined;
  if (req.method === 'POST') {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) return refuse(413, 'the request is too large');
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return refuse(413, 'the request is too large');
  }
  try {
    const res = await fetch(target.url, { method: req.method, headers: forwardHeaders(req.headers), ...(body !== undefined && body.byteLength > 0 ? { body } : {}), redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', ...NO_STORE } });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return refuse(502, timedOut ? 'the console service did not answer in time' : 'the console service could not be reached (is OPS_CONSOLE_URL right, and is the service running?)');
  }
}

export const GET = pass;
export const POST = pass;
