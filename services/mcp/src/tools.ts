// The tool catalog. Reads call GET routes of the Opening Cross API; drafts call the API's POST /v1/tx/* routes,
// which return an UNSIGNED transaction. This server holds no key, so it cannot sign or send anything: the agent's
// own wallet signs a draft and sends it, or does not.
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** read: nothing changes. draft: returns an unsigned transaction that moves nothing until the caller signs it. */
  readonly kind: 'read' | 'draft';
  readonly inputSchema: JsonSchema;
  /** Builds the API request from validated arguments. */
  readonly request: (args: Record<string, unknown>) => { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> };
  /** Where third-party strings sit in the response (see untrusted.ts). */
  readonly untrusted: readonly string[];
}

const ADDRESS = { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$', description: 'A base58 Solana address.' };
const U64 = { type: 'string', pattern: '^[0-9]{1,20}$', description: 'An unsigned 64-bit integer as a decimal string.' };
const obj = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required });
const enc = encodeURIComponent;
const str = (v: unknown): string => String(v);

const crossArg = { cross: { ...ADDRESS, description: 'Address of the cross.' } };
const ownerArg = { owner: { ...ADDRESS, description: 'The wallet that will sign; it pays fees and owns the order.' } };

/** Strings in an identity verdict that come from the token itself or quote it. */
const VERDICT_TEXT = ['/observed/name', '/observed/symbol', '/listing/name', '/impersonates/*/name', '/reasons/*/message'];

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'oc_get_stats',
    title: 'Protocol totals',
    description: 'Totals across all crosses: how many printed, buyers filled, quote paid to sellers and refunded to buyers, and crosses that did not print.',
    kind: 'read',
    inputSchema: obj({}, []),
    request: () => ({ method: 'GET', path: '/v1/stats' }),
    untrusted: [],
  },
  {
    name: 'oc_list_crosses',
    title: 'List crosses',
    description: 'Crosses, newest first. A cross is a call auction: orders gather during a window and everything trades at one clearing price.',
    kind: 'read',
    inputSchema: obj({ state: { type: 'string', enum: ['Live', 'Cleared', 'NoPrint', 'Finalized'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, []),
    request: (a) => ({ method: 'GET', path: `/v1/crosses?${a.state ? `state=${enc(str(a.state))}&` : ''}limit=${a.limit ?? 50}` }),
    untrusted: [],
  },
  {
    name: 'oc_get_cross',
    title: 'One cross',
    description: 'State, window, grid, fees, order counts and result of one cross, read from chain.',
    kind: 'read',
    inputSchema: obj({ cross: ADDRESS }, ['cross']),
    request: (a) => ({ method: 'GET', path: `/v1/crosses/${enc(str(a.cross))}` }),
    untrusted: [],
  },
  {
    name: 'oc_get_book',
    title: 'Resting book and indicative price',
    description: 'The visible book of an open-book cross and the price it would clear at if it closed now. A sealed cross shows nothing until bids are revealed.',
    kind: 'read',
    inputSchema: obj({ cross: ADDRESS }, ['cross']),
    request: (a) => ({ method: 'GET', path: `/v1/crosses/${enc(str(a.cross))}/book` }),
    untrusted: [],
  },
  {
    name: 'oc_get_proof',
    title: 'Fairness proof',
    description: 'An independent implementation recomputes a settled cross from its on-chain book and reports whether it matches the recorded result.',
    kind: 'read',
    inputSchema: obj({ cross: ADDRESS }, ['cross']),
    request: (a) => ({ method: 'GET', path: `/v1/crosses/${enc(str(a.cross))}/proof` }),
    untrusted: [],
  },
  {
    name: 'oc_get_signed_band',
    title: 'Signed price band',
    description:
      'The latest signed price band for a cross: where its final price is expected to land, signed before the outcome, with its grade once the cross prints. A provisional band claims no coverage; a calibrated one states the share of crosses it is expected to hold for.',
    kind: 'read',
    inputSchema: obj({ cross: ADDRESS }, ['cross']),
    request: (a) => ({ method: 'GET', path: `/v1/crosses/${enc(str(a.cross))}/promise` }),
    untrusted: [],
  },
  {
    name: 'oc_get_track_record',
    title: 'Track record of the signed bands',
    description: 'Every signed band counted by outcome (hit, miss, scored, void, unresolved), with calibration state per time bucket. Misses and unresolved bands are included.',
    kind: 'read',
    inputSchema: obj({}, []),
    request: () => ({ method: 'GET', path: '/v1/accuracy' }),
    untrusted: [],
  },
  {
    name: 'oc_check_token',
    title: 'Is this token real?',
    description:
      'Identity of a mainnet token mint against the issuers\' own lists and the issuer keys on chain: genuine, a copy, an address look-alike, another issuer\'s stock token, or unrelated. States who issued it, not whether it is safe or a good buy.',
    kind: 'read',
    inputSchema: obj({ mint: ADDRESS }, ['mint']),
    request: (a) => ({ method: 'GET', path: `/v1/tokens/${enc(str(a.mint))}/authenticity` }),
    untrusted: VERDICT_TEXT.map((p) => `/verdict${p}`),
  },
  {
    name: 'oc_check_cross_tokens',
    title: 'Are a cross\'s tokens real?',
    description: 'The identity check for both tokens of a cross (the token being sold and the quote token).',
    kind: 'read',
    inputSchema: obj({ cross: ADDRESS }, ['cross']),
    request: (a) => ({ method: 'GET', path: `/v1/crosses/${enc(str(a.cross))}/authenticity` }),
    untrusted: [...VERDICT_TEXT.map((p) => `/base/verdict${p}`), ...VERDICT_TEXT.map((p) => `/quote/verdict${p}`)],
  },
  {
    name: 'oc_get_premium',
    title: 'Stock-token premium by size and session',
    description:
      'How far the price you can actually trade a Solana stock token at sits from an independent reference, by order size and market session, with attempts that could not be priced counted. Positive means above the reference. Units are basis points x 100.',
    kind: 'read',
    inputSchema: obj({ days: { type: 'integer', minimum: 1, maximum: 90 } }, []),
    request: (a) => ({ method: 'GET', path: `/v1/premium/summary?days=${a.days ?? 7}` }),
    untrusted: [],
  },
  {
    name: 'oc_get_premium_latest',
    title: 'Latest premium per token',
    description: 'The newest measurement for each token: reference price, executable price per share, premium, route and share multiplier.',
    kind: 'read',
    inputSchema: obj({}, []),
    request: () => ({ method: 'GET', path: '/v1/premium/latest' }),
    untrusted: ['/observations/*/symbol'],
  },
  {
    name: 'oc_get_orders',
    title: 'Orders of a wallet',
    description: 'Every order a wallet has placed, with status, fill and amounts paid or refunded.',
    kind: 'read',
    inputSchema: obj({ owner: ADDRESS }, ['owner']),
    request: (a) => ({ method: 'GET', path: `/v1/owners/${enc(str(a.owner))}/orders` }),
    untrusted: [],
  },
  {
    name: 'oc_draft_place_order',
    title: 'Draft: place an order',
    description:
      'Builds an UNSIGNED transaction that places a buy or sell order and escrows its funds. Nothing happens until the wallet named in `owner` signs and sends it. For a sealed cross supply your own random 32-byte `salt` (hex) and keep it: it is needed to reveal.',
    kind: 'draft',
    inputSchema: obj({ ...crossArg, ...ownerArg, nonce: { ...U64, description: 'This wallet\'s next order number in this cross.' }, side: { type: 'string', enum: ['buy', 'sell'] }, price: U64, quantity: U64, salt: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' } }, ['cross', 'owner', 'nonce', 'side', 'price', 'quantity']),
    request: (a) => ({ method: 'POST', path: '/v1/tx/place-order', body: pick(a, ['cross', 'owner', 'nonce', 'side', 'price', 'quantity', 'salt']) }),
    untrusted: [],
  },
  {
    name: 'oc_draft_cancel_order',
    title: 'Draft: cancel an order',
    description: 'Builds an UNSIGNED transaction that cancels an open order and refunds its escrow to the owner. The owner must sign it.',
    kind: 'draft',
    inputSchema: obj({ ...crossArg, ...ownerArg, nonce: U64 }, ['cross', 'owner', 'nonce']),
    request: (a) => ({ method: 'POST', path: '/v1/tx/cancel', body: pick(a, ['cross', 'owner', 'nonce']) }),
    untrusted: [],
  },
  {
    name: 'oc_draft_reveal_order',
    title: 'Draft: reveal a sealed bid',
    description: 'Builds an UNSIGNED transaction that reveals a sealed order during the reveal window, from the price, quantity and salt used to place it.',
    kind: 'draft',
    inputSchema: obj({ ...crossArg, ...ownerArg, nonce: U64, price: U64, quantity: U64, salt: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' } }, ['cross', 'owner', 'nonce', 'price', 'quantity', 'salt']),
    request: (a) => ({ method: 'POST', path: '/v1/tx/reveal', body: pick(a, ['cross', 'owner', 'nonce', 'price', 'quantity', 'salt']) }),
    untrusted: [],
  },
  {
    name: 'oc_draft_settle',
    title: 'Draft: settle a cross',
    description: 'Builds the UNSIGNED transactions that merge the book and print the clearing price once the window has closed. Anyone may settle; the payer signs and pays fees.',
    kind: 'draft',
    inputSchema: obj({ ...crossArg, payer: ADDRESS, oraclePrice: ADDRESS }, ['cross', 'payer']),
    request: (a) => ({ method: 'POST', path: '/v1/tx/settle', body: pick(a, ['cross', 'payer', 'oraclePrice']) }),
    untrusted: [],
  },
  {
    name: 'oc_draft_claim',
    title: 'Draft: claim a fill or refund',
    description: 'Builds an UNSIGNED transaction that pays an order its fill and refunds the rest, or refunds it in full if the cross did not print. Anyone may submit; funds go to the owner.',
    kind: 'draft',
    inputSchema: obj({ ...crossArg, ...ownerArg, nonce: U64, payer: ADDRESS }, ['cross', 'owner', 'nonce']),
    request: (a) => ({ method: 'POST', path: '/v1/tx/claim', body: pick(a, ['cross', 'owner', 'nonce', 'payer']) }),
    untrusted: [],
  },
];

function pick(a: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
}
