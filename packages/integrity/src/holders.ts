import { type Declared, labelOwner } from './labels.js';
import type { Holder, RpcLike } from './types.js';

interface ParsedTokenAccount {
  owner: string;
  owner_program?: string;
  lamports: number;
  data: { parsed?: { type?: string; info?: { owner?: string; mint?: string; tokenAmount?: { amount: string } } } };
}

export interface HolderReport {
  mint: string;
  supply: bigint;
  decimals: number;
  /** The largest token accounts the RPC returns (at most 20), largest first. */
  holders: Holder[];
  /** Share of supply the listed holders hold, in basis points. A figure below 10000 means the rest is spread over smaller accounts. */
  coveredBps: number;
  byKind: Record<string, { holders: number; shareBps: number }>;
  /** What was not done, so a reader does not take the list for the whole register. */
  limits: string[];
}

/** Reads the largest holders of a mint and labels each one. */
export async function readHolders(rpc: RpcLike, mint: string, declared: Declared = {}): Promise<HolderReport> {
  const [supplyRes, largest] = await Promise.all([
    rpc.call<{ value: { amount: string; decimals: number } }>('getTokenSupply', [mint, { commitment: 'confirmed' }]),
    rpc.call<{ value: { address: string; amount: string }[] }>('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]),
  ]);
  const supply = BigInt(supplyRes.value.amount);
  const accounts = largest.value.filter((a) => BigInt(a.amount) > 0n);
  const infos = accounts.length
    ? await rpc.call<{ value: (ParsedTokenAccount | null)[] }>('getMultipleAccounts', [accounts.map((a) => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }])
    : { value: [] };
  const owners = infos.value.map((i) => i?.data.parsed?.info?.owner ?? null);
  const uniqueOwners = [...new Set(owners.filter((o): o is string => !!o))];
  const ownerInfos = uniqueOwners.length ? await rpc.call<{ value: ({ owner: string; executable: boolean } | null)[] }>('getMultipleAccounts', [uniqueOwners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]) : { value: [] };
  const ownerAccount = new Map(uniqueOwners.map((o, i) => [o, ownerInfos.value[i] ?? null]));

  const holders: Holder[] = [];
  accounts.forEach((a, i) => {
    const owner = owners[i];
    if (!owner) return; // not a parsed token account (closed between the two calls)
    const amount = BigInt(a.amount);
    const info = ownerAccount.get(owner);
    holders.push({
      tokenAccount: a.address,
      owner,
      amount,
      shareBps: supply === 0n ? 0 : Number((amount * 10_000n) / supply),
      label: labelOwner({ address: owner, accountOwner: info?.owner ?? null, ...(info ? { executable: info.executable } : {}) }, declared),
    });
  });

  // One wallet may hold through several token accounts; the report keeps the accounts but totals by kind on amounts.
  const byKind: HolderReport['byKind'] = {};
  const totals = new Map<string, bigint>();
  for (const h of holders) {
    totals.set(h.label.kind, (totals.get(h.label.kind) ?? 0n) + h.amount);
    byKind[h.label.kind] = { holders: (byKind[h.label.kind]?.holders ?? 0) + 1, shareBps: 0 };
  }
  for (const [k, v] of totals) byKind[k]!.shareBps = supply === 0n ? 0 : Number((v * 10_000n) / supply);
  const covered = holders.reduce((s, h) => s + h.amount, 0n);
  return {
    mint,
    supply,
    decimals: supplyRes.value.decimals,
    holders,
    coveredBps: supply === 0n ? 0 : Number((covered * 10_000n) / supply),
    byKind,
    limits: [
      'Only the largest token accounts the RPC returns (up to 20) are listed; a long tail of small holders is not.',
      'A label is only as good as the declared facts and the program tables behind it; an unlabeled address is a wallet, not a proven individual.',
    ],
  };
}
