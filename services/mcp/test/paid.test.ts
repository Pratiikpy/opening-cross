// x402 over MCP: a paid tool returns the PaymentRequired object when called without payment, relays a payment to the API
// route that runs the gate, and returns the settlement in _meta. The API here is a stand-in that speaks the gate's HTTP form.
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type ApiCall, createServer } from '../src/index.js';

const CROSS = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';
const PAYLOAD = { x402Version: 2, accepted: { scheme: 'exact', amount: '10000' }, payload: { transaction: 'AAAA' } };

type Seen = { method: string; path: string; headers: Record<string, string> };

function fakeApi(mode: 'paid' | 'off' | 'rejects'): { api: ApiCall; seen: Seen[] } {
  const seen: Seen[] = [];
  const api: ApiCall = async (req) => {
    seen.push({ method: req.method, path: req.path, headers: req.headers ?? {} });
    if (mode === 'off') return { status: 501, body: { error: 'pay-per-call is not enabled on this deployment', free: 'GET /v1/crosses/:address/proof' } };
    const required = { x402Version: 2, resource: { url: 'http://api/v1/paid/verify' }, accepts: [{ scheme: 'exact', network: 'solana:test', amount: '10000', asset: 'Mint', payTo: 'Wallet', maxTimeoutSeconds: 60, extra: { feePayer: 'F', memo: 'oc1.x' } }] };
    if (!req.headers?.['payment-signature']) return { status: 402, body: { ...required, error: 'PAYMENT-SIGNATURE header is required', preview: { cross: CROSS, verified: true }, howToPay: 'HTTP-specific text that an MCP caller must not be shown' } };
    if (mode === 'rejects') return { status: 402, body: { error: 'the payment does not cover the amount', code: 'amount_mismatch', x402: required } };
    return { status: 200, body: { receipt: { signer: 'S' } }, headers: { 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: 'sig', network: 'solana:test', payer: 'P' })).toString('base64') } };
  };
  return { api, seen };
}

async function connect(api: ApiCall) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(api).connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  return client;
}

type Result = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };

describe('paid tools over MCP', () => {
  it('returns PaymentRequired in structuredContent and content[0].text, with the free sample, when called without payment', async () => {
    const f = fakeApi('paid');
    const c = await connect(f.api);
    const r = (await c.callTool({ name: 'oc_paid_verify_cross', arguments: { cross: CROSS } })) as Result;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ x402Version: 2, error: 'PAYMENT-SIGNATURE header is required', resource: { url: 'mcp://tool/oc_paid_verify_cross' }, accepts: [{ amount: '10000' }] });
    expect(JSON.parse(r.content[0]!.text!)).toEqual(r.structuredContent);
    const how = JSON.parse(r.content[1]!.text!) as { howToPay: string; freeSample: unknown };
    expect(how.freeSample).toEqual({ cross: CROSS, verified: true });
    expect(how.howToPay).toContain('x402/payment');
    expect(how.howToPay).not.toContain('HTTP-specific');
    expect(f.seen[0]).toEqual({ method: 'GET', path: `/v1/paid/verify/${CROSS}`, headers: {} });
    await c.close();
  });

  it('relays _meta["x402/payment"] as the PAYMENT-SIGNATURE header and returns the settlement in _meta', async () => {
    const f = fakeApi('paid');
    const c = await connect(f.api);
    const r = (await c.callTool({ name: 'oc_paid_verify_cross', arguments: { cross: CROSS }, _meta: { 'x402/payment': PAYLOAD } } as never)) as Result;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ receipt: { signer: 'S' } });
    expect(r._meta?.['x402/payment-response']).toEqual({ success: true, transaction: 'sig', network: 'solana:test', payer: 'P' });
    const header = f.seen[0]!.headers['payment-signature']!;
    expect(JSON.parse(Buffer.from(header, 'base64').toString('utf8'))).toEqual(PAYLOAD);
    await c.close();
  });

  it('answers a refused payment with fresh requirements in the same form', async () => {
    const f = fakeApi('rejects');
    const c = await connect(f.api);
    const r = (await c.callTool({ name: 'oc_paid_audit_bundle', arguments: { cross: CROSS }, _meta: { 'x402/payment': PAYLOAD } } as never)) as Result;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ x402Version: 2, error: 'the payment does not cover the amount', resource: { url: 'mcp://tool/oc_paid_audit_bundle' } });
    await c.close();
  });

  it('says so, with a typed code, when the deployment has pay-per-call off', async () => {
    const c = await connect(fakeApi('off').api);
    const r = (await c.callTool({ name: 'oc_draft_paid_order_desk', arguments: { cross: CROSS, owner: CROSS, nonce: '1', side: 'buy', price: '1', quantity: '1' } })) as Result;
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text!).error).toMatchObject({ code: 'NOT_ENABLED', status: 501 });
    await c.close();
  });

  it('refuses a bad argument before any request, paid or not', async () => {
    const f = fakeApi('paid');
    const c = await connect(f.api);
    const r = (await c.callTool({ name: 'oc_paid_verify_cross', arguments: { cross: 'nope' } })) as Result;
    expect(r.isError).toBe(true);
    expect(f.seen).toEqual([]);
    await c.close();
  });

  it('does not relay a payment to a free tool', async () => {
    const f = fakeApi('paid');
    const c = await connect(f.api);
    await c.callTool({ name: 'oc_get_cross', arguments: { cross: CROSS }, _meta: { 'x402/payment': PAYLOAD } } as never);
    expect(f.seen[0]!.headers).toEqual({});
    await c.close();
  });
});
