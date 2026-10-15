// Instruction builders for gates with compliance rules (ADR-0900). Each resolves the program-derived accounts so a
// caller supplies a mint, a wallet and the evidence for the pass, not eleven addresses.
import { type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import {
  type RulesArgs,
  type TermsDataArgs,
  findConfigPda,
  getAllowWalletInstruction,
  getClaimPassAttestedInstruction,
  getClaimPassMerkleTermsInstruction,
  getDenyWalletInstruction,
  getGrantPassTermsInstruction,
  getInitRulesInstruction,
  getOpenVolumeInstruction,
  getRefreshTermsInstruction,
  getRevokeDeniedInstruction,
  getRevokeExpiredInstruction,
  getRevokeNonconformingInstruction,
  getRevokePassTermsInstruction,
  getSetRulesInstruction,
  getUpdateHookMetasInstructionAsync,
} from './generated/index.js';
import { findAttestationAddress, findDeniedAddress, findIdentityAddress, findPassAddress, findTermsAddress, findVolumeAddress } from './pdas.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;

async function pass(mint: Address, owner: Address, identity: Uint8Array, previousHolder: Address | null | undefined) {
  const [config] = await findConfigPda({ mint });
  const [denied] = await findDeniedAddress(mint, owner);
  const [passAddress] = await findPassAddress(mint, owner);
  const [terms] = await findTermsAddress(mint, owner);
  const [binding] = await findIdentityAddress(mint, identity);
  const [volume] = await findVolumeAddress(mint, owner);
  // Only inspected when the identity is held by another wallet; any address is accepted otherwise.
  const previousPass = previousHolder ? (await findPassAddress(mint, previousHolder))[0] : SYSTEM_PROGRAM;
  return { config, denied, pass: passAddress, terms, binding, volume, previousPass };
}

export type SasRef = { credential: Address; schema: Address };

/** Switches a gate to compliance rules (the authority pays for the larger config account). */
export async function initRules(i: { authority: TransactionSigner; mint: Address; rules: RulesArgs }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  return getInitRulesInstruction({ authority: i.authority, config, rules: i.rules });
}

export async function setRules(i: { authority: TransactionSigner; mint: Address; rules: RulesArgs }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  return getSetRulesInstruction({ authority: i.authority, config, rules: i.rules });
}

/**
 * A wallet's pass from its SAS identity attestation (and accreditation attestation if the gate has an accreditation
 * attester). `identity` is the 32-byte id inside the attestation; `previousHolder` is the wallet that held this
 * identity before, if any (read the identity-binding account first).
 */
export async function claimPassAttested(i: {
  payer: TransactionSigner;
  owner: Address;
  mint: Address;
  identity: Uint8Array;
  identitySas: SasRef;
  accreditationSas?: SasRef | null;
  previousHolder?: Address | null;
}): Promise<Instruction> {
  const a = await pass(i.mint, i.owner, i.identity, i.previousHolder);
  const [identityAttestation] = await findAttestationAddress(i.identitySas.credential, i.identitySas.schema, i.owner);
  const accreditationAttestation = i.accreditationSas ? (await findAttestationAddress(i.accreditationSas.credential, i.accreditationSas.schema, i.owner))[0] : undefined;
  return getClaimPassAttestedInstruction({
    payer: i.payer,
    owner: i.owner,
    config: a.config,
    identityAttestation,
    ...(accreditationAttestation ? { accreditationAttestation } : {}),
    denied: a.denied,
    pass: a.pass,
    terms: a.terms,
    binding: a.binding,
    previousPass: a.previousPass,
    volume: a.volume,
    identity: i.identity,
  });
}

export async function claimPassMerkleTerms(i: { payer: TransactionSigner; owner: Address; mint: Address; terms: TermsDataArgs; proof: readonly Uint8Array[]; previousHolder?: Address | null }): Promise<Instruction> {
  const a = await pass(i.mint, i.owner, Uint8Array.from(i.terms.identity), i.previousHolder);
  return getClaimPassMerkleTermsInstruction({ payer: i.payer, owner: i.owner, config: a.config, denied: a.denied, pass: a.pass, terms: a.terms, binding: a.binding, previousPass: a.previousPass, volume: a.volume, args: i.terms, proof: i.proof.map((p) => Uint8Array.from(p)) });
}

export async function grantPassTerms(i: { authority: TransactionSigner; mint: Address; owner: Address; terms: TermsDataArgs; previousHolder?: Address | null }): Promise<Instruction> {
  const a = await pass(i.mint, i.owner, Uint8Array.from(i.terms.identity), i.previousHolder);
  return getGrantPassTermsInstruction({ authority: i.authority, config: a.config, denied: a.denied, pass: a.pass, terms: a.terms, binding: a.binding, previousPass: a.previousPass, volume: a.volume, owner: i.owner, args: i.terms });
}

/** Re-reads the wallet's attestations and updates its terms in place. */
export async function refreshTerms(i: { mint: Address; owner: Address; identitySas: SasRef; accreditationSas?: SasRef | null }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  const [terms] = await findTermsAddress(i.mint, i.owner);
  const [identityAttestation] = await findAttestationAddress(i.identitySas.credential, i.identitySas.schema, i.owner);
  const accreditationAttestation = i.accreditationSas ? (await findAttestationAddress(i.accreditationSas.credential, i.accreditationSas.schema, i.owner))[0] : undefined;
  return getRefreshTermsInstruction({ config, identityAttestation, ...(accreditationAttestation ? { accreditationAttestation } : {}), terms });
}

async function revocation(mint: Address, owner: Address, identity: Uint8Array | null) {
  const [config] = await findConfigPda({ mint });
  const [passAddress] = await findPassAddress(mint, owner);
  const [terms] = await findTermsAddress(mint, owner);
  const [volume] = await findVolumeAddress(mint, owner);
  // The binding is named by the terms' identity; a caller that does not know it passes the zero identity's address.
  const [binding] = await findIdentityAddress(mint, identity ?? new Uint8Array(32));
  const [denied] = await findDeniedAddress(mint, owner);
  return { config, pass: passAddress, terms, volume, binding, denied };
}

/** The authority closes a pass, with its terms, binding and volume. */
export async function revokePassTerms(i: { authority: TransactionSigner; mint: Address; owner: Address; identity?: Uint8Array | null }): Promise<Instruction> {
  const a = await revocation(i.mint, i.owner, i.identity ?? null);
  return getRevokePassTermsInstruction({ authority: i.authority, config: a.config, owner: i.owner, pass: a.pass, terms: a.terms, binding: a.binding, volume: a.volume });
}

type PermissionlessRevoke = { mint: Address; owner: Address; identity?: Uint8Array | null; identitySas?: SasRef | null };

async function permissionless(i: PermissionlessRevoke) {
  const a = await revocation(i.mint, i.owner, i.identity ?? null);
  // Only `revoke_expired` reads the attestation; the others accept any address, so default to the wallet's own PDA when known.
  const identityAttestation = i.identitySas ? (await findAttestationAddress(i.identitySas.credential, i.identitySas.schema, i.owner))[0] : SYSTEM_PROGRAM;
  return { ...a, identityAttestation };
}

/** Anyone closes a pass whose terms expired or whose SAS attestation is gone. */
export async function revokeExpired(i: PermissionlessRevoke): Promise<Instruction> {
  const a = await permissionless(i);
  return getRevokeExpiredInstruction({ config: a.config, owner: i.owner, pass: a.pass, terms: a.terms, binding: a.binding, volume: a.volume, identityAttestation: a.identityAttestation, denied: a.denied });
}

/** Anyone closes a pass whose terms no longer satisfy the current rules. */
export async function revokeNonconforming(i: PermissionlessRevoke): Promise<Instruction> {
  const a = await permissionless(i);
  return getRevokeNonconformingInstruction({ config: a.config, owner: i.owner, pass: a.pass, terms: a.terms, binding: a.binding, volume: a.volume, identityAttestation: a.identityAttestation, denied: a.denied });
}

/** Anyone closes the pass of a denied wallet. */
export async function revokeDenied(i: PermissionlessRevoke): Promise<Instruction> {
  const a = await permissionless(i);
  return getRevokeDeniedInstruction({ config: a.config, owner: i.owner, pass: a.pass, terms: a.terms, binding: a.binding, volume: a.volume, identityAttestation: a.identityAttestation, denied: a.denied });
}

export async function denyWallet(i: { authority: TransactionSigner; mint: Address; owner: Address; reason: number }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  const [denied] = await findDeniedAddress(i.mint, i.owner);
  return getDenyWalletInstruction({ authority: i.authority, config, denied, owner: i.owner, reason: i.reason });
}

export async function allowWallet(i: { authority: TransactionSigner; mint: Address; owner: Address }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  const [denied] = await findDeniedAddress(i.mint, i.owner);
  return getAllowWalletInstruction({ authority: i.authority, config, denied });
}

/** Opens the affiliate-volume account of a wallet whose terms carry the affiliate flag. Anyone may pay. */
export async function openVolume(i: { payer: TransactionSigner; mint: Address; owner: Address }): Promise<Instruction> {
  const [config] = await findConfigPda({ mint: i.mint });
  const [terms] = await findTermsAddress(i.mint, i.owner);
  const [volume] = await findVolumeAddress(i.mint, i.owner);
  return getOpenVolumeInstruction({ payer: i.payer, config, terms, volume });
}

/**
 * Rewrites the mint's transfer-hook extra-account list to the layout the rules need. Run it after `init_rules` on a gate whose
 * list was written earlier: until then the hook refuses transfers (it fails closed rather than skip the rules).
 */
export async function updateHookMetas(i: { payer: TransactionSigner; authority: TransactionSigner; mint: Address }): Promise<Instruction> {
  return getUpdateHookMetasInstructionAsync({ payer: i.payer, authority: i.authority, mint: i.mint });
}

/** `init_rules` followed by `update_hook_metas`, as one transaction's instructions: the order that never leaves transfers refused. */
export async function initRulesWithHook(i: { payer: TransactionSigner; authority: TransactionSigner; mint: Address; rules: RulesArgs }): Promise<Instruction[]> {
  return [await initRules({ authority: i.authority, mint: i.mint, rules: i.rules }), await updateHookMetas(i)];
}

/**
 * Cuts a wallet off at once: denies it (so it cannot be issued a pass again) and, if it holds one, closes the pass with its
 * terms, identity binding and volume in the same transaction. The authority needs both because `deny_wallet` alone stops
 * only new issuance; anyone can close a denied wallet's pass afterwards with `revoke_denied`, but the compliance officer does
 * not have to wait for them.
 */
export async function blockWallet(i: { authority: TransactionSigner; mint: Address; owner: Address; reason: number; holdsPass: boolean; identity?: Uint8Array | null }): Promise<Instruction[]> {
  const deny = await denyWallet({ authority: i.authority, mint: i.mint, owner: i.owner, reason: i.reason });
  return i.holdsPass ? [deny, await revokePassTerms({ authority: i.authority, mint: i.mint, owner: i.owner, ...(i.identity ? { identity: i.identity } : {}) })] : [deny];
}
