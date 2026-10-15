// The research-note service: the template answer without a key, a model-written gated note with one, caching and limits, and a real HTTP round trip.
import { describe, expect, it } from 'vitest';
import { buildBrief } from '@opening-cross/integrity';
import type { LlmClient, LlmReply } from '@opening-cross/research';
import { createBriefService } from '../src/brief-service.js';

const CROSS = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';
const brief = buildBrief({ cross: { address: CROSS, kind: 'launch', state: 'Finalized', baseMint: 'B', quoteMint: 'Q', creator: 'C', ordersTotal: 40, protocolFeeBps: 30, clearing: { price: 1_550_000n, matched: 100n, demand: 100n, supply: 100n } } });
const wire = JSON.parse(JSON.stringify(brief, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

const model = (replies: string[]): LlmClient & { calls: number } => {
  const m = {
    name: 'scripted',
    calls: 0,
    async complete(): Promise<LlmReply> {
      return { text: replies[Math.min(m.calls++, replies.length - 1)]!, model: 'scripted', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return m;
};
const good = JSON.stringify({
  sentences: [
    { text: 'This is a launch cross with 40 orders, currently Finalized.', cites: ['cross.kind', 'cross.ordersTotal', 'cross.state'] },
    { text: 'It charges a protocol fee of 30 bps.', cites: ['cross.protocolFeeBps'] },
    { text: 'It cleared at a price of 1550000.', cites: ['cross.clearing.price'] },
    { text: 'You should bid.', cites: ['cross.ordersTotal'] },
  ],
});
const api = (calls: string[] = []) => async (url: string) => {
  calls.push(url);
  if (url.endsWith('/brief')) return wire;
  throw new Error('unexpected');
};

describe('research note service', () => {
  it('without a model key it returns the template brief and says so', async () => {
    const s = createBriefService({ apiBase: 'https://api.test', llm: null, fetchJson: api() });
    const r = await s.note(CROSS);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'opening-cross/research-note/v1', generated: 'template', fallbackReason: 'NO_MODEL', model: null });
    expect((r.body as { sentences: { origin: string }[] }).sentences.every((x) => x.origin === 'template')).toBe(true);
    expect((r.body as { note: string }).note).toMatch(/no language-model key/);
  });

  it('with a model it returns the sentences that passed, drops the one that gave advice, and lists what it dropped', async () => {
    const s = createBriefService({ apiBase: 'https://api.test', llm: model([good, good]), fetchJson: api() });
    const r = await s.note(CROSS);
    const b = r.body as { generated: string; sentences: { text: string; origin: string; cites: unknown[] }[]; dropped: { text: string; why: string[] }[]; disclosure: string; usage: { inputTokens: number } };
    expect(b.generated).toBe('llm-gated');
    expect(b.sentences).toHaveLength(3);
    expect(b.sentences.every((x) => x.origin === 'llm' && x.cites.length > 0)).toBe(true);
    expect(b.dropped).toEqual([{ text: 'You should bid.', why: ['ADVICE', 'NOTHING_STATED'] }, { text: 'You should bid.', why: ['ADVICE', 'NOTHING_STATED'] }]);
    expect(b.disclosure).toMatch(/not financial advice/i);
    expect(b.usage.inputTokens).toBeGreaterThan(0);
  });

  it('serves the same facts from memory, and asks the model again when the facts change', async () => {
    const m = model([good]);
    let t = 0;
    const s = createBriefService({ apiBase: 'https://api.test', llm: m, fetchJson: api(), now: () => t, ttlSecs: 100 });
    await s.note(CROSS);
    const callsAfterFirst = m.calls;
    expect(((await s.note(CROSS)).body as { cached: boolean }).cached).toBe(true);
    expect(m.calls).toBe(callsAfterFirst);
    t = 101_000;
    expect(((await s.note(CROSS)).body as { cached: boolean }).cached).toBe(false);
    expect(m.calls).toBeGreaterThan(callsAfterFirst);
  });

  it('past the hourly limit it serves the template note, says why, and does not cache that', async () => {
    const m = model([good]);
    const s = createBriefService({ apiBase: 'https://api.test', llm: m, fetchJson: api(), maxNotesPerHour: 1, ttlSecs: 0 });
    await s.note(CROSS);
    const limited = (await s.note(CROSS)).body as { generated: string; limited: string };
    expect(limited).toMatchObject({ generated: 'template' });
    expect(limited.limited).toMatch(/hourly limit/);
  });

  it('refuses a bad address and reports an unreadable API as 502 rather than inventing a note', async () => {
    const s = createBriefService({ apiBase: 'https://api.test', llm: model([good]), fetchJson: async () => { throw new Error('connect ECONNREFUSED'); } });
    expect((await s.note('not-an-address')).status).toBe(400);
    const r = await s.note(CROSS);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toMatch(/could not be read/);
    const s2 = createBriefService({ apiBase: 'https://api.test', llm: null, fetchJson: async () => ({ statements: 'x' }) });
    expect((await s2.note(CROSS)).status).toBe(502);
  });

  it('answers over HTTP: the note, the health check, a wrong path and a wrong method', async () => {
    const s = createBriefService({ apiBase: 'https://api.test', llm: model([good]), fetchJson: api() });
    const server = await s.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      const note = await fetch(`${base}/v1/research/cross/${CROSS}`);
      expect(note.status).toBe(200);
      expect(note.headers.get('cache-control')).toBe('no-store');
      expect(((await note.json()) as { generated: string }).generated).toBe('llm-gated');
      expect(((await (await fetch(`${base}/healthz`)).json()) as { ok: boolean }).ok).toBe(true);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect((await fetch(`${base}/v1/research/cross/${CROSS}`, { method: 'POST' })).status).toBe(405);
      expect((await fetch(`${base}/v1/research/cross/bad`)).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
