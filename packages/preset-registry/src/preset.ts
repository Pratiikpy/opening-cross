// A preset is a starting shape for a cross: its kind, how many price levels, how long the call runs. It never chooses a price, a
// supply or a raise, which belong to the token, and it is not advice. Anyone can publish one: a preset is a document signed by its
// author, versioned, and valid only if its fields are ones the program accepts. A cross is attributed to the preset it used by a memo in
// its creation transaction, so attribution is on chain without a program change and cannot be claimed by someone who did not use it.
import { type Signed, verifyDocument } from '@opening-cross/attest';
import { isAddress } from '@solana/kit';

export const PRESET_SCHEMA = 'opening-cross/preset/v1';
export const KINDS = ['launch', 'reopen', 'tender', 'recurring'] as const;
export const DISCLOSURES = ['sealed', 'open'] as const;
export const SUPPLY_MODES = ['escrow', 'mint'] as const;
/** What the program allows (programs/cross_core/src/state.rs). */
export const MAX_TICKS = 256;
/** The highest royalty an author may declare. The royalty is a claim: nothing on chain pays it. */
export const MAX_ROYALTY_BPS = 1000;

export interface PresetFields {
  readonly [k: string]: string | number;
  readonly kind: (typeof KINDS)[number];
  readonly disclosure: (typeof DISCLOSURES)[number];
  readonly supplyMode: (typeof SUPPLY_MODES)[number];
  readonly ticks: number;
  /** Step between prices as a share of the lowest price, in basis points. */
  readonly stepBps: number;
  readonly openInMinutes: number;
  readonly callMinutes: number;
  readonly revealMinutes: number;
  readonly maxOrders: number;
}

export interface PresetBody {
  readonly [k: string]: string | number | PresetFields | readonly string[] | undefined;
  readonly schema: typeof PRESET_SCHEMA;
  /** A slug, unique per author. */
  readonly id: string;
  readonly version: number;
  /** The author's address; the document must be signed by it. */
  readonly author: string;
  readonly name: string;
  readonly summary: string;
  readonly fields: PresetFields;
  /** What the author says it is owed per use, in basis points of the protocol fee. DECLARED, not enforced. */
  readonly royaltyBps: number;
  readonly tags: readonly string[];
  readonly createdAt: number;
}
export type SignedPreset = Signed<PresetBody>;

export class PresetError extends Error {
  override readonly name = 'PresetError';
}

const int = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new PresetError(`${what} must be a whole number from ${lo} to ${hi}`);
  return v;
};
const text = (v: unknown, lo: number, hi: number, what: string): string => {
  if (typeof v !== 'string' || v.trim().length < lo || v.length > hi) throw new PresetError(`${what} must be ${lo} to ${hi} characters`);
  return v;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], what: string): T => {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new PresetError(`${what} must be one of ${allowed.join(', ')}`);
  return v as T;
};

/** Checks a preset body against what the program and the product accept; throws a PresetError saying which field is wrong. */
export function validatePreset(b: PresetBody): void {
  if (b.schema !== PRESET_SCHEMA) throw new PresetError(`schema must be ${PRESET_SCHEMA}`);
  if (typeof b.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,39}$/.test(b.id)) throw new PresetError('id must be 3 to 40 lower-case letters, digits or hyphens, not starting with a hyphen');
  int(b.version, 1, 10_000, 'version');
  if (typeof b.author !== 'string' || !isAddress(b.author)) throw new PresetError('author must be a base58 address');
  text(b.name, 3, 60, 'name');
  text(b.summary, 10, 300, 'summary');
  int(b.royaltyBps, 0, MAX_ROYALTY_BPS, 'royaltyBps');
  int(b.createdAt, 0, 4_102_444_800, 'createdAt');
  if (!Array.isArray(b.tags) || b.tags.length > 5 || b.tags.some((t) => typeof t !== 'string' || !/^[a-z0-9-]{2,24}$/.test(t))) throw new PresetError('tags are at most 5 words of 2 to 24 lower-case letters, digits or hyphens');
  const f = b.fields;
  if (!f || typeof f !== 'object') throw new PresetError('fields is required');
  const kind = oneOf(f.kind, KINDS, 'fields.kind');
  const disclosure = oneOf(f.disclosure, DISCLOSURES, 'fields.disclosure');
  const supplyMode = oneOf(f.supplyMode, SUPPLY_MODES, 'fields.supplyMode');
  int(f.ticks, 2, MAX_TICKS, 'fields.ticks');
  int(f.stepBps, 1, 5_000, 'fields.stepBps');
  int(f.openInMinutes, 0, 7 * 24 * 60, 'fields.openInMinutes');
  int(f.callMinutes, 5, 30 * 24 * 60, 'fields.callMinutes');
  int(f.maxOrders, 1, 100_000, 'fields.maxOrders');
  // A sealed call needs time to reveal; an open one has nothing to reveal.
  if (disclosure === 'sealed') int(f.revealMinutes, 5, 24 * 60, 'fields.revealMinutes');
  else if (f.revealMinutes !== 0) throw new PresetError('an open preset has no reveal window: fields.revealMinutes must be 0');
  // The program refuses sells in a minting cross, so a minting preset must be a launch.
  if (supplyMode === 'mint' && kind !== 'launch' && kind !== 'recurring') throw new PresetError('a minting preset must be a launch or recurring cross: the issuer mints the supply, and a reopen or a tender sells existing tokens');
}

/** Verifies the signature and that the signer is the author, then validates the body. */
export async function checkSignedPreset(doc: SignedPreset): Promise<void> {
  const c = await verifyDocument(doc as never).catch(() => ({ ok: false as const, reason: 'MALFORMED' as const }));
  if (!c.ok) throw new PresetError(`the document does not verify (${c.reason})`);
  validatePreset(doc.body);
  if (doc.signer !== doc.body.author) throw new PresetError('the document must be signed by its author');
}

// ------------------------------------------------------------------------------------------------------ attribution

export const MEMO_PREFIX = 'oc-preset:1:';
/** The memo a creation transaction carries to say which preset it used. */
export const presetMemo = (author: string, id: string, version: number): string => `${MEMO_PREFIX}${author}/${id}@${version}`;
export function parsePresetMemo(memo: string): { author: string; id: string; version: number } | null {
  const m = /^oc-preset:1:([1-9A-HJ-NP-Za-km-z]{32,44})\/([a-z0-9][a-z0-9-]{2,39})@([0-9]{1,5})$/.exec(memo);
  return m ? { author: m[1]!, id: m[2]!, version: Number(m[3]) } : null;
}
