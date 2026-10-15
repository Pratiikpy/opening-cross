// What the API serves for a cross's receipt attestation (row S2, ADR-0941), as a function of the database so that the route is a few lines of wiring and the answer is tested here.
//
//   GET /v1/crosses/:address/receipt-attestation[?optional=1]
//     200 { cluster, cross, attestation: { body, id, signer, signature }, recordedAt, attestations, publishedSigner, signerIsPublished, anchor: { root, count, signature, slot, blockTime, memo, proof } | null }
//     200 { attestation: null, note }   with ?optional=1 when none exists yet (a page asks this way so "not yet" is an ordinary answer, not a failed request in the browser console)
//     400 not an address    404 none exists yet
import { type ReceiptAttestationView, type Queryable, attestationFor } from './receipt-store.js';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface ReceiptViewOptions {
  readonly cluster: string;
  /** The key the API publishes at /v1/promises/signer. An attestation by any other key is not the operator's. */
  readonly publishedSigner?: string | null | undefined;
}

export type ReceiptViewAnswer = { readonly status: 200 | 400 | 404; readonly body: unknown };

export async function receiptAttestationAnswer(db: Queryable, o: ReceiptViewOptions, cross: string, optional = false): Promise<ReceiptViewAnswer> {
  if (!BASE58.test(cross)) return { status: 400, body: { error: 'address must be a base58 Solana address' } };
  const v: ReceiptAttestationView | null = await attestationFor(db, o.cluster, cross);
  if (!v) {
    const note = 'no attestation exists for this cross yet: a receipt is signed and anchored some minutes after the cross has settled for good';
    return optional ? { status: 200, body: { cluster: o.cluster, cross, attestation: null, note } } : { status: 404, body: { error: note } };
  }
  const published = o.publishedSigner ?? null;
  return {
    status: 200,
    body: {
      cluster: o.cluster,
      cross,
      attestation: v.attestation,
      recordedAt: v.recordedAt,
      attestations: v.attestations,
      publishedSigner: published,
      signerIsPublished: published === null ? null : v.attestation.signer === published,
      anchor: v.anchor,
    },
  };
}
