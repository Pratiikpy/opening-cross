// Verifiable agent identity (PRODUCT_FEATURES J5), read from the Metaplex Agent Registry.
//
// What the registry is: a program (1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p, the same address on mainnet and devnet) that gives an MPL
// Core asset an identity record, a 40-byte PDA at ["agent_identity", asset]. The asset's wallet is its Asset Signer, the PDA at
// ["mpl-core-execute", asset] under MPL Core (CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d): no private key exists for it, and it acts only
// through Core's Execute by a delegated executive. Both seed layouts were read from Metaplex's own documentation and from the
// published @metaplex-foundation/mpl-core 1.10.0 source, and are checked against real mainnet agents in the tests' companion script.
//
// What this proves: that a wallet is the wallet of an asset registered as an agent. What it does not prove: that the agent behind it is
// honest, who runs it, or that the registration document at its URI is true. That document is third-party text and is returned as data.
import { type Address, address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

export const AGENT_REGISTRY_PROGRAM = address('1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p');
export const MPL_CORE_PROGRAM = address('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const IDENTITY_SIZE = 40;

export interface RpcLike {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

const enc = new TextEncoder();
export async function agentIdentityPda(asset: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: AGENT_REGISTRY_PROGRAM, seeds: [enc.encode('agent_identity'), getAddressEncoder().encode(asset)] }))[0];
}
/** The wallet of an agent asset: its Asset Signer PDA. */
export async function assetSignerPda(asset: Address): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: MPL_CORE_PROGRAM, seeds: [enc.encode('mpl-core-execute'), getAddressEncoder().encode(asset)] }))[0];
}

interface RawAccount {
  data: [string, string];
  owner: string;
  lamports: number;
}
const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'));

/** A 40-byte AgentIdentityV1 account: key (1), bump (1), padding (6), asset (32). Returns the asset it names, or null if the bytes are not one. */
export function readIdentity(data: Uint8Array): { bump: number; asset: Address } | null {
  if (data.length !== IDENTITY_SIZE) return null;
  const { decode } = getAddressDecoder();
  return { bump: data[1]!, asset: decode(data.slice(8, 40)) };
}
function getAddressDecoder() {
  // Local, so the module has one import surface; base58 of 32 bytes via kit's address encoder inverse.
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return {
    decode(bytes: Uint8Array): Address {
      let n = 0n;
      for (const b of bytes) n = (n << 8n) | BigInt(b);
      let out = '';
      while (n > 0n) {
        out = ALPHABET[Number(n % 58n)]! + out;
        n /= 58n;
      }
      for (const b of bytes) {
        if (b !== 0) break;
        out = '1' + out;
      }
      return out as Address;
    },
  };
}

/** The leading fields of a Core BaseAssetV1: key (1), owner (32), update authority (tag + optional 32), name, uri. Null if the bytes are not an asset. */
export function readCoreAsset(data: Uint8Array): { owner: Address; name: string; uri: string } | null {
  if (data.length < 40 || data[0] !== 1) return null; // Key::AssetV1
  const owner = getAddressDecoder().decode(data.slice(1, 33));
  let at = 33;
  const tag = data[at++]!;
  if (tag === 1 || tag === 2) at += 32; // Address(...) or Collection(...)
  else if (tag !== 0) return null;
  const str = (): string | null => {
    if (at + 4 > data.length) return null;
    const len = new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, true);
    at += 4;
    if (len > 4096 || at + len > data.length) return null;
    const s = new TextDecoder().decode(data.slice(at, at + len));
    at += len;
    return s;
  };
  const name = str();
  const uri = str();
  return name === null || uri === null ? null : { owner, name, uri };
}

export interface AgentVerdict {
  asset: string;
  registered: boolean;
  /** The agent's own wallet: what it trades from. */
  wallet: string;
  identityAccount: string;
  checks: { identityExists: boolean; identityOwnedByRegistry: boolean; identityNamesThisAsset: boolean; assetIsCoreAsset: boolean };
  /** From the Core asset. These are the asset's own fields; the URI points at third-party text. */
  owner: string | null;
  name: string | null;
  uri: string | null;
  reasons: string[];
}

export async function verifyAgent(rpc: RpcLike, asset: string): Promise<AgentVerdict> {
  const a = address(asset);
  const [identityAccount, wallet] = await Promise.all([agentIdentityPda(a), assetSignerPda(a)]);
  const r = await rpc.call<{ value: (RawAccount | null)[] }>('getMultipleAccounts', [[identityAccount, a], { encoding: 'base64', commitment: 'confirmed' }]);
  const [idAcc, assetAcc] = r.value;
  const id = idAcc ? readIdentity(b64(idAcc.data[0])) : null;
  const core = assetAcc && assetAcc.owner === MPL_CORE_PROGRAM ? readCoreAsset(b64(assetAcc.data[0])) : null;
  const checks = { identityExists: Boolean(idAcc), identityOwnedByRegistry: idAcc?.owner === AGENT_REGISTRY_PROGRAM, identityNamesThisAsset: id?.asset === a, assetIsCoreAsset: core !== null };
  const reasons: string[] = [];
  if (!checks.identityExists) reasons.push('No identity record exists for this asset in the Agent Registry.');
  else if (!checks.identityOwnedByRegistry) reasons.push('The account at the identity address is not owned by the Agent Registry program.');
  else if (!checks.identityNamesThisAsset) reasons.push('The identity record does not name this asset.');
  if (!checks.assetIsCoreAsset) reasons.push('The asset account is not an MPL Core asset.');
  return { asset, registered: Object.values(checks).every(Boolean), wallet, identityAccount, checks, owner: core?.owner ?? null, name: core?.name ?? null, uri: core?.uri ?? null, reasons };
}

// -------------------------------------------------------------------------------------------------------- directory

export interface Directory {
  /** wallet (asset signer) -> asset. */
  wallets: ReadonlyMap<string, string>;
  loadedAt: number;
  count: number;
}

/** Every registered agent: all 40-byte identity accounts of the registry, each turned into the wallet it trades from. */
export async function loadDirectory(rpc: RpcLike, now = Math.floor(Date.now() / 1000), limit = 50_000): Promise<Directory> {
  const accts = await rpc.call<{ pubkey: string; account: RawAccount }[]>('getProgramAccounts', [AGENT_REGISTRY_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: IDENTITY_SIZE }] }]);
  const wallets = new Map<string, string>();
  for (const a of accts.slice(0, limit)) {
    const id = readIdentity(b64(a.account.data[0]));
    if (!id) continue;
    wallets.set(await assetSignerPda(id.asset), id.asset);
  }
  return { wallets, loadedAt: now, count: accts.length };
}

/** A directory that is loaded on first use and reloaded when older than `ttlSecs`; concurrent callers share one load. */
export function cachedDirectory(rpc: RpcLike, ttlSecs = 600, clock: () => number = () => Math.floor(Date.now() / 1000)): () => Promise<Directory> {
  let cur: Directory | null = null;
  let loading: Promise<Directory> | null = null;
  return async () => {
    if (cur && clock() - cur.loadedAt < ttlSecs) return cur;
    loading ??= loadDirectory(rpc, clock()).then(
      (d) => {
        cur = d;
        loading = null;
        return d;
      },
      (e) => {
        loading = null;
        if (cur) return cur; // an old directory is better than none; the caller sees loadedAt
        throw e;
      },
    );
    return loading;
  };
}

// ----------------------------------------------------------------------------------------------------------- policy

export type AgentPolicy = { mode: 'allow' } | { mode: 'deny' } | { mode: 'limit'; maxShareBps: number };

export interface BidderOrder {
  owner: string;
  /** Base atoms the order counts for, or null while unknown (a sealed order not yet revealed). */
  weight: bigint | null;
}

export interface PolicyReport {
  policy: AgentPolicy;
  compliant: boolean | null;
  agentWallets: { wallet: string; asset: string; orders: number }[];
  agentOrders: number;
  orders: number;
  /** Share of known volume placed by registered agents, in basis points. */
  agentShareBps: number;
  unweightedOrders: number;
  violations: string[];
  limits: string[];
}

export function checkAgentPolicy(policy: AgentPolicy, orders: readonly BidderOrder[], directory: Directory): PolicyReport {
  if (policy.mode === 'limit' && (!Number.isInteger(policy.maxShareBps) || policy.maxShareBps < 0 || policy.maxShareBps > 10_000)) throw new RangeError('maxShareBps must be a whole number from 0 to 10000');
  const per = new Map<string, { asset: string; orders: number }>();
  let agentWeight = 0n;
  let total = 0n;
  let unweighted = 0;
  let agentOrders = 0;
  for (const o of orders) {
    const asset = directory.wallets.get(o.owner);
    if (o.weight === null) unweighted += 1;
    else total += o.weight;
    if (!asset) continue;
    agentOrders += 1;
    if (o.weight !== null) agentWeight += o.weight;
    const cur = per.get(o.owner) ?? { asset, orders: 0 };
    cur.orders += 1;
    per.set(o.owner, cur);
  }
  const share = total === 0n ? 0 : Number((agentWeight * 10_000n) / total);
  const violations: string[] = [];
  if (policy.mode === 'deny' && agentOrders > 0) violations.push(`${agentOrders} order(s) were placed by registered agents, and the issuer does not allow agents`);
  if (policy.mode === 'limit' && share > policy.maxShareBps) violations.push(`registered agents placed ${share / 100}% of known volume; the issuer's limit is ${policy.maxShareBps / 100}%`);
  const unknown = policy.mode === 'limit' && unweighted > 0 ? 'unknown' : null;
  return {
    policy,
    compliant: unknown ? (violations.length ? false : null) : violations.length === 0,
    agentWallets: [...per].map(([wallet, v]) => ({ wallet, ...v })),
    agentOrders,
    orders: orders.length,
    agentShareBps: share,
    unweightedOrders: unweighted,
    violations,
    limits: [
      'Only wallets that are the Asset Signer of a registered agent are recognised. An agent that trades from an ordinary wallet is not seen.',
      'A policy is checked after the fact by this module. Refusing an order at placement needs a gate pass issued by an attester that applies the same check.',
      ...(unknown ? [`${unweighted} order(s) have no known volume yet, so a share limit cannot be confirmed as met.`] : []),
    ],
  };
}
