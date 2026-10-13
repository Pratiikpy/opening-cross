// x402 over MCP (coinbase/x402, specs/transports-v2/mcp.md): a paid tool called without payment returns a tool result with
// `isError: true` whose `structuredContent` is the `PaymentRequired` object (and whose `content[0].text` is the same object as
// JSON); the caller pays and calls again with the payment in `_meta["x402/payment"]`; the successful result carries the
// settlement in `_meta["x402/payment-response"]`.
//
// This server holds no key and verifies nothing. It relays: the paid HTTP routes of the Opening Cross API run the real gate
// (challenge, verification, ledger, settlement), and this file only translates between that gate's HTTP form and the MCP form.
import type { CallToolResult } from '@modelcontextprotocol/server';

export const PAYMENT_META_KEY = 'x402/payment';
export const PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';
export const HEADER_PAYMENT = 'payment-signature';
export const HEADER_PAYMENT_RESPONSE = 'payment-response';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The header value for the API: base64 of the JSON payment payload the caller supplied. Null when there is none. */
export function paymentHeader(meta: Obj | undefined): string | null {
  const p = meta?.[PAYMENT_META_KEY];
  if (p === undefined) return null;
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

/** A PaymentRequired from the body of the API's 402 (or of a refusal that carries fresh requirements), or null if it has none. */
export function paymentRequiredOf(body: unknown, tool: { name: string; description: string }): Obj | null {
  if (!isObj(body)) return null;
  const source = Array.isArray(body.accepts) ? body : isObj(body.x402) && Array.isArray(body.x402.accepts) ? body.x402 : null;
  if (!source) return null;
  const message = typeof body.error === 'string' ? body.error : typeof source.error === 'string' ? source.error : 'Payment required to call this tool';
  return {
    x402Version: source.x402Version ?? 2,
    error: message,
    // The payment is bound to the API request, not to this name; the resource says which tool asked for it.
    resource: { url: `mcp://tool/${tool.name}`, description: tool.description.split('\n')[0] ?? tool.name, mimeType: 'application/json' },
    accepts: source.accepts,
  };
}

/** The settlement the API reported, decoded for `_meta`, or null. */
export function settlementOf(headers: Record<string, string> | undefined): unknown {
  const raw = headers?.[HEADER_PAYMENT_RESPONSE];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** The MCP form of "payment required": both `structuredContent` and `content[0].text`, identical, plus the free sample and the way to pay as a second block. */
export function paymentRequiredResult(required: Obj, preview: unknown): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(required) }];
  content.push({
    type: 'text',
    text: JSON.stringify({
      howToPay: `Pay one of "accepts" with x402 (scheme exact), then call this tool again with the same arguments and the payment payload in _meta["${PAYMENT_META_KEY}"]. The requirements expire in two minutes and cover these arguments only. Nothing is charged unless the tool's work succeeds.`,
      ...(preview !== undefined ? { freeSample: preview } : {}),
    }),
  });
  return { isError: true, structuredContent: required, content };
}
