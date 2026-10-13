import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { NoReceiptError, type OrderInput, type ProofInput, type ReceiptInputs, buildReceipt, canonicalJson, cardOf, describeReceiptOrder, sha256Hex } from '../src/lib/receipt';
import type { ReplayResponse } from '../src/lib/replay';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
// Cross 5UfrmxAv... as the live devnet API served it on 2026-10-13: its proof, replay and orders, with its market from GET /v1/crosses/:address.
const proof = read('../../../packages/verifier/schema/fixtures/proof-printed-rationed.json') as ProofInput;
const noPrint = read('../../../packages/verifier/schema/fixtures/proof-no-print.json') as ProofInput;
const live = read('../../../packages/verifier/schema/fixtures/proof-live-not-cleared.json') as ProofInput;
const replay = read('./fixtures/replay-5Ufrm.json') as ReplayResponse;
const orders = read('./fixtures/orders-5Ufrm.json').orders as OrderInput[];
const OWNER = '5ghdQnkPVFXwNaJmgJCXnLmynyhwB1ftGLj1v1XJwYBy';

const inputs = (over: Partial<ReceiptInputs> = {}): ReceiptInputs => ({
  network: 'devnet',
  market: { priceScale: '1000000', decimals: { base: 6, quote: 6 } },
  proof,
  orders,
  anchors: replay.events.map((e) => ({ event: e.event, kind: e.kind, slot: e.slot, time: e.time, signature: e.signature })),
  ...over,
});

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(read('../../../packages/verifier/schema/receipt.v1.schema.json'));

describe('canonicalJson', () => {
  it('sorts keys at every level, drops whitespace and undefined, and escapes like JSON', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, e: undefined, f: 'a"b\n' })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1,"f":"a\\"b\\n"}');
  });
  it('refuses a non-finite number rather than writing null', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
  it('hashes to the same value as Node crypto', async () => {
    const text = canonicalJson(proof);
    expect(await sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });
});

describe('buildReceipt on the real cross', () => {
  it('states the on-chain result, the verdict and the two transactions that recorded it', async () => {
    const { receipt } = await buildReceipt(inputs());
    expect(receipt.result).toEqual({ state: 'Finalized', printed: true, price: '1200000', matched: '2000000000', rationed: 'buy', noPrintReason: null });
    expect(receipt.verification.recomputedMatchesChain).toBe(true);
    expect(receipt.orders).toEqual({ total: 3, filled: 2 });
    expect(receipt.anchors.map((a) => [a.event, a.slot])).toEqual([['CrossCleared', '510128587'], ['CrossFinalized', '510128676']]);
    expect(receipt.wallet).toBeNull();
  });
  it('validates against the published schema', async () => {
    const { receipt } = await buildReceipt(inputs());
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    const wallet = (await buildReceipt(inputs({ owner: OWNER }))).receipt;
    expect(validate(wallet), JSON.stringify(validate.errors)).toBe(true);
    const none = (await buildReceipt(inputs({ proof: noPrint, orders: [], anchors: [] }))).receipt;
    expect(validate(none), JSON.stringify(validate.errors)).toBe(true);
  });
  it('is deterministic: same inputs, same bytes, same hash, and the hash is the SHA-256 of the bytes', async () => {
    const a = await buildReceipt(inputs());
    const b = await buildReceipt(inputs());
    expect(a.canonical).toBe(b.canonical);
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toBe(createHash('sha256').update(a.canonical).digest('hex'));
  });
  it('binds the proof: its hash is the SHA-256 of the proof as served, and any change to the proof changes the receipt', async () => {
    const a = await buildReceipt(inputs());
    expect(a.receipt.verification.proofSha256).toBe(createHash('sha256').update(canonicalJson(proof)).digest('hex'));
    const tampered = structuredClone(proof);
    tampered.onchain.price = '1300000';
    const b = await buildReceipt(inputs({ proof: tampered }));
    expect(b.receipt.verification.proofSha256).not.toBe(a.receipt.verification.proofSha256);
    expect(b.sha256).not.toBe(a.sha256);
  });
  it('carries no timestamp of its own and its limits say it is neither signed nor a zero-knowledge proof', async () => {
    const { receipt, canonical } = await buildReceipt(inputs());
    expect(Object.keys(receipt)).not.toContain('generatedAt');
    expect(receipt.limits.join(' ')).toMatch(/not signed/);
    expect(receipt.limits.join(' ')).toMatch(/not a zero-knowledge or multi-party proof/);
    expect(canonical).not.toMatch(/generatedAt|signature":"[^"]{0,10}"/);
  });
  it('refuses a cross that has not settled', async () => {
    await expect(buildReceipt(inputs({ proof: live }))).rejects.toBeInstanceOf(NoReceiptError);
  });
  it('reports a no-print cross as no print, with the reason by name, and a verdict that is not softened', async () => {
    const { receipt } = await buildReceipt(inputs({ proof: noPrint, orders: [], anchors: [] }));
    expect(receipt.result).toMatchObject({ printed: false, price: null, matched: null });
    const lie = structuredClone(noPrint);
    lie.verified = false;
    const bad = await buildReceipt(inputs({ proof: lie, orders: [], anchors: [] }));
    expect(bad.receipt.verification.recomputedMatchesChain).toBe(false);
    expect(cardOf(bad.receipt).verdict).toEqual({ text: 'Recomputation does not match the chain', tone: 'bad' });
  });
  it('does not fail when the orders could not be read; it leaves the counts out', async () => {
    const { receipt } = await buildReceipt(inputs({ orders: null }));
    expect(receipt.orders).toBeNull();
    expect(validate(receipt)).toBe(true);
  });
});

describe('wallet receipt and card', () => {
  it('lists only that wallet\'s orders, in the words of what it got', async () => {
    const { receipt } = await buildReceipt(inputs({ owner: OWNER }));
    expect(receipt.wallet!.orders).toHaveLength(1);
    expect(describeReceiptOrder(receipt.wallet!.orders[0]!, receipt)).toBe('Buy 1,500 tokens at a limit of 1.5: filled 1,500 tokens, paid 1,800 quote tokens, 450 returned.');
    const card = cardOf(receipt);
    expect(card.title).toBe('Order receipt');
    expect(card.headline).toEqual({ label: 'One clearing price', value: '1.2' });
    expect(card.verdict.tone).toBe('ok');
  });
  it('words an unfilled buy as a full refund and a wallet with no orders as having none', async () => {
    const { receipt } = await buildReceipt(inputs({ owner: '9poQ5ty3C3VLP3xqWdsMC89XpCpvXJvSPfJcR1F9gs8Y' }));
    expect(describeReceiptOrder(receipt.wallet!.orders[0]!, receipt)).toBe('Buy 500 tokens at a limit of 1.1: not filled, 550 quote tokens returned.');
    const empty = (await buildReceipt(inputs({ owner: '11111111111111111111111111111111' }))).receipt;
    expect(cardOf(empty).wallet!.lines).toEqual(['This wallet has no orders in this cross.']);
  });
  it('shows the cross card with the same figures the receipt holds', async () => {
    const card = cardOf((await buildReceipt(inputs())).receipt);
    expect(card.lines).toEqual([
      { label: 'Matched', value: '2,000 tokens, buy side pro rata' },
      { label: 'Orders filled', value: '2 of 3' },
      { label: 'Cross', value: '5Ufr…A8Wm' },
      { label: 'Network', value: 'devnet' },
    ]);
  });
});
