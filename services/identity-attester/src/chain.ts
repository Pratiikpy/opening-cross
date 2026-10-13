// SAS on devnet: set up the attester's credential and schema, and issue one attestation per wallet. Uses the Solana Attestation
// Service's own instructions (sas-lib); nothing here is a stand-in for them.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
  getCloseAttestationInstruction,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
} from 'sas-lib';

export const SAS_PROGRAM_ADDRESS = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG' as Address;
export const CREDENTIAL_NAME = 'oc-devnet-test-attester';
export const SCHEMA_NAME = 'wallet-control-check';
export const SCHEMA_VERSION = 1;
/** The one field of the schema: 1 means the wallet signed the attester's challenge. It records nothing about a person. */
export const SCHEMA_DESCRIPTION = 'Devnet test attester. check=1: the wallet signed a challenge. No identity was verified.';
export const CHECK_WALLET_CONTROL = 1;

const asIx = (x: unknown) => x as Instruction;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Chain = ReturnType<typeof createChain>;

export function createChain(rpcUrl: string) {
  const rpc = createSolanaRpc(rpcUrl);

  // The public devnet endpoint answers bursts with HTTP 429; retry reads and sends with a short backoff.
  async function retry<T>(f: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await f();
      } catch (e) {
        if (attempt >= 6 || !/429|Too Many|fetch failed|ETIMEDOUT|ECONNRESET/.test(`${e} ${(e as { cause?: unknown }).cause}`)) throw e;
        await sleep(Math.min(8_000, 500 * 2 ** attempt));
      }
    }
  }

  async function account(a: Address): Promise<{ data: Uint8Array; owner: Address } | null> {
    const { value } = await retry(() => rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send());
    return value ? { data: new Uint8Array(Buffer.from(value.data[0], 'base64')), owner: value.owner } : null;
  }

  async function send(ixs: Instruction[], payer: KeyPairSigner): Promise<string> {
    const { value: lifetime } = await retry(() => rpc.getLatestBlockhash({ commitment: 'confirmed' }).send());
    const tx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
    );
    const sig = getSignatureFromTransaction(tx);
    await retry(() => rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' }).send());
    for (let i = 0; i < 90; i++) {
      const { value } = await retry(() => rpc.getSignatureStatuses([sig]).send());
      const st = value[0];
      if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
      await sleep(1_000);
    }
    throw new Error(`transaction ${sig} was not confirmed within 90 s`);
  }

  /** The cluster's clock, which is what the programs compare an attestation's expiry with. */
  async function chainTime(): Promise<bigint> {
    const slot = await retry(() => rpc.getSlot({ commitment: 'confirmed' }).send());
    const t = await retry(() => rpc.getBlockTime(slot).send());
    return BigInt(t);
  }

  /** Creates the credential and schema if they are not on chain yet. Idempotent. */
  async function init(authority: KeyPairSigner) {
    const [credential] = await deriveCredentialPda({ authority: authority.address, name: CREDENTIAL_NAME });
    const [schema] = await deriveSchemaPda({ credential, name: SCHEMA_NAME, version: SCHEMA_VERSION });
    const sigs: string[] = [];
    if (!(await account(credential))) {
      sigs.push(await send([asIx(getCreateCredentialInstruction({ payer: authority, credential, authority, name: CREDENTIAL_NAME, signers: [authority.address] } as never))], authority));
    }
    if (!(await account(schema))) {
      sigs.push(await send([asIx(getCreateSchemaInstruction({ payer: authority, authority, credential, schema, name: SCHEMA_NAME, description: SCHEMA_DESCRIPTION, layout: new Uint8Array([0]), fieldNames: ['check'] } as never))], authority));
    }
    return { credential: credential as Address, schema: schema as Address, signatures: sigs };
  }

  return { rpc, account, send, chainTime, init };
}

export type Issued = { attestation: Address; expiry: bigint; signature: string | null; reused: boolean };

/**
 * Issues the attestation for `wallet` (nonce = the wallet, which is how cross_gate finds it). A live attestation with at least half its
 * lifetime left is returned as it is, so asking twice costs nothing. An expired one is closed and re-issued in the same transaction.
 */
export async function issueAttestation(i: {
  chain: Chain;
  signer: KeyPairSigner;
  credential: Address;
  schema: Address;
  wallet: Address;
  ttlSeconds: number;
}): Promise<Issued> {
  const { chain, signer, credential, schema, wallet, ttlSeconds } = i;
  const [attestation] = await deriveAttestationPda({ credential, schema, nonce: wallet });
  const now = await chain.chainTime();
  const existing = await chain.account(attestation);
  const ixs: Instruction[] = [];
  if (existing && existing.owner === SAS_PROGRAM_ADDRESS && existing.data.length > 0) {
    const d = existing.data;
    const len = new DataView(d.buffer, d.byteOffset).getUint32(97, true);
    const expiry = new DataView(d.buffer, d.byteOffset).getBigInt64(101 + len + 32, true);
    if (expiry === 0n || expiry - now > BigInt(ttlSeconds) / 2n) return { attestation, expiry, signature: null, reused: true };
    ixs.push(asIx(getCloseAttestationInstruction({ payer: signer, authority: signer, credential, attestation } as never)));
  }
  const expiry = now + BigInt(ttlSeconds);
  ixs.push(asIx(getCreateAttestationInstruction({ payer: signer, authority: signer, credential, schema, attestation, nonce: wallet, data: new Uint8Array([CHECK_WALLET_CONTROL]), expiry } as never)));
  const signature = await chain.send(ixs, signer);
  return { attestation, expiry, signature, reused: false };
}
