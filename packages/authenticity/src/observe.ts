// Reads one mint from the chain into the observation the classifier consumes.
import {
  type Address,
  type MaybeEncodedAccount,
  type GetAccountInfoApi,
  type GetMultipleAccountsApi,
  type Rpc,
  fetchEncodedAccounts,
  getAddressEncoder,
  getProgramDerivedAddress,
  isSome,
  lamports,
} from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS, decodeMint } from '@solana-program/token-2022';
import { SPL_TOKEN_PROGRAM_ADDRESS, assessMint } from '@opening-cross/token-safety';
import { FINGERPRINT_KEYS, type Fingerprint, type FingerprintKey, type MintObservation } from './types.js';

/** Metaplex Token Metadata program: where a classic SPL mint keeps its name and symbol. */
export const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s' as Address;

type ObserveRpc = Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;

const KEYS = new Set<string>(FINGERPRINT_KEYS);

/** Name and symbol from a Metaplex metadata account; null when it is malformed or belongs to another mint. */
export function parseMetaplexMetadata(data: Uint8Array, mint: string): { name: string; symbol: string } | null {
  // key (1) + update authority (32) + mint (32), then two length-prefixed, NUL-padded strings.
  if (data.length < 1 + 32 + 32 + 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const embedded = getAddressEncoder().encode(mint as Address);
  for (let i = 0; i < 32; i++) if (data[33 + i] !== embedded[i]) return null;
  let at = 65;
  const read = (): string | null => {
    if (at + 4 > data.length) return null;
    const n = view.getUint32(at, true);
    at += 4;
    if (n > 200 || at + n > data.length) return null;
    const s = new TextDecoder().decode(data.subarray(at, at + n)).replace(/\0+$/g, '');
    at += n;
    return s;
  };
  const name = read();
  const symbol = read();
  return name === null || symbol === null ? null : { name, symbol };
}

export async function metaplexMetadataAddress(mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: METAPLEX_METADATA_PROGRAM,
    seeds: [new TextEncoder().encode('metadata'), getAddressEncoder().encode(METAPLEX_METADATA_PROGRAM), getAddressEncoder().encode(mint)],
  });
  return pda;
}

const MISSING = (mint: string): MintObservation => ({ mint, exists: false, owner: null, isMint: false, decimals: null, fingerprint: {}, name: null, symbol: null });

type Encoded = MaybeEncodedAccount;

/** Decodes a fetched account. The Metaplex fallback needs a second account, so it is fetched by the caller. */
export function observeFromAccount(mint: string, account: Encoded, nowSeconds: bigint): { observation: MintObservation; needsMetaplex: boolean } {
  if (!account.exists) return { observation: MISSING(mint), needsMetaplex: false };
  const owner = account.programAddress;
  if (owner !== TOKEN_2022_PROGRAM_ADDRESS && owner !== SPL_TOKEN_PROGRAM_ADDRESS) {
    return { observation: { mint, exists: true, owner, isMint: false, decimals: null, fingerprint: {}, name: null, symbol: null }, needsMetaplex: false };
  }
  let decoded;
  try {
    decoded = decodeMint(account);
  } catch {
    // A token-program account that is not a mint (a token account, a multisig).
    return { observation: { mint, exists: true, owner, isMint: false, decimals: null, fingerprint: {}, name: null, symbol: null }, needsMetaplex: false };
  }
  const report = assessMint(mint as Address, owner, decoded.data, nowSeconds);
  const fingerprint: Record<string, string> = {};
  for (const r of report.risks) if (r.holder && KEYS.has(r.code)) fingerprint[r.code as FingerprintKey] = r.holder;
  let name: string | null = null;
  let symbol: string | null = null;
  const extensions = isSome(decoded.data.extensions) ? decoded.data.extensions.value : [];
  for (const ext of extensions) {
    if (ext.__kind === 'TokenMetadata' && ext.mint === mint) {
      name = ext.name;
      symbol = ext.symbol;
    }
  }
  return {
    observation: { mint, exists: true, owner, isMint: true, decimals: decoded.data.decimals, fingerprint: fingerprint as Fingerprint, name, symbol },
    needsMetaplex: name === null && symbol === null,
  };
}

/** Observes mints in as few requests as possible: one batch for the mints, one for any Metaplex metadata. */
export async function observeMints(rpc: ObserveRpc, mints: readonly string[], nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000))): Promise<MintObservation[]> {
  const accounts = await fetchEncodedAccounts(rpc, mints as Address[]);
  const decoded = mints.map((m, i) => observeFromAccount(m, accounts[i]!, nowSeconds));
  const need = decoded.map((d, i) => (d.needsMetaplex ? i : -1)).filter((i) => i >= 0);
  if (need.length > 0) {
    const pdas = await Promise.all(need.map((i) => metaplexMetadataAddress(mints[i] as Address)));
    const meta = await fetchEncodedAccounts(rpc, pdas);
    need.forEach((i, j) => {
      const m = meta[j];
      if (m?.exists && m.programAddress === METAPLEX_METADATA_PROGRAM) {
        const parsed = parseMetaplexMetadata(m.data, mints[i] as string);
        if (parsed) decoded[i] = { ...decoded[i]!, observation: { ...decoded[i]!.observation, name: parsed.name, symbol: parsed.symbol } };
      }
    });
  }
  return decoded.map((d) => d.observation);
}

export async function observeMint(rpc: ObserveRpc, mint: string, nowSeconds?: bigint): Promise<MintObservation> {
  const [o] = await observeMints(rpc, [mint], nowSeconds);
  return o as MintObservation;
}

export type AccountReader = (address: Address) => Promise<{ readonly data: Uint8Array; readonly owner: Address } | null>;

/** Observes a mint through any account reader (the API's cached reader, a test double), not only an RPC client. */
export async function observeVia(read: AccountReader, mint: string, nowSeconds: bigint = BigInt(Math.floor(Date.now() / 1000))): Promise<MintObservation> {
  const a = await read(mint as Address);
  const account: MaybeEncodedAccount = a
    ? { exists: true, address: mint as Address, data: a.data, programAddress: a.owner, executable: false, lamports: lamports(0n), space: BigInt(a.data.length) }
    : { exists: false, address: mint as Address };
  const { observation, needsMetaplex } = observeFromAccount(mint, account, nowSeconds);
  if (!needsMetaplex) return observation;
  const meta = await read(await metaplexMetadataAddress(mint as Address));
  const parsed = meta && meta.owner === METAPLEX_METADATA_PROGRAM ? parseMetaplexMetadata(meta.data, mint) : null;
  return parsed ? { ...observation, name: parsed.name, symbol: parsed.symbol } : observation;
}
