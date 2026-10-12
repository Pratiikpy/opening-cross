// The Node-only half of the client: a keypair file as a signer, and a sealed-bid vault kept in a file. Import it from
// `@opening-cross/client/node`; the main entry point has no dependency on `node:*` modules and runs in a browser.
//
// This module never generates a key and never writes one anywhere. A key file is read, used to sign in memory, and
// forgotten; no error message ever contains key material.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Address, createKeyPairSignerFromBytes, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from '@solana/kit';
import { ActionError } from './errors.js';
import type { Signer } from './pipeline.js';
import { type ClientStore, type SealedBid, memoryStore, parseBackup, serializeBackup } from './sealed.js';

export type KeypairSigner = { address: Address; sign: Signer };

/** Parses the contents of a Solana CLI keypair file: a JSON array of 64 bytes (32 secret, 32 public). */
export async function signerFromKeypairBytes(text: string, source: string): Promise<KeypairSigner> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ActionError(`${source} is not a Solana keypair file: it is not valid JSON.`, 'INVALID_INPUT');
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new ActionError(`${source} is not a Solana keypair file: expected a JSON array of 64 bytes.`, 'INVALID_INPUT');
  }
  let signer;
  try {
    signer = await createKeyPairSignerFromBytes(Uint8Array.from(parsed as number[]));
  } catch {
    throw new ActionError(`${source} does not hold a valid keypair (the public half does not match the secret half).`, 'INVALID_INPUT');
  }
  const decoder = getTransactionDecoder();
  const encoder = getTransactionEncoder();
  const sign: Signer = async ({ transaction }) => {
    const signed = await partiallySignTransaction([signer.keyPair], decoder.decode(transaction));
    return { signedTransaction: Uint8Array.from(encoder.encode(signed)) };
  };
  return { address: signer.address, sign };
}

/** Reads a keypair file and returns its signer. A missing or unreadable file is a typed error that names the path, never the contents. */
export async function loadKeypairSigner(path: string): Promise<KeypairSigner> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new ActionError(code === 'ENOENT' ? `No keypair file at ${path}.` : `Could not read the keypair file ${path} (${code ?? 'error'}).`, 'INVALID_INPUT');
  }
  return signerFromKeypairBytes(text, path);
}

/**
 * Sealed bids kept in a JSON file in the same format as the backup the web app downloads (`opening-bell/sealed-bids/v1`),
 * so the file can be loaded into the web app and the other way round. The file is written atomically and, where the
 * platform has permissions, readable by its owner only: it holds the salts that hide the bids.
 */
export function fileStore(path: string): ClientStore {
  const memory = memoryStore();
  const read = async (): Promise<SealedBid[]> => {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ActionError(`Could not read the sealed-bid file ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'}).`, 'INVALID_INPUT');
    }
    return parseBackup(text);
  };
  return {
    list: async (cross, owner) => (await read()).filter((b) => b.cross === cross && b.owner === owner),
    save: async (bid) => {
      const all = (await read()).filter((b) => !(b.cross === bid.cross && b.owner === bid.owner && b.nonce === bid.nonce));
      const tmp = `${path}.tmp-${process.pid}`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(tmp, serializeBackup([...all, bid]), { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, path);
        await chmod(path, 0o600).catch(() => {});
      } catch (e) {
        throw new ActionError(`Could not store the sealed bid in ${path} (${(e as NodeJS.ErrnoException).code ?? 'error'}), so it could not be revealed later. Nothing was sent.`, 'INVALID_INPUT');
      }
    },
    remember: memory.remember,
    remembered: memory.remembered,
  };
}
