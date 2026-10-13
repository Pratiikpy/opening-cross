import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { explainNoPrint } from '../src/components/cross/no-print';
import { RULE_NO_PRINT } from '../src/lib/holder-rules';
import {
  type OrderInput,
  type ProofInput,
  type ReceiptInputs,
  UnsupportedProofError,
  buildReceipt,
  cardOf,
  noPrintWords,
} from '../src/lib/receipt';
import { describeEvent, kindLabel, type ReplayEvent } from '../src/lib/replay';
import type { ReplayResponse } from '../src/lib/replay';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const proofV1 = read('../../../packages/verifier/schema/fixtures/proof-printed-rationed.json') as ProofInput;
const noPrintV1 = read('../../../packages/verifier/schema/fixtures/proof-no-print.json') as ProofInput;
const replay = read('./fixtures/replay-5Ufrm.json') as ReplayResponse;
const orders = read('./fixtures/orders-5Ufrm.json').orders as OrderInput[];

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateReceiptV1 = ajv.compile(read('../../../packages/verifier/schema/receipt.v1.schema.json'));
const validateReceiptV2 = ajv.compile(read('../../../packages/verifier/schema/receipt.v2.schema.json'));
const validateProofV2 = ajv.compile(read('../../../packages/verifier/schema/fairness-proof.v2.schema.json'));

const rulesBlock = (over: Record<string, unknown> = {}) => ({
  ending: { endingSecs: 400, buckets: 4, cancelCutoffSecs: 60, randomEnd: true, startsAt: '1799999600', lastCountedBucket: 2, extension: null },
  checks: [
    { name: 'merged main shards', ok: true, detail: 'every main shard was merged' },
    { name: 'merged auxiliary shards', ok: true, detail: 'the shards of windows 1 to 3 were merged' },
    { name: 'ending window equals the drawn one', ok: null, detail: 'the draw events were not supplied' },
  ],
  limits: ['The block hashes behind a draw cannot be reproduced from the account.', 'State-dependent no-print reasons are not reproducible from the book.'],
  supplyCap: null,
  minRaiseQuote: '0',
  totalSupply: '0',
  minFloatBps: 0,
  maxFdvX100: 0,
  anchorPrice: '0',
  moveBps: 0,
  reserveBps: [3000, 0, 0],
  lotteryUnit: '0',
  insiders: 0,
  draw: { epoch: 0, seed: 'ab'.repeat(32), endBucket: 2 },
  allocation: { classQty: ['0', '0', '0'], tickets: 0, rho: 0, insiderUpperBound: '0', counted: '2000000000' },
  ...over,
});
const proofV2 = (over: Record<string, unknown> = {}, rules: Record<string, unknown> = {}): ProofInput => ({ ...proofV1, schema: 'opening-cross/fairness-proof/v2', rules: rulesBlock(rules), ...over }) as ProofInput;

const inputs = (over: Partial<ReceiptInputs> = {}): ReceiptInputs => ({
  network: 'devnet',
  market: { priceScale: '1000000', decimals: { base: 6, quote: 6 } },
  proof: proofV1,
  orders,
  anchors: replay.events.map((e) => ({ event: e.event, kind: e.kind, slot: e.slot, time: e.time, signature: e.signature })),
  ...over,
});

describe('the proof v2 fixture used here is itself valid', () => {
  it('validates against the published fairness-proof v2 schema', () => {
    expect(validateProofV2(proofV2()), JSON.stringify(validateProofV2.errors)).toBe(true);
  });
});

describe('a receipt for a cross with rules', () => {
  it('is version 2, validates against the published schema, and restates the checks, the draw and the allocation', async () => {
    const { receipt } = await buildReceipt(inputs({ proof: proofV2() }));
    expect(receipt.schema).toBe('opening-cross/receipt/v2');
    expect(receipt.verification.proofSchema).toBe('opening-cross/fairness-proof/v2');
    expect(receipt.verification.method).toMatch(/which ending window the draw fixed/);
    expect(receipt.rules?.draw).toEqual({ epoch: 0, seed: 'ab'.repeat(32), endBucket: 2 });
    expect(receipt.rules?.checks.map((c) => c.ok)).toEqual([true, true, null]);
    expect(validateReceiptV2(receipt), JSON.stringify(validateReceiptV2.errors)).toBe(true);
    const wallet = (await buildReceipt(inputs({ proof: proofV2(), owner: '5ghdQnkPVFXwNaJmgJCXnLmynyhwB1ftGLj1v1XJwYBy' }))).receipt;
    expect(validateReceiptV2(wallet), JSON.stringify(validateReceiptV2.errors)).toBe(true);
  });
  it('is refused by the version-1 schema, so a v1 reader is never handed a v2 document as v1', async () => {
    const { receipt } = await buildReceipt(inputs({ proof: proofV2() }));
    expect(validateReceiptV1(receipt)).toBe(false);
  });
  it('copies only what the schema allows from the proof’s rules block (no stray fields reach the document)', async () => {
    const { receipt } = await buildReceipt(inputs({ proof: proofV2({}, { someFutureField: 1 }) }));
    expect(Object.keys(receipt.rules!).sort()).toEqual(['allocation', 'checks', 'draw', 'ending', 'limits']);
    expect(validateReceiptV2(receipt)).toBe(true);
  });
  it('binds the whole proof: a change in the rules block changes the receipt hash', async () => {
    const a = await buildReceipt(inputs({ proof: proofV2() }));
    const b = await buildReceipt(inputs({ proof: proofV2({}, { draw: { epoch: 0, seed: 'cd'.repeat(32), endBucket: 1 } }) }));
    expect(a.receipt.verification.proofSha256).not.toBe(b.receipt.verification.proofSha256);
    expect(a.sha256).not.toBe(b.sha256);
  });
  it('shows a failing check on the card and does not call the recomputation matching', async () => {
    const proof = proofV2({ verified: false }, { checks: [{ name: 'ending window equals the drawn one', ok: false, detail: 'the seed gives window 4' }] });
    const { receipt } = await buildReceipt(inputs({ proof }));
    const card = cardOf(receipt);
    expect(card.verdict).toEqual({ text: 'Recomputation does not match the chain', tone: 'bad' });
    expect(card.lines.find((l) => l.label === 'Checks on the rules')!.value).toBe('0 of 1 reproduced, 1 did not');
    expect(card.lines.find((l) => l.label === 'Drawn last window')!.value).toBe('3');
  });
});

describe('a receipt for a cross without rules is unchanged', () => {
  it('stays version 1, has no rules key, and validates against the version-1 schema', async () => {
    const { receipt, canonical } = await buildReceipt(inputs());
    expect(receipt.schema).toBe('opening-cross/receipt/v1');
    expect(Object.keys(receipt)).not.toContain('rules');
    expect(canonical).not.toContain('"rules"');
    expect(validateReceiptV1(receipt), JSON.stringify(validateReceiptV1.errors)).toBe(true);
  });
});

describe('a proof this page cannot restate', () => {
  it('is refused, never summarised as if it were version 1', async () => {
    await expect(buildReceipt(inputs({ proof: { ...proofV1, schema: 'opening-cross/fairness-proof/v3' } }))).rejects.toBeInstanceOf(UnsupportedProofError);
    await expect(buildReceipt(inputs({ proof: { ...proofV1, schema: 'opening-cross/fairness-proof/v2' } }))).rejects.toThrow(/no rules block/);
  });
});

describe('no-print reasons', () => {
  const NAMES = ['NoCross', 'BelowMinimumVolume', 'ImbalanceTooHigh', 'SettlementExpired', 'OracleDivergence', 'OracleUnavailable', 'BelowMinimumRaise', 'FloatTooLow', 'FdvTooHigh', 'PriceMoved', 'Halted', 'CorporateAction', 'IssuerPaused', 'OracleDisagreement'];
  it('every reason the program can record has words on the receipt and on the cross page, and an unknown one is shown as it is', () => {
    for (const n of NAMES) {
      expect(noPrintWords(n), n).not.toBe(n);
      expect(explainNoPrint(n), n).not.toBe(n);
    }
    expect(noPrintWords('SomethingNew')).toBe('SomethingNew');
    expect(Object.keys(RULE_NO_PRINT)).toEqual(NAMES.slice(6));
  });
  it('the card headline of a no-print receipt names the reason in words, not as a code', async () => {
    const proof = { ...noPrintV1, onchain: { ...noPrintV1.onchain, noPrintReason: 6 } } as ProofInput;
    const { receipt } = await buildReceipt(inputs({ proof, orders: [], anchors: [] }));
    expect(receipt.result.noPrintReason).toBe('BelowMinimumRaise');
    expect(cardOf(receipt).headline.value).toBe('No print: the amount raised at the clearing price was below the minimum the issuer set');
  });
});

describe('the replay names the events the rules added', () => {
  const m = { priceScale: 1_000_000n, baseDecimals: 6, quoteDecimals: 6 };
  const ev = (kind: string, details: Record<string, unknown>): ReplayEvent => ({ n: 1, kind, event: kind, slot: '1', time: null, signature: 's', details });
  it('describes each event in a sentence and labels it', () => {
    expect(describeEvent(ev('rules_set', { ending: { endingSecs: 400, buckets: 4 }, bondQuote: '100000000', insiders: 2 }), m)).toMatch(/ending period of 400 s in 4 windows.*bond of 100 quote behind 2 declared insiders/);
    expect(describeEvent(ev('order_placement', { ext: { class: 2, bucket: 1, lockCliff: 2592000 } }), m)).toMatch(/ending window 2 as a locked buyer order, its fill locked for 2592000 s/);
    expect(describeEvent(ev('order_placement', { ext: { class: 0, bucket: 255, lockCliff: 0 } }), m)).toBe('An order was recorded.');
    expect(describeEvent(ev('draw_started', { slot: '900', purpose: 1 }), m)).toMatch(/slot 900.*last counted ending window/);
    expect(describeEvent(ev('draw_finished', { purpose: 1, endBucket: 2 }), m)).toMatch(/ending window 3 is the last that counts/);
    expect(describeEvent(ev('draw_finished', { purpose: 2, endBucket: 255 }), m)).toMatch(/length of the extension was set/);
    expect(describeEvent(ev('extension_pending', { reason: 6 }), m)).toMatch(/amount raised below the minimum.*one extension/);
    expect(describeEvent(ev('insider_challenged', { id: 0, challenger: '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT', subject: 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC' }), m)).toMatch(/challenged DTB3….*undeclared insider/);
    expect(describeEvent(ev('challenge_resolved', { id: 1, upheld: true, slash: '50000000' }), m)).toMatch(/upheld.*50 quote.*slashed/);
    expect(describeEvent(ev('challenge_resolved', { id: 1, upheld: false, slash: '0' }), m)).toMatch(/rejected/);
    expect(describeEvent(ev('lock_created', { owner: '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT', amount: '5000000', cliffSecs: 100, vestSecs: 200 }), m)).toMatch(/5 tokens was locked for 100 s and vests over 200 s/);
    expect(describeEvent(ev('lock_released', { owner: '9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT', amount: '1000000', remaining: '4000000' }), m)).toMatch(/1 tokens were released.*4 tokens remain/);
    expect(describeEvent(ev('print_fed', { price: '1200000', matched: '2000000000' }), m)).toMatch(/1\.2.*2,?000 tokens.*lender price feed/);
    for (const k of ['rules_set', 'draw_started', 'draw_finished', 'lock_created', 'lock_released', 'insider_challenged']) expect(kindLabel(k)).not.toBe(k);
  });
  it('words all fourteen no-print reasons of a cleared event', () => {
    const e = (r: number) => describeEvent(ev('cleared', { printed: false, noPrintReason: { value: r } }), m);
    for (let r = 0; r < 14; r++) expect(e(r), String(r)).toMatch(/did not print: /);
    expect(e(13)).toMatch(/oracles disagreed/);
  });
});
