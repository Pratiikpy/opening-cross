// The attester's side of the Solana Attestation Service: its credential, the two schemas, and one attestation per wallet
// (nonce = the wallet). Chain access goes through a ChainPort so the same code runs on a live RPC and on LiteSVM.
import { type Address, type Instruction, type TransactionSigner, getAddressDecoder } from '@solana/kit';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCloseAttestationInstruction,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';
import { ACCREDITATION_SCHEMA, IDENTITY_SCHEMA, SAS_PROGRAM_ADDRESS, type IdentityRecord, packIdentityData, unpackIdentityData } from '@opening-cross/cross-gate-client';

export type ChainAccount = { data: Uint8Array; owner: string };

export interface ChainPort {
  getAccount(address: Address): Promise<ChainAccount | null>;
  /** Every attestation account under (credential, schema), with its address and raw account data. */
  listAttestations(credential: Address, schema: Address): Promise<{ address: Address; data: Uint8Array }[]>;
  /** Signs with the attester key, lands the transaction, and throws if it fails. Returns the signature. */
  send(instructions: Instruction[]): Promise<string>;
}

// sas-lib targets another @solana/kit major; instructions are plain data, so they are cast at this one boundary.
const ix = (x: unknown) => x as Instruction;

export type SasAddresses = { credential: Address; identitySchema: Address; accreditationSchema: Address };

export type AttestationState = {
  address: Address;
  wallet: Address;
  /** 0 = never expires. */
  expiry: bigint;
  data: Uint8Array;
};

/** The fields of a SAS attestation account (discriminator 2): nonce, credential, schema, data (u32 length), signer, expiry. */
export function parseAttestation(data: Uint8Array): { nonce: Address; credential: Address; schema: Address; payload: Uint8Array; expiry: bigint } | null {
  if (data.length < 101 + 32 + 8 || data[0] !== 2) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(97, true);
  if (data.length < 101 + len + 32 + 8) return null;
  return {
    nonce: base58(data.slice(1, 33)),
    credential: base58(data.slice(33, 65)),
    schema: base58(data.slice(65, 97)),
    payload: data.slice(101, 101 + len),
    expiry: dv.getBigInt64(101 + len + 32, true),
  };
}

const base58 = (bytes: Uint8Array): Address => getAddressDecoder().decode(bytes);

/** What the attester needs from an attestation store: SasService on chain, or an in-memory double in unit tests. */
export interface AttestationStore {
  read(wallet: Address): Promise<AttestationState | null>;
  list(): Promise<AttestationState[]>;
  upsert(wallet: Address, record: IdentityRecord, expiry: bigint): Promise<{ action: 'created' | 'replaced' | 'unchanged'; address: Address; signature?: string }>;
  close(wallet: Address): Promise<{ closed: boolean; signature?: string }>;
}

export class SasService implements AttestationStore {
  constructor(
    private readonly chain: ChainPort,
    private readonly signer: TransactionSigner,
    private readonly credentialName: string,
  ) {}

  async addresses(): Promise<SasAddresses> {
    const [credential] = await deriveCredentialPda({ authority: this.signer.address, name: this.credentialName });
    const [identitySchema] = await deriveSchemaPda({ credential, name: IDENTITY_SCHEMA.name, version: IDENTITY_SCHEMA.version });
    const [accreditationSchema] = await deriveSchemaPda({ credential, name: ACCREDITATION_SCHEMA.name, version: ACCREDITATION_SCHEMA.version });
    return { credential, identitySchema, accreditationSchema };
  }

  private async exists(a: Address): Promise<boolean> {
    const acct = await this.chain.getAccount(a);
    return acct !== null && acct.owner === SAS_PROGRAM_ADDRESS;
  }

  /** Creates the credential and both schemas that are missing. Idempotent. Returns what it created. */
  async init(): Promise<{ addresses: SasAddresses; created: string[] }> {
    const addresses = await this.addresses();
    const created: string[] = [];
    if (!(await this.exists(addresses.credential))) {
      await this.chain.send([ix(getCreateCredentialInstruction({ payer: this.signer, credential: addresses.credential, authority: this.signer, name: this.credentialName, signers: [this.signer.address] } as never))]);
      created.push('credential');
    }
    for (const [key, schemaAddress, def] of [
      ['identity schema', addresses.identitySchema, IDENTITY_SCHEMA],
      ['accreditation schema', addresses.accreditationSchema, ACCREDITATION_SCHEMA],
    ] as const) {
      if (await this.exists(schemaAddress)) continue;
      await this.chain.send([
        ix(getCreateSchemaInstruction({ payer: this.signer, authority: this.signer, credential: addresses.credential, schema: schemaAddress, name: def.name, description: def.description, layout: def.layout, fieldNames: [...def.fieldNames] } as never)),
      ]);
      created.push(key);
    }
    return { addresses, created };
  }

  async attestationAddress(wallet: Address): Promise<Address> {
    const { credential, identitySchema } = await this.addresses();
    return (await deriveAttestationPda({ credential, schema: identitySchema, nonce: wallet }))[0];
  }

  /** The wallet's identity attestation as it is on chain, or `null` if there is none. */
  async read(wallet: Address): Promise<AttestationState | null> {
    const address = await this.attestationAddress(wallet);
    const acct = await this.chain.getAccount(address);
    if (!acct || acct.owner !== SAS_PROGRAM_ADDRESS) return null;
    const a = parseAttestation(acct.data);
    return a ? { address, wallet, expiry: a.expiry, data: a.payload } : null;
  }

  /** Every identity attestation this credential has issued and not closed. */
  async list(): Promise<AttestationState[]> {
    const { credential, identitySchema } = await this.addresses();
    const out: AttestationState[] = [];
    for (const { address, data } of await this.chain.listAttestations(credential, identitySchema)) {
      const a = parseAttestation(data);
      if (a && a.credential === credential && a.schema === identitySchema) out.push({ address, wallet: a.nonce, expiry: a.expiry, data: a.payload });
    }
    return out;
  }

  /**
   * Makes the wallet's attestation say exactly `record` until `expiry`. Creates it, leaves it alone if it already says
   * that, and otherwise replaces it in one transaction (close then create) so there is no moment without an attestation in
   * which anyone could revoke the wallet's pass.
   */
  async upsert(wallet: Address, record: IdentityRecord, expiry: bigint): Promise<{ action: 'created' | 'replaced' | 'unchanged'; address: Address; signature?: string }> {
    const { credential, identitySchema } = await this.addresses();
    const [address] = await deriveAttestationPda({ credential, schema: identitySchema, nonce: wallet });
    const data = packIdentityData(record);
    const have = await this.read(wallet);
    if (have && have.expiry === expiry && same(have.data, data)) return { action: 'unchanged', address };
    const create = ix(getCreateAttestationInstruction({ payer: this.signer, authority: this.signer, credential, schema: identitySchema, attestation: address, nonce: wallet, data, expiry } as never));
    if (!have) return { action: 'created', address, signature: await this.chain.send([create]) };
    const close = ix(getCloseAttestationInstruction({ payer: this.signer, authority: this.signer, credential, attestation: address } as never));
    return { action: 'replaced', address, signature: await this.chain.send([close, create]) };
  }

  /** Closes the wallet's attestation if there is one; the gate then lets anyone revoke the wallet's pass. */
  async close(wallet: Address): Promise<{ closed: boolean; signature?: string }> {
    const { credential } = await this.addresses();
    const have = await this.read(wallet);
    if (!have) return { closed: false };
    const close = ix(getCloseAttestationInstruction({ payer: this.signer, authority: this.signer, credential, attestation: have.address } as never));
    return { closed: true, signature: await this.chain.send([close]) };
  }
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export { unpackIdentityData };
