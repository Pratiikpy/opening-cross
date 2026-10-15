// Addresses of the accounts cross_gate keeps beyond the ones Codama derives (ADR-0900). The seeds mirror the
// constants at the top of programs/cross_gate/src/lib.rs.
import { type Address, type ProgramDerivedAddress, type ReadonlyUint8Array, getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder } from '@solana/kit';
import { CROSS_GATE_PROGRAM_ADDRESS } from './generated/programs/index.js';

const addr = getAddressEncoder();
const utf8 = getUtf8Encoder();

export const GATE_SEED = {
  config: 'config',
  pass: 'pass',
  lock: 'lock',
  terms: 'terms',
  identity: 'identity',
  volume: 'volume',
  deny: 'deny',
  alloc: 'alloc',
  hookMetas: 'extra-account-metas',
} as const;

type Opts = { programAddress?: Address };

function pda(seeds: ReadonlyUint8Array[], o: Opts): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress: o.programAddress ?? CROSS_GATE_PROGRAM_ADDRESS, seeds });
}
const need32 = (b: Uint8Array, what: string) => {
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
};

export const findPassAddress = (mint: Address, owner: Address, o: Opts = {}) => pda([utf8.encode(GATE_SEED.pass), addr.encode(mint), addr.encode(owner)], o);
export const findLockAddress = (mint: Address, owner: Address, o: Opts = {}) => pda([utf8.encode(GATE_SEED.lock), addr.encode(mint), addr.encode(owner)], o);
export const findTermsAddress = (mint: Address, owner: Address, o: Opts = {}) => pda([utf8.encode(GATE_SEED.terms), addr.encode(mint), addr.encode(owner)], o);
export const findVolumeAddress = (mint: Address, owner: Address, o: Opts = {}) => pda([utf8.encode(GATE_SEED.volume), addr.encode(mint), addr.encode(owner)], o);
export const findDeniedAddress = (mint: Address, owner: Address, o: Opts = {}) => pda([utf8.encode(GATE_SEED.deny), addr.encode(mint), addr.encode(owner)], o);
export const findIdentityAddress = (mint: Address, identity: Uint8Array, o: Opts = {}) => pda([utf8.encode(GATE_SEED.identity), addr.encode(mint), need32(identity, 'identity')], o);
export const findAllocationAddress = (cross: Address, key: Uint8Array, o: Opts = {}) => pda([utf8.encode(GATE_SEED.alloc), addr.encode(cross), need32(key, 'allocation key')], o);

/** The per-identity key `reserve_allocation` uses: the identity id, or the wallet when the terms carry none. */
export function allocationKey(identity: Uint8Array, owner: Address): Uint8Array {
  return identity.every((b) => b === 0) ? Uint8Array.from(addr.encode(owner)) : need32(identity, 'identity');
}

/** The Solana Attestation Service program (same address on every cluster). */
export const SAS_PROGRAM_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;

/** The SAS attestation PDA `["attestation", credential, schema, nonce]`; for a gate the nonce is the wallet. */
export const findAttestationAddress = (credential: Address, schema: Address, nonce: Address) =>
  getProgramDerivedAddress({ programAddress: SAS_PROGRAM_ADDRESS, seeds: [utf8.encode('attestation'), addr.encode(credential), addr.encode(schema), addr.encode(nonce)] });
