import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIndexerRpc } from '../src/rpc.js';

const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
const limited = () => new Response('{"error":"rate limited"}', { status: 429, statusText: 'Too Many Requests' });

afterEach(() => vi.unstubAllGlobals());

describe('createIndexerRpc with several endpoints', () => {
  it('moves to the next endpoint at once when the first answers 429, and stays there', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string | URL | Request) => {
      const url = String(u instanceof Request ? u.url : u);
      seen.push(url);
      return url.startsWith('https://a.example') ? limited() : ok(123);
    });
    const rpc = createIndexerRpc('https://a.example, https://b.example');
    expect(await rpc.getSlot().send()).toBe(123n);
    expect(await rpc.getSlot().send()).toBe(123n);
    expect(seen.map((u) => new URL(u).host)).toEqual(['a.example', 'b.example', 'b.example']);
  });

  it('does not move on an answer, even an empty one', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string | URL | Request) => {
      seen.push(new URL(String(u instanceof Request ? u.url : u)).host);
      return ok({ context: { slot: 1 }, value: null });
    });
    const rpc = createIndexerRpc('https://a.example,https://b.example');
    await rpc.getAccountInfo('11111111111111111111111111111111' as never).send();
    expect(seen).toEqual(['a.example']);
  });
});
