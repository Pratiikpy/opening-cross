import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createRetryingRpc } from '../src/index.js';

/** A node that answers the first `throttled` requests with HTTP 429, then a valid getSlot reply. */
async function serve(throttled: number, status = 429) {
  let seen = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen++;
      if (seen <= throttled) {
        res.writeHead(status).end('Too Many Requests');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: 4242 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen: () => seen, close: () => server.close() };
}

describe('command-line RPC client', () => {
  it('rides through HTTP 429 and returns the answer', async () => {
    const s = await serve(3);
    try {
      const slot = await createRetryingRpc(s.url, { baseMs: 1, maxMs: 5 }).getSlot().send();
      expect(slot).toBe(4242n);
      expect(s.seen()).toBe(4);
    } finally {
      s.close();
    }
  });

  it('gives up after its attempts, and does not retry an error that is not transient', async () => {
    const s = await serve(100);
    try {
      await expect(createRetryingRpc(s.url, { attempts: 3, baseMs: 1, maxMs: 2 }).getSlot().send()).rejects.toThrow(/429/);
      expect(s.seen()).toBe(3);
    } finally {
      s.close();
    }
    const bad = await serve(100, 400);
    try {
      await expect(createRetryingRpc(bad.url, { attempts: 5, baseMs: 1, maxMs: 2 }).getSlot().send()).rejects.toThrow();
      expect(bad.seen()).toBe(1);
    } finally {
      bad.close();
    }
  });
});
