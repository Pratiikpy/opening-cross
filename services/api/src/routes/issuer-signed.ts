// Wallet-signed records for the issuer board (applications, draft listings, soft commits, questions, answers, curator decisions).
// The pattern is the treasury update's (routes/treasury-updates.ts): the id is the sha-256 of the RFC 8785 canonical record, the
// wallet signs the id under a domain prefix, and anyone can check the signature against the signer's address. A signature proves a
// wallet said exactly this; it proves nothing about whether what was said is true.
import { getPublicKeyFromAddress, verifySignature, address as toAddress } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import { type Json, hashJcs } from '@opening-cross/promises';

export const RECORD_SCHEMA = 'opening-cross/issuer-record/v1';
export const RECORD_SIGNING_DOMAIN = `${RECORD_SCHEMA}\n`;
/** A record is accepted only if its time is within this many seconds of the server's clock. */
export const MAX_SKEW_SECONDS = 600;

export const KINDS = ['draft', 'softcommit', 'application', 'decision', 'question', 'answer'] as const;
export type Kind = (typeof KINDS)[number];

export type RecordEnvelope = { schema: typeof RECORD_SCHEMA; kind: Kind; signer: string; issuedAt: number; body: Record<string, unknown> };
export type SignedRecord = { record: RecordEnvelope; signature: string };

export const recordId = (r: RecordEnvelope): string => hashJcs(r as unknown as Json);
export const signingMessage = (id: string): string => RECORD_SIGNING_DOMAIN + id;

/** The id matches the record and the signature is the signer's over it. Does not check the body or the signer's standing. */
export async function verifyRecord(r: RecordEnvelope, signatureHex: string, id: string): Promise<{ ok: true } | { ok: false; reason: 'ID_MISMATCH' | 'BAD_SIGNATURE' | 'MALFORMED' }> {
  if (recordId(r) !== id) return { ok: false, reason: 'ID_MISMATCH' };
  if (typeof signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(signatureHex)) return { ok: false, reason: 'MALFORMED' };
  try {
    const key = await getPublicKeyFromAddress(toAddress(r.signer));
    const ok = await verifySignature(key, Uint8Array.from(Buffer.from(signatureHex, 'hex')) as SignatureBytes, new TextEncoder().encode(signingMessage(id)));
    return ok ? { ok: true } : { ok: false, reason: 'BAD_SIGNATURE' };
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
}

/** Parses a non-negative decimal string into atoms; null if malformed or more precise than `decimals`. */
export function parseDecimal(text: unknown, decimals: number): bigint | null {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,30})(?:\.(\d{1,30}))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}
