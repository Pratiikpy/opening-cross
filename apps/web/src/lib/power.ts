// Who can change what. Everything here is read from the chain by the visitor's own browser: the upgrade authority of
// each program (from the upgradeable loader's ProgramData account) and the admin, guardian and fee recipient (from the
// protocol account of cross_core). Nothing is cached or copied from a document, so it cannot go stale.
import { getAddressDecoder, getProgramDerivedAddress, isOffCurveAddress, type Address, address } from '@solana/kit';

export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADERS: Record<string, string> = {
  NativeLoader1111111111111111111111111111111: 'built into the validator',
  BPFLoader1111111111111111111111111111111111: 'the original BPF loader (not upgradeable)',
  BPFLoader2111111111111111111111111111111111: 'the BPF loader v2 (not upgradeable)',
  LoaderV411111111111111111111111111111111111: 'loader v4',
};

export const CROSS_CORE = 'F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ';

export type OwnProgram = { name: string; id: string; does: string; power: string };

/** The five programs this protocol deploys (Anchor.toml, docs/evidence/L4-verifiable-build.md). */
export const OWN_PROGRAMS: OwnProgram[] = [
  {
    name: 'cross_core',
    id: CROSS_CORE,
    does: 'Holds every order in escrow, finds the clearing price, pays fills and refunds.',
    power: 'Whoever can upgrade it can replace the code that custodies escrow and decides who is paid.',
  },
  {
    name: 'cross_gate',
    id: '2pE7gApapcdmbk6713VbrWNjEg1iFFrd15SLt1pQwWqr',
    does: 'Decides who may enter a gated cross and who may move a gated token (the transfer hook).',
    power: 'Whoever can upgrade it can change who is allowed in, or block transfers of gated tokens.',
  },
  {
    name: 'cross_settle',
    id: '2EVpoks9zhL6VMCE4CryQPyzhSUSxpaGMqaDPKPyJ9WQ',
    does: 'After a cross prints, opens a pool on Meteora or Raydium at the clearing price.',
    power: 'Whoever can upgrade it can change how and where proceeds and base tokens are placed after a print.',
  },
  {
    name: 'cross_calendar',
    id: 'CxtZKYwS4AoqzLhRfjvBTf6NQgDzb2GQhS3u5iB9XLCN',
    does: 'Binds crosses to exchange sessions, behind a timelock.',
    power: 'Whoever can upgrade it can change which sessions a cross is bound to.',
  },
  {
    name: 'treasury',
    id: 'HoRbUkEXdJSFJFp3yZNgEmNJeniWPEheVUejPGZbVGAd',
    does: 'The ownership-coin treasury template.',
    power: 'Whoever can upgrade it can change how a treasury built from it spends and distributes.',
  },
];

export type ExternalProgram = { name: string; id: string; used: string; power: string };

/** Programs written and controlled by others that the product calls or reads. Addresses are the ones in this repository's adapters. */
export const EXTERNAL_PROGRAMS: ExternalProgram[] = [
  {
    name: 'Meteora DAMM v2',
    id: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
    used: 'cross_settle opens a full-range pool here at the clearing price, and can lock or vest the liquidity.',
    power: 'Its upgrade authority can change how a pool trades or how a lock behaves. It cannot change a clearing price already printed in cross_core.',
  },
  {
    name: 'Meteora DLMM',
    id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    used: 'cross_settle opens a bin-based pair near the clearing price and can place a one-sided ladder above it.',
    power: 'Its upgrade authority can change how those bins price trades and who can withdraw from them. It cannot change a printed clearing price.',
  },
  {
    name: 'Meteora DBC',
    id: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
    used: 'cross_settle continues a launch onto a dynamic bonding curve; DBC creates the pool and hands the base mint’s authority to the adapter.',
    power: 'Its upgrade authority can change the curve and migration rules the continued launch runs under. It cannot change a printed clearing price.',
  },
  {
    name: 'Meteora Dynamic Fee Sharing',
    id: 'dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh',
    used: 'Splits trading fees from a pool position between up to five recipients.',
    power: 'Its upgrade authority can change how a vault splits and pays out fees. It does not touch order escrow.',
  },
  {
    name: 'Raydium CPMM (devnet deployment)',
    id: 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb',
    used: 'cross_settle can open a constant-product pool here instead. On mainnet Raydium uses a different program id (ADR-0021).',
    power: 'Its upgrade authority can change how the pool trades. It cannot change a printed clearing price.',
  },
  {
    name: 'Pyth price receiver',
    id: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
    used: 'A cross with an oracle guard reads one pinned Pyth feed and refuses to print when the feed disagrees with the clearing price or is stale.',
    power: 'If the feed or this program is wrong, a guarded cross may refuse to print (everyone is refunded) or print a price the guard should have refused. It cannot move escrow.',
  },
  {
    name: 'Solana Attestation Service',
    id: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
    used: 'cross_gate checks a wallet’s attestation here before letting it into a gated cross.',
    power: 'Its upgrade authority can change how attestations are stored and checked. The credential issuer, not this program, decides who is attested.',
  },
  {
    name: 'Token-2022',
    id: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    used: 'The token program for any mint with extensions, including launched tokens with a transfer hook.',
    power: 'It holds the balances of every Token-2022 mint a cross touches. Changes to it change how those tokens behave in every cross.',
  },
];

export const JUPITER_NOTE =
  'Jupiter is used off chain only: its public quote API prices the premium monitor and the router comparison. No program of ours calls a Jupiter program, so it has no power over any cross, order or escrow.';

// ---------------------------------------------------------------- decoding

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const addr = (b: Uint8Array, at: number): string => getAddressDecoder().decode(b.slice(at, at + 32));

/** UpgradeableLoaderState::Program { programdata_address } : u32 tag 2, then the address. */
export function decodeProgramAccount(data: Uint8Array): string | null {
  if (data.length < 36 || view(data).getUint32(0, true) !== 2) return null;
  return addr(data, 4);
}

/** UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address } : u32 tag 3, u64 slot, Option<Pubkey>. */
export function decodeProgramData(data: Uint8Array): { slot: bigint; authority: string | null } | null {
  if (data.length < 13 || view(data).getUint32(0, true) !== 3) return null;
  const slot = view(data).getBigUint64(4, true);
  const some = data[12];
  if (some === 0) return { slot, authority: null };
  if (some !== 1 || data.length < 45) return null;
  return { slot, authority: addr(data, 13) };
}

export type Protocol = { admin: string; guardian: string; feeRecipient: string; feeBps: number[]; paused: boolean; pendingAdmin: string | null };

/** The cross_core `Protocol` account: 8-byte discriminator, admin, guardian, fee recipient, four u16 fees, paused, bump, Option<pending admin>. */
export function decodeProtocol(data: Uint8Array): Protocol | null {
  if (data.length < 8 + 96 + 8 + 2 + 1) return null;
  const v = view(data);
  const base = 8;
  const feeAt = base + 96;
  const pendingTag = data[feeAt + 8 + 2];
  if (pendingTag === undefined || pendingTag > 1) return null;
  if (pendingTag === 1 && data.length < feeAt + 11 + 32) return null;
  return {
    admin: addr(data, base),
    guardian: addr(data, base + 32),
    feeRecipient: addr(data, base + 64),
    feeBps: [0, 1, 2, 3].map((i) => v.getUint16(feeAt + i * 2, true)),
    paused: data[feeAt + 8] === 1,
    pendingAdmin: pendingTag === 1 ? addr(data, feeAt + 11) : null,
  };
}

export type AuthorityKind = 'none' | 'key' | 'program';

/** A key that a private key controls sits on the ed25519 curve; an address off the curve can only be controlled by a program. */
export function authorityKind(authority: string | null): AuthorityKind {
  if (authority === null) return 'none';
  return isOffCurveAddress(address(authority)) ? 'program' : 'key';
}

export function loaderName(owner: string): string {
  return LOADERS[owner] ?? owner;
}

// ---------------------------------------------------------------- reading

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

type RpcRequest = { method: string; params: unknown[] };

/** One JSON-RPC call with retries: public endpoints answer 429 under load, so wait (honouring Retry-After) and try again. */
async function rpcOne(url: string, req: RpcRequest, fetcher: Fetcher, sleep: Sleep, attempts: number): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: req.method, params: req.params });
  let lastError = 'no response';
  for (let n = 0; n < attempts; n++) {
    try {
      const res = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (res.status === 429 || res.status >= 500) {
        lastError = `RPC answered HTTP ${res.status}`;
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : Math.min(500 * 2 ** n, 8000));
        continue;
      }
      if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
      const json = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
      if (json.error?.code === 429 || /rate|too many/i.test(json.error?.message ?? '')) {
        lastError = 'RPC rate limited the request';
        await sleep(Math.min(500 * 2 ** n, 8000));
        continue;
      }
      if (json.error) throw new Error(json.error.message ?? 'RPC error');
      return json.result;
    } catch (e) {
      if (e instanceof TypeError) {
        lastError = 'RPC unreachable';
        await sleep(Math.min(500 * 2 ** n, 8000));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${lastError} after ${attempts} attempts`);
}

/**
 * Runs the requests a few at a time and returns their results in order. Public RPC endpoints refuse JSON-RPC batches
 * (the devnet one answers 429 to any batch of two or more), so each call is sent on its own.
 */
export async function rpcBatch(url: string, requests: RpcRequest[], opts: { fetcher?: Fetcher; sleep?: Sleep; attempts?: number; concurrency?: number } = {}): Promise<unknown[]> {
  const fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: unknown[] = new Array(requests.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < requests.length; i = next++) out[i] = await rpcOne(url, requests[i]!, fetcher, sleep, opts.attempts ?? 6);
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 3, requests.length) }, worker));
  return out;
}

type Account = { owner: string; executable: boolean; data: [string, string] } | null;

/** One getMultipleAccounts call: public endpoints throttle per call, and refuse JSON-RPC batches, so many accounts go in one request. */
async function accounts(url: string, keys: string[], length: number, opts: Parameters<typeof rpcBatch>[2]): Promise<Account[]> {
  if (keys.length === 0) return [];
  const [r] = await rpcBatch(url, [{ method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length } }] }], opts);
  const value = (r as { value?: Account[] } | undefined)?.value;
  if (!value || value.length !== keys.length) throw new Error('the RPC returned an unexpected answer for getMultipleAccounts');
  return value;
}

export type ProgramState =
  | { id: string; found: false }
  | { id: string; found: true; loader: string; upgradeable: false }
  | { id: string; found: true; loader: string; upgradeable: true; authority: string | null; kind: AuthorityKind; lastDeployedSlot: bigint };

/** Turns program accounts into upgrade authorities with one more call, for their ProgramData accounts. */
async function resolvePrograms(url: string, ids: string[], accts: Account[], opts: Parameters<typeof rpcBatch>[2]): Promise<ProgramState[]> {
  const dataAddrs = accts.map((a) => (a && a.owner === UPGRADEABLE_LOADER ? decodeProgramAccount(b64(a.data[0])) : null));
  const wanted = dataAddrs.map((d, i) => [d, i] as const).filter((x): x is readonly [string, number] => x[0] !== null);
  const second = await accounts(url, wanted.map(([d]) => d), 45, opts);
  const byIndex = new Map(wanted.map(([, i], k) => [i, second[k] ?? null] as const));
  return ids.map((id, i): ProgramState => {
    const a = accts[i];
    if (!a || !a.executable) return { id, found: false };
    if (a.owner !== UPGRADEABLE_LOADER) return { id, found: true, loader: loaderName(a.owner), upgradeable: false };
    const pd = byIndex.get(i);
    const state = pd ? decodeProgramData(b64(pd.data[0])) : null;
    if (!state) throw new Error(`could not read the ProgramData account of ${id}`);
    return { id, found: true, loader: 'the upgradeable loader', upgradeable: true, authority: state.authority, kind: authorityKind(state.authority), lastDeployedSlot: state.slot };
  });
}

/** Reads who may upgrade each program: the program accounts in one call, their ProgramData accounts in a second. */
export async function readPrograms(url: string, ids: string[], opts: Parameters<typeof rpcBatch>[2] = {}): Promise<ProgramState[]> {
  return resolvePrograms(url, ids, await accounts(url, ids, 36, opts), opts);
}

export async function protocolAddress(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: address(CROSS_CORE), seeds: [new TextEncoder().encode('protocol')] }))[0];
}

/** Everything the page shows in two RPC calls, to stay inside public rate limits: all program accounts and the protocol account, then all ProgramData accounts. */
export async function readPower(url: string, ids: string[], opts: Parameters<typeof rpcBatch>[2] = {}): Promise<{ programs: ProgramState[]; protocol: { address: string; protocol: Protocol } | null }> {
  const pda = await protocolAddress();
  const first = await accounts(url, [...ids, pda], 150, opts);
  const programs = await resolvePrograms(url, ids, first.slice(0, ids.length), opts);
  const a = first[ids.length];
  if (!a) return { programs, protocol: null };
  const protocol = decodeProtocol(b64(a.data[0]));
  if (!protocol) throw new Error('the protocol account has an unexpected layout');
  return { programs, protocol: { address: pda, protocol } };
}
