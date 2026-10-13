import { describe, expect, it } from 'vitest';
import { type Address, address, getAddressEncoder } from '@solana/kit';
import { AGENT_REGISTRY_PROGRAM, IDENTITY_SIZE, MPL_CORE_PROGRAM, type Directory, type RpcLike, agentIdentityPda, assetSignerPda, cachedDirectory, checkAgentPolicy, loadDirectory, readCoreAsset, readIdentity, verifyAgent } from '../src/index.js';

// Pairs read from mainnet on 2026-10-13: an agent asset, the identity account the registry holds for it, and its Asset Signer wallet,
// which is a real system account holding SOL. If either seed layout were wrong these could not match.
const REAL = [
  { asset: '551trrW7wqEUZxTFULcs4SbedekpFgPEGMmzfzextGUi', identity: '4WwvhxqbNNwrULyuCPhYZeUD4knWdrG9AsMaR5HcdDrk', wallet: '9SyvAbtwFZa6VaPnNbztZcWw4P7Ls2YnqwzDn8PGVSvr' },
  { asset: '996GgW71kZQwMdhCXrkYktADfzUrsYG8JZahe1cShYM5', identity: '8uuXBZCy3oyeJTRPC6mthWAGjBg36Ha2nHtXxDDTJFde', wallet: 'WDkfm32C5iMMq1pb3PC7CCD3G7y6zSn3Ehwk1pFjLgb' },
];

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const identityBytes = (asset: string, bump = 254) => {
  const d = new Uint8Array(IDENTITY_SIZE);
  d[0] = 2;
  d[1] = bump;
  d.set(getAddressEncoder().encode(address(asset)), 8);
  return d;
};
function coreBytes(owner: string, name: string, uri: string, authorityTag = 1): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [1, ...getAddressEncoder().encode(address(owner)), authorityTag];
  if (authorityTag === 1 || authorityTag === 2) parts.push(...getAddressEncoder().encode(address(owner)));
  const len = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  parts.push(...len(enc.encode(name).length), ...enc.encode(name), ...len(enc.encode(uri).length), ...enc.encode(uri));
  return Uint8Array.from(parts);
}

describe('addresses', () => {
  it('derive the identity account and the wallet the way the registry and MPL Core do, against real agents', async () => {
    for (const r of REAL) {
      expect(await agentIdentityPda(address(r.asset))).toBe(r.identity);
      expect(await assetSignerPda(address(r.asset))).toBe(r.wallet);
    }
    expect(AGENT_REGISTRY_PROGRAM).toBe('1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p');
    expect(MPL_CORE_PROGRAM).toBe('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
  });
});

describe('account layouts', () => {
  it('reads an identity account and refuses anything that is not 40 bytes', () => {
    expect(readIdentity(identityBytes(REAL[0]!.asset, 251))).toEqual({ bump: 251, asset: REAL[0]!.asset });
    expect(readIdentity(new Uint8Array(39))).toBeNull();
    expect(readIdentity(new Uint8Array(41))).toBeNull();
  });
  it('reads a Core asset\'s owner, name and uri, and refuses what is not an asset', () => {
    const owner = REAL[1]!.asset;
    expect(readCoreAsset(coreBytes(owner, 'Deside Test Agent', 'https://example.invalid/a.json'))).toEqual({ owner, name: 'Deside Test Agent', uri: 'https://example.invalid/a.json' });
    expect(readCoreAsset(coreBytes(owner, 'x', 'y', 0))).toMatchObject({ name: 'x', uri: 'y' }); // no update-authority address
    expect(readCoreAsset(coreBytes(owner, 'x', 'y', 7))).toBeNull(); // an unknown authority tag
    const notAsset = coreBytes(owner, 'x', 'y');
    notAsset[0] = 5;
    expect(readCoreAsset(notAsset)).toBeNull();
    expect(readCoreAsset(new Uint8Array(10))).toBeNull();
    const truncated = coreBytes(owner, 'a long name', 'uri').slice(0, 50);
    expect(readCoreAsset(truncated)).toBeNull();
  });
});

/** A registry with the given registered assets, and everything else absent. */
function chain(registered: string[], extra: { coreOwner?: string; notCore?: string[]; wrongIdentityOwner?: string[]; wrongAsset?: string[] } = {}): RpcLike {
  return {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      if (method === 'getMultipleAccounts') {
        const [idAddr, assetAddr] = params[0] as string[];
        const asset = registered.find((a) => a === assetAddr);
        const idAcc = asset
          ? {
              owner: extra.wrongIdentityOwner?.includes(asset) ? '11111111111111111111111111111111' : AGENT_REGISTRY_PROGRAM,
              lamports: 1,
              data: [b64(identityBytes(extra.wrongAsset?.includes(asset) ? REAL[1]!.asset : asset)), 'base64'] as [string, string],
            }
          : null;
        const assetAcc = asset ? { owner: extra.notCore?.includes(asset) ? '11111111111111111111111111111111' : MPL_CORE_PROGRAM, lamports: 1, data: [b64(coreBytes(extra.coreOwner ?? REAL[0]!.asset, `Agent ${asset.slice(0, 4)}`, 'https://example.invalid/agent.json')), 'base64'] as [string, string] } : null;
        void idAddr;
        return { value: [idAcc, assetAcc] } as T;
      }
      if (method === 'getProgramAccounts') return registered.map((a) => ({ pubkey: 'x', account: { owner: AGENT_REGISTRY_PROGRAM, lamports: 1, data: [b64(identityBytes(a)), 'base64'] } })) as T;
      throw new Error(method);
    },
  };
}

describe('verifyAgent', () => {
  it('accepts a registered agent and says where its wallet is', async () => {
    const v = await verifyAgent(chain([REAL[0]!.asset]), REAL[0]!.asset);
    expect(v).toMatchObject({ registered: true, wallet: REAL[0]!.wallet, identityAccount: REAL[0]!.identity, reasons: [] });
    expect(v.name).toMatch(/^Agent /);
    expect(v.uri).toBe('https://example.invalid/agent.json');
  });
  it('refuses an asset with no identity, a forged identity, and an asset that is not a Core asset, and says which', async () => {
    const none = await verifyAgent(chain([]), REAL[0]!.asset);
    expect(none.registered).toBe(false);
    expect(none.reasons.join(' ')).toMatch(/No identity record/);
    const foreignOwner = await verifyAgent(chain([REAL[0]!.asset], { wrongIdentityOwner: [REAL[0]!.asset] }), REAL[0]!.asset);
    expect(foreignOwner.registered).toBe(false);
    expect(foreignOwner.reasons.join(' ')).toMatch(/not owned by the Agent Registry/);
    const namesOther = await verifyAgent(chain([REAL[0]!.asset], { wrongAsset: [REAL[0]!.asset] }), REAL[0]!.asset);
    expect(namesOther.registered).toBe(false);
    expect(namesOther.reasons.join(' ')).toMatch(/does not name this asset/);
    const plain = await verifyAgent(chain([REAL[0]!.asset], { notCore: [REAL[0]!.asset] }), REAL[0]!.asset);
    expect(plain.registered).toBe(false);
    expect(plain.reasons.join(' ')).toMatch(/not an MPL Core asset/);
    await expect(verifyAgent(chain([]), 'not-an-address')).rejects.toThrow();
  });
});

describe('the directory', () => {
  it('maps every registered agent to the wallet it trades from', async () => {
    const d = await loadDirectory(chain(REAL.map((r) => r.asset)));
    expect(d.count).toBe(2);
    expect(d.wallets.get(REAL[0]!.wallet)).toBe(REAL[0]!.asset);
    expect(d.wallets.get(REAL[1]!.wallet)).toBe(REAL[1]!.asset);
    expect(d.wallets.has(REAL[0]!.asset)).toBe(false); // the asset itself is not a wallet
  });
  it('is loaded once, shared by concurrent callers, reloaded after its lifetime, and survives a failed reload', async () => {
    let loads = 0;
    let fail = false;
    let now = 1000;
    const rpc: RpcLike = {
      async call<T>(method: string, p?: unknown[]) {
        if (method === 'getProgramAccounts') {
          loads += 1;
          if (fail) throw new Error('rpc down');
        }
        return chain([REAL[0]!.asset]).call<T>(method, p);
      },
    };
    const get = cachedDirectory(rpc, 100, () => now);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    now += 50;
    await get();
    expect(loads).toBe(1);
    now += 100;
    fail = true;
    const stale = await get();
    expect(loads).toBe(2);
    expect(stale.loadedAt).toBe(1000); // the old directory, not an error
    const cold = cachedDirectory({ call: async () => Promise.reject(new Error('rpc down')) }, 100, () => now);
    await expect(cold()).rejects.toThrow(/rpc down/);
  });
});

describe('policy on agent bidders', () => {
  const dir: Directory = { wallets: new Map([[REAL[0]!.wallet, REAL[0]!.asset]]), loadedAt: 1, count: 1 };
  const o = (owner: string, weight: bigint | null) => ({ owner, weight });
  const orders = [o(REAL[0]!.wallet, 300n), o(REAL[0]!.wallet, 100n), o('human1', 400n), o('human2', 200n)];
  it('allow only reports who the agents are', () => {
    const r = checkAgentPolicy({ mode: 'allow' }, orders, dir);
    expect(r).toMatchObject({ compliant: true, agentOrders: 2, orders: 4, agentShareBps: 4000 });
    expect(r.agentWallets).toEqual([{ wallet: REAL[0]!.wallet, asset: REAL[0]!.asset, orders: 2 }]);
  });
  it('deny is violated by any agent order, and satisfied without one', () => {
    expect(checkAgentPolicy({ mode: 'deny' }, orders, dir)).toMatchObject({ compliant: false });
    expect(checkAgentPolicy({ mode: 'deny' }, orders, dir).violations[0]).toMatch(/does not allow agents/);
    expect(checkAgentPolicy({ mode: 'deny' }, [o('human1', 1n)], dir).compliant).toBe(true);
  });
  it('limit compares the agents\' share of known volume with the cap, to the basis point', () => {
    expect(checkAgentPolicy({ mode: 'limit', maxShareBps: 4000 }, orders, dir).compliant).toBe(true); // exactly at the cap
    const over = checkAgentPolicy({ mode: 'limit', maxShareBps: 3999 }, orders, dir);
    expect(over.compliant).toBe(false);
    expect(over.violations[0]).toMatch(/40% of known volume; the issuer's limit is 39.99%/);
    expect(() => checkAgentPolicy({ mode: 'limit', maxShareBps: 10_001 }, orders, dir)).toThrow(RangeError);
  });
  it('does not say a share limit is met while some volume is still unknown', () => {
    const sealed = [...orders, o('human3', null)];
    const r = checkAgentPolicy({ mode: 'limit', maxShareBps: 5000 }, sealed, dir);
    expect(r.compliant).toBeNull();
    expect(r.unweightedOrders).toBe(1);
    expect(r.limits.join(' ')).toMatch(/no known volume yet/);
    expect(checkAgentPolicy({ mode: 'limit', maxShareBps: 1000 }, sealed, dir).compliant).toBe(false); // a violation already is one
  });
  it('states what it cannot see', () => {
    expect(checkAgentPolicy({ mode: 'allow' }, [], dir).limits.join(' ')).toMatch(/ordinary wallet is not seen/);
    expect(checkAgentPolicy({ mode: 'allow' }, [], dir).agentShareBps).toBe(0);
  });
});
