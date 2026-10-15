// Signed, anchored receipts (row S2, ADR-0941): the promiser's receipt rounds against a real Postgres (PGlite) with the indexer's schema, cross accounts encoded by the program's own encoder, and
// receipt bytes written by the web app's own `buildReceipt`. Only the chain's account reads and the Memo transaction are replaced; the Memo anchor on a real cluster is in docs/evidence/W5-1E.md.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { type Address, generateKeyPairSigner, some } from '@solana/kit';
import { verifyDocument } from '@opening-cross/attest';
import { CrossState, getCrossDecoder } from '@opening-cross/sdk';
import { merkleRoot, parseMemo, verifyProof } from '@opening-cross/promises';
import {
  type ReceiptDeps,
  type ReceiptFetch,
  RECEIPT_ATTESTATION_SCHEMA,
  RECEIPT_MEMO_PREFIX,
  anchorReceiptsRound,
  attestRound,
  attestationFor,
  canonicalJson,
  parseReceiptMemo,
  receiptAttestationAnswer,
  receiptMemoText,
  sha256Hex,
  signReceiptAttestation,
  attestationBody,
  verifyReceiptAttestation,
} from '@opening-cross/promiser';
import { buildReceipt } from '../../../apps/web/src/lib/receipt';
import { holderDb } from './helpers/holder-pg';
import { makeCross } from './helpers/holder-cross';

const CLUSTER = 'devnet';
const NOW = 1_800_000_000;
const PROGRAM = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';

type Chain = Map<string, { data: Uint8Array; owner: Address }>;

/** A settled cross: its account on the fake chain, its row in the index, and the receipt bytes the web app would serve for it. */
async function settled(db: PGlite, chain: Chain, over: { state?: 'Finalized' | 'NoPrint' | 'Cleared'; price?: bigint; slot: number }) {
  const state = over.state ?? 'Finalized';
  const printed = state !== 'NoPrint';
  const price = over.price ?? 1_500_000n;
  const t = await makeCross({
    state: CrossState[state],
    ...(printed ? { clearing: some({ price, matched: 400_000_000n, demand: 1n, supply: 1n, rationed: 1, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 }) } : {}),
  });
  chain.set(t.address, t.account);
  await db.query(
    `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
     VALUES ($1, 'creator', 0, 0, 1, $2, $3, 1000, 2000, 2000, 30, 0, $4, $5, $5)`,
    [t.address, t.baseMint, t.quoteMint, state, over.slot],
  );
  return { cross: t.address as string, receipt: await receiptFor(t.address, state, printed ? price : null) };
}

async function receiptFor(cross: string, state: 'Finalized' | 'NoPrint' | 'Cleared', price: bigint | null, tweak: (r: ReturnType<typeof proof>) => void = () => undefined) {
  const p = proof(cross, state, price);
  tweak(p);
  const built = await buildReceipt({
    network: CLUSTER,
    market: { priceScale: '1000000', decimals: { base: 6, quote: 6 } },
    proof: p,
    orders: [],
    anchors: [{ event: 'CrossCleared', kind: 'cleared', slot: '100', time: '2027-01-15T08:00:00Z', signature: '5'.repeat(88) }],
  });
  return built;
}

function proof(cross: string, state: 'Finalized' | 'NoPrint' | 'Cleared', price: bigint | null) {
  const printed = price !== null;
  return {
    schema: 'opening-cross/fairness-proof/v1',
    program: PROGRAM,
    cross,
    state,
    onchain: { printed, price: printed ? price.toString() : null, matched: printed ? '400000000' : null, rationed: printed ? 'buy' : null, noPrintReason: printed ? null : 0 },
    recomputed: { printed, price: printed ? price.toString() : null, matched: printed ? '400000000' : null, rationed: printed ? 'buy' : null, noPrintReason: null },
    verified: true,
  } as never as Parameters<typeof buildReceipt>[0]['proof'];
}

describe('signed and anchored receipts', () => {
  let db: PGlite;
  let chain: Chain;
  let served: Map<string, ReceiptFetch | Error>;
  let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
  let now = NOW;
  let deps: ReceiptDeps;
  const ok = (text: string, sha = sha256Hex(text)): ReceiptFetch => ({ status: 200, text, sha256: sha });

  beforeEach(async () => {
    db = await holderDb();
    chain = new Map();
    served = new Map();
    now = NOW;
    signer = await generateKeyPairSigner();
    deps = {
      db,
      cluster: CLUSTER,
      signer,
      read: async (a) => chain.get(a) ?? null,
      now: async () => now,
      fetchReceipt: async (cross) => {
        const r = served.get(cross);
        if (r instanceof Error) throw r;
        return r ?? { status: 404, text: '{"error":"no such cross"}', sha256: null };
      },
    };
  });
  afterEach(async () => {
    await db.close();
  });

  async function add(over: Parameters<typeof settled>[2]) {
    const s = await settled(db, chain, over);
    served.set(s.cross, ok(s.receipt.canonical, s.receipt.sha256));
    return s;
  }

  it('signs the hash of a settled cross’s receipt once the receipt agrees with the cross account, and a stranger can check it with the shared document library', async () => {
    const { cross, receipt } = await add({ slot: 1 });
    const r = await attestRound(deps);
    expect(r).toMatchObject({ attested: [cross], changed: [], unchanged: 0, skipped: [] });
    const v = (await attestationFor(db, CLUSTER, cross))!;
    expect(v.attestations).toBe(1);
    expect(v.anchor).toBeNull();
    expect(v.attestation.body).toMatchObject({ schema: RECEIPT_ATTESTATION_SCHEMA, cluster: CLUSTER, cross, receiptSchema: 'opening-cross/receipt/v1', receiptSha256: receipt.sha256, state: 'Finalized' });
    expect(v.attestation.body.statement).toContain('not that the clearing rule was applied correctly');
    expect(v.attestation.signer).toBe(signer.address);
    // The same document, checked by the library every other signed document uses, against the published key.
    expect(await verifyDocument(v.attestation as never, signer.address)).toEqual({ ok: true });
    expect(await verifyReceiptAttestation(v.attestation, signer.address)).toEqual({ ok: true });
  });

  it('refuses to accept an altered, mis-signed or foreign attestation', async () => {
    const { cross, receipt } = await add({ slot: 1 });
    await attestRound(deps);
    const a = (await attestationFor(db, CLUSTER, cross))!.attestation;
    const other = await generateKeyPairSigner();
    expect(await verifyReceiptAttestation({ ...a, body: { ...a.body, receiptSha256: '0'.repeat(64) } })).toEqual({ ok: false, reason: 'ID_MISMATCH' });
    expect(await verifyReceiptAttestation(a, other.address)).toEqual({ ok: false, reason: 'WRONG_SIGNER' });
    expect(await verifyReceiptAttestation({ ...a, signature: 'ab'.repeat(64) })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(await verifyReceiptAttestation({ ...a, signature: 'short' })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(await verifyReceiptAttestation({ ...a, signer: other.address })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    // A body that could not be an attestation at all.
    expect(await verifyReceiptAttestation({ ...a, body: { ...a.body, state: 'Cleared' } as never })).toEqual({ ok: false, reason: 'MALFORMED' });
    // The signature is bound to this kind of document: it is not valid under another schema's domain.
    const asOther = { ...a, body: { ...a.body, schema: 'opening-cross/promise/v1' } };
    expect((await verifyDocument(asOther as never)).ok).toBe(false);
    expect(receipt.sha256).toBe(a.body.receiptSha256);
    expect(() => attestationBody({ cluster: CLUSTER, cross, receiptSchema: 'opening-cross/receipt/v1', receiptSha256: 'nope', state: 'Finalized' })).toThrow(/64 lowercase hex/);
    expect(() => attestationBody({ cluster: CLUSTER, cross, receiptSchema: 'opening-cross/receipt/v1', receiptSha256: receipt.sha256, state: 'Cleared' as never })).toThrow(/Finalized or NoPrint/);
  });

  it('attests a cross that settled without a print, and only when the account has no clearing either', async () => {
    const np = await add({ slot: 1, state: 'NoPrint' });
    expect((await attestRound(deps)).attested).toEqual([np.cross]);
    expect((await attestationFor(db, CLUSTER, np.cross))!.attestation.body.state).toBe('NoPrint');
    // A receipt that says no print for a cross whose account holds a clearing is not signed.
    const liar = await settled(db, chain, { slot: 2 });
    const text = (await receiptFor(liar.cross, 'NoPrint', null)).canonical;
    served.set(liar.cross, ok(text));
    const r = await attestRound(deps);
    expect(r.skipped).toEqual([{ cross: liar.cross, reason: 'CHAIN_DISAGREES', detail: expect.stringContaining('says NoPrint, the cross account says Finalized') }]);
  });

  it('does not sign what it cannot stand behind, and says why for each', async () => {
    const good = await add({ slot: 1 });
    const cases: [string, ReceiptFetch | Error, string][] = [];
    const mk = async (slot: number, over: Parameters<typeof settled>[2]) => (await settled(db, chain, { ...over, slot })).cross;

    const notSettled = await mk(2, {});
    cases.push([notSettled, { status: 409, text: '{"error":"x"}', sha256: null }, 'NOT_SETTLED']);
    const gone = await mk(3, {});
    cases.push([gone, { status: 404, text: '{}', sha256: null }, 'NO_SUCH_CROSS']);
    const unsupported = await mk(4, {});
    cases.push([unsupported, { status: 422, text: '{}', sha256: null }, 'UNSUPPORTED_PROOF']);
    const down = await mk(5, {});
    cases.push([down, new Error('connect ECONNREFUSED'), 'UNAVAILABLE']);
    const busy = await mk(6, {});
    cases.push([busy, { status: 503, text: '', sha256: null }, 'UNAVAILABLE']);
    const junk = await mk(7, {});
    cases.push([junk, ok('<html>not json</html>'), 'MALFORMED']);
    const pretty = await mk(8, {});
    cases.push([pretty, ok(JSON.stringify(JSON.parse((await receiptFor(pretty, 'Finalized', 1_500_000n)).canonical), null, 2)), 'NOT_CANONICAL']);
    const header = await mk(9, {});
    cases.push([header, ok((await receiptFor(header, 'Finalized', 1_500_000n)).canonical, 'f'.repeat(64)), 'HASH_MISMATCH']);
    const other = await mk(10, {});
    cases.push([other, ok((await receiptFor(good.cross, 'Finalized', 1_500_000n)).canonical), 'MALFORMED']);
    // The index says finalized but the receipt served is still the one built while the cross was only cleared.
    const cleared = await mk(11, {});
    cases.push([cleared, ok((await receiptFor(cleared, 'Cleared', 1_500_000n)).canonical), 'NOT_FINAL']);
    const noMatch = await mk(12, {});
    cases.push([noMatch, ok((await receiptFor(noMatch, 'Finalized', 1_500_000n, (p) => void ((p as { verified: boolean }).verified = false))).canonical), 'RECOMPUTATION_DID_NOT_MATCH']);
    const wrongPrice = await mk(13, {});
    cases.push([wrongPrice, ok((await receiptFor(wrongPrice, 'Finalized', 1_400_000n)).canonical), 'CHAIN_DISAGREES']);
    const missing = (await settled(db, chain, { slot: 14 })).cross;
    chain.delete(missing as never);
    cases.push([missing, ok((await receiptFor(missing, 'Finalized', 1_500_000n)).canonical), 'NOT_ON_CHAIN']);
    for (const [c, r] of cases.map(([c, r]) => [c, r] as const)) served.set(c, r);

    const wrongNetwork = await mk(15, {});
    const wn = JSON.parse((await receiptFor(wrongNetwork, 'Finalized', 1_500_000n)).canonical);
    const wnText = canonicalJson({ ...wn, network: 'mainnet-beta' });
    served.set(wrongNetwork, ok(wnText));
    cases.push([wrongNetwork, ok(wnText), 'NETWORK_MISMATCH']);

    const wallet = await mk(16, {});
    const w = JSON.parse((await receiptFor(wallet, 'Finalized', 1_500_000n)).canonical);
    const wText = canonicalJson({ ...w, wallet: { owner: good.cross, orders: [] } });
    served.set(wallet, ok(wText));
    cases.push([wallet, ok(wText), 'MALFORMED']);

    const r = await attestRound({ ...deps, perRound: 50 });
    expect(r.attested).toEqual([good.cross]);
    const got = Object.fromEntries(r.skipped.map((s) => [s.cross, s.reason]));
    for (const [c, , reason] of cases) expect(got[c], `${c} ${reason}`).toBe(reason);
    expect(r.skipped).toHaveLength(cases.length);
    expect(await attestationFor(db, CLUSTER, notSettled)).toBeNull();
  });

  it('does not let crosses it cannot attest crowd out the ones it can, and tries them again later', async () => {
    const bad = [await settled(db, chain, { slot: 1 }), await settled(db, chain, { slot: 2 })];
    for (const b of bad) served.set(b.cross, { status: 422, text: '{}', sha256: null });
    const good = await add({ slot: 3 });
    const small = { ...deps, perRound: 2 };
    expect((await attestRound(small)).skipped).toHaveLength(2);
    // Next round the two are waiting; the third is reached.
    now += 10;
    const second = await attestRound(small);
    expect(second.attested).toEqual([good.cross]);
    expect(second.skipped).toEqual([]);
    // Much later they are tried again, and succeed once their receipt is served.
    for (const b of bad) served.set(b.cross, ok(b.receipt.canonical, b.receipt.sha256));
    now += 7200;
    expect((await attestRound(small)).attested.sort()).toEqual(bad.map((b) => b.cross).sort());
  });

  it('checks an attested receipt again and attests the new bytes if they changed, keeping the old attestation', async () => {
    const s = await add({ slot: 1 });
    await attestRound(deps);
    // Not looked at again before the recheck window.
    now += 60;
    expect(await attestRound({ ...deps, recheckAfterSeconds: 3600 })).toMatchObject({ attested: [], changed: [], unchanged: 0 });
    // After it, an unchanged receipt only refreshes its check time.
    now += 7200;
    expect(await attestRound({ ...deps, recheckAfterSeconds: 3600 })).toMatchObject({ attested: [], changed: [], unchanged: 1 });
    expect((await attestationFor(db, CLUSTER, s.cross))!.attestations).toBe(1);
    // The bytes served for the cross changed (here: the index fixed an order count): a second attestation, the first kept.
    const next = JSON.parse(s.receipt.canonical);
    const text = canonicalJson({ ...next, orders: { total: 3, filled: 1 } });
    served.set(s.cross, ok(text));
    now += 7200;
    expect(await attestRound({ ...deps, recheckAfterSeconds: 3600 })).toMatchObject({ changed: [s.cross] });
    const v = (await attestationFor(db, CLUSTER, s.cross))!;
    expect(v.attestations).toBe(2);
    expect(v.attestation.body.receiptSha256).toBe(sha256Hex(text));
  });

  it('anchors the attestations in batches under their own memo, with a proof that reaches the root', async () => {
    const crosses = [await add({ slot: 1 }), await add({ slot: 2 }), await add({ slot: 3 })];
    await attestRound(deps);
    const memos: string[] = [];
    const send = async (memo: string) => (memos.push(memo), { signature: `sig${memos.length}`.padEnd(88, 'x'), slot: 500 + memos.length, blockTime: NOW + 30 });
    expect(await anchorReceiptsRound(deps, send)).toEqual({ anchored: 3, signature: 'sig1'.padEnd(88, 'x') });
    expect(memos).toHaveLength(1);
    expect(memos[0]).toMatch(new RegExp(`^${RECEIPT_MEMO_PREFIX} root=[0-9a-f]{64} n=3$`));
    // A promise digest and a receipt digest cannot be mistaken for one another.
    expect(parseMemo(memos[0]!)).toBeNull();
    expect(parseReceiptMemo(memos[0]!)).toMatchObject({ count: 3 });
    expect(parseReceiptMemo(`opening-cross/promises/v1 root=${'a'.repeat(64)} n=1`)).toBeNull();

    const ids: string[] = [];
    for (const c of crosses) {
      const v = (await attestationFor(db, CLUSTER, c.cross))!;
      ids.push(v.attestation.id);
      expect(v.anchor).toMatchObject({ count: 3, signature: 'sig1'.padEnd(88, 'x'), slot: 501, blockTime: NOW + 30, memo: memos[0] });
      expect(verifyProof(v.attestation.id, v.anchor!.proof, v.anchor!.root)).toBe(true);
      // The proof proves this attestation and no other.
      expect(verifyProof('0'.repeat(64), v.anchor!.proof, v.anchor!.root)).toBe(false);
    }
    expect((await attestationFor(db, CLUSTER, crosses[0]!.cross))!.anchor!.root).toBe(merkleRoot(ids));

    // Nothing new, nothing sent. A new attestation goes in the next anchor alone.
    expect(await anchorReceiptsRound(deps, send)).toEqual({ anchored: 0, signature: null });
    const late = await add({ slot: 4 });
    await attestRound(deps);
    expect(await anchorReceiptsRound(deps, send)).toMatchObject({ anchored: 1 });
    const lv = (await attestationFor(db, CLUSTER, late.cross))!;
    expect(lv.anchor!.count).toBe(1);
    expect(lv.anchor!.root).not.toBe((await attestationFor(db, CLUSTER, crosses[0]!.cross))!.anchor!.root);
    expect(memos).toHaveLength(2);
    expect(receiptMemoText({ root: 'r'.repeat(64), count: 2 })).toBe(`${RECEIPT_MEMO_PREFIX} root=${'r'.repeat(64)} n=2`);
  });

  it('refuses to serve an anchor whose stored members no longer hash to the anchored root', async () => {
    const a = await add({ slot: 1 });
    await add({ slot: 2 });
    await attestRound(deps);
    await anchorReceiptsRound(deps, async () => ({ signature: 's'.repeat(88), slot: 1, blockTime: NOW }));
    expect(await attestationFor(db, CLUSTER, a.cross)).not.toBeNull();
    const other = (await db.query('SELECT id FROM receipt_attestations WHERE cross_address <> $1', [a.cross])).rows[0]!.id;
    await db.query('DELETE FROM receipt_anchor_members WHERE attestation_id = $1', [other]);
    await expect(attestationFor(db, CLUSTER, a.cross)).rejects.toThrow(/no longer hash to the anchored root/);
  });

  it('answers the route: bad address, none yet, none yet when asked softly, and the attestation with the published key checked', async () => {
    const s = await add({ slot: 1 });
    const o = { cluster: CLUSTER, publishedSigner: signer.address };
    expect(await receiptAttestationAnswer(db, o, 'nope')).toMatchObject({ status: 400 });
    expect(await receiptAttestationAnswer(db, o, s.cross)).toMatchObject({ status: 404 });
    expect(await receiptAttestationAnswer(db, o, s.cross, true)).toMatchObject({ status: 200, body: { attestation: null } });
    await attestRound(deps);
    const ans = await receiptAttestationAnswer(db, o, s.cross);
    expect(ans.status).toBe(200);
    expect(ans.body).toMatchObject({ cluster: CLUSTER, cross: s.cross, attestations: 1, publishedSigner: signer.address, signerIsPublished: true, anchor: null });
    expect(await receiptAttestationAnswer(db, { cluster: CLUSTER, publishedSigner: (await generateKeyPairSigner()).address }, s.cross)).toMatchObject({ body: { signerIsPublished: false } });
    expect(await receiptAttestationAnswer(db, { cluster: CLUSTER }, s.cross)).toMatchObject({ body: { publishedSigner: null, signerIsPublished: null } });
    expect(await receiptAttestationAnswer(db, { cluster: 'mainnet-beta', publishedSigner: signer.address }, s.cross)).toMatchObject({ status: 404 });
  });

  it('signs deterministically enough to be checked: the same body always has the same id', async () => {
    const { cross, receipt } = await add({ slot: 1 });
    const body = attestationBody({ cluster: CLUSTER, cross, receiptSchema: 'opening-cross/receipt/v1', receiptSha256: receipt.sha256, state: 'Finalized' });
    const a = await signReceiptAttestation(body, signer);
    const b = await signReceiptAttestation(body, signer);
    expect(a.id).toBe(b.id);
    expect(a.signature).toBe(b.signature); // Ed25519 is deterministic
    expect(getCrossDecoder().decode(chain.get(cross)!.data).state).toBe(CrossState.Finalized);
  });
});
