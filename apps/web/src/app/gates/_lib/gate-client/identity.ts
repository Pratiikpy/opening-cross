// Vendored from packages/cross-gate-client/src by scripts/vendor-web.mjs. Do not edit here: change the package and run `pnpm --filter @opening-cross/cross-gate-client vendor:web`.
// The identity record a gate with rules consumes (ADR-0900) and the SAS schemas that carry it.

/** Terms flag bits. The same bits appear in `oc-identity` attestations and in `Terms.flags`. */
export const FLAG = { accredited: 1, affiliate: 2, sanctionsClear: 4, kyc: 8 } as const;
export const FLAGS_KNOWN = FLAG.accredited | FLAG.affiliate | FLAG.sanctionsClear | FLAG.kyc;

export const Tier = { unspecified: 0, retail: 1, accredited: 2, qualified: 3 } as const;

/** Where a pass came from (`Terms.source`). */
export const SOURCE = { authority: 0, sas: 1, merkle: 2 } as const;

/** SAS schema data-type codes used by the schemas below (research/repos/integrate/sas, `SchemaDataTypes`). */
const T = { U8: 0, U16: 1, U64: 3, U128: 4 } as const;

/** `oc-identity` v1: one attestation per wallet (nonce = wallet), issued by the gate's identity attester. */
export const IDENTITY_SCHEMA = {
  name: 'oc-identity',
  version: 1,
  description: 'Opening Cross identity record: pseudonymous identity id, ISO 3166-1 numeric country, tier, flags and per-identity cap. No personal data.',
  layout: new Uint8Array([T.U128, T.U128, T.U16, T.U8, T.U8, T.U64]),
  fieldNames: ['id_a', 'id_b', 'country', 'tier', 'flags', 'cap'],
} as const;

/** `oc-accreditation` v1: a separate attester vouches that the wallet's holder is an accredited investor. */
export const ACCREDITATION_SCHEMA = {
  name: 'oc-accreditation',
  version: 1,
  description: 'Opening Cross accreditation record: method used to verify accredited-investor status (1 third-party letter, 2 broker-dealer or RIA letter, 3 other).',
  layout: new Uint8Array([T.U8]),
  fieldNames: ['method'],
} as const;

export const IDENTITY_DATA_LENGTH = 44;

export type IdentityRecord = {
  /** 32 opaque bytes, unique per person per attester. */
  identity: Uint8Array;
  /** ISO 3166-1 numeric (0 = unknown). */
  country: number;
  tier: number;
  flags: number;
  /** Quote atoms per cross (0 = the gate's default). */
  cap: bigint;
};

/** The 44 bytes of an `oc-identity` v1 attestation, little-endian. SAS checks them against the schema layout. */
export function packIdentityData(r: IdentityRecord): Uint8Array {
  if (r.identity.length !== 32) throw new Error('identity must be 32 bytes');
  if (!Number.isInteger(r.country) || r.country < 0 || r.country > 999) throw new Error('country must be an ISO 3166-1 numeric code (0 to 999)');
  if (!Number.isInteger(r.tier) || r.tier < 0 || r.tier > 3) throw new Error('tier must be 0 to 3');
  if ((r.flags & ~FLAGS_KNOWN) !== 0 || r.flags < 0 || r.flags > 255) throw new Error('flags may only use the four defined bits');
  if (r.cap < 0n || r.cap > 0xffff_ffff_ffff_ffffn) throw new Error('cap must fit in a u64');
  const out = new Uint8Array(IDENTITY_DATA_LENGTH);
  const dv = new DataView(out.buffer);
  out.set(r.identity, 0);
  dv.setUint16(32, r.country, true);
  out[34] = r.tier;
  out[35] = r.flags;
  dv.setBigUint64(36, r.cap, true);
  return out;
}

/** Inverse of {@link packIdentityData}; throws on any other length so a wrong schema never decodes by accident. */
export function unpackIdentityData(data: Uint8Array): IdentityRecord {
  if (data.length !== IDENTITY_DATA_LENGTH) throw new Error(`oc-identity data is ${IDENTITY_DATA_LENGTH} bytes, got ${data.length}`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { identity: data.slice(0, 32), country: dv.getUint16(32, true), tier: data[34]!, flags: data[35]!, cap: dv.getBigUint64(36, true) };
}

export const ZERO_IDENTITY = new Uint8Array(32);
