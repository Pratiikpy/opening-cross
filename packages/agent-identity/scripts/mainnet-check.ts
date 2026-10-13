// Checks the seed layouts and the verifier against the real registry, read-only: the directory of every registered agent on mainnet,
// then a sample of agents verified one by one, their Asset Signer wallets looked up on chain, and some things that are not agents.
//   pnpm exec tsx scripts/mainnet-check.ts [endpoint]
import { agentIdentityPda, assetSignerPda, loadDirectory, readIdentity, verifyAgent, AGENT_REGISTRY_PROGRAM, type RpcLike } from '../src/index.js';
import { address } from '@solana/kit';

const url = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
const rpc: RpcLike = {
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    for (let i = 0; i < 8; i++) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = (await res.json()) as { result?: T; error?: { message: string } };
      if (res.status === 200 && !j.error) return j.result as T;
      if (!/429|Too many|rate/i.test(`${res.status} ${j.error?.message}`)) throw new Error(`${method}: ${j.error?.message ?? res.status}`);
      await new Promise((r) => setTimeout(r, 1_500 * (i + 1)));
    }
    throw new Error(`${method}: rate limited`);
  },
};

const dir = await loadDirectory(rpc);
console.log(JSON.stringify({ step: 'directory', registry: AGENT_REGISTRY_PROGRAM, identityAccounts: dir.count, distinctWallets: dir.wallets.size }));
const sample = [...dir.wallets.entries()].slice(0, 8);
let funded = 0;
for (const [wallet, asset] of sample) {
  const v = await verifyAgent(rpc, asset);
  const info = await rpc.call<{ value: { lamports: number; owner: string } | null }>('getAccountInfo', [wallet, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  if (info.value) funded += 1;
  console.log(JSON.stringify({ asset, registered: v.registered, wallet: v.wallet === wallet, walletOnChain: info.value ? { lamports: info.value.lamports, owner: info.value.owner } : null, name: v.name?.slice(0, 40), coreOwner: v.owner, checks: v.checks }));
}
console.log(JSON.stringify({ step: 'sample', size: sample.length, walletsWithAnAccountOnChain: funded }));

// The seeds, from a different direction: the identity PDA derived from an asset must be the very account the registry returned for it.
const first = await rpc.call<{ pubkey: string; account: { data: [string, string] } }[]>('getProgramAccounts', [AGENT_REGISTRY_PROGRAM, { encoding: 'base64', dataSlice: { offset: 0, length: 40 }, filters: [{ dataSize: 40 }] }]);
let agree = 0;
for (const a of first.slice(0, 50)) {
  const id = readIdentity(Uint8Array.from(Buffer.from(a.account.data[0], 'base64')));
  if (id && (await agentIdentityPda(id.asset)) === a.pubkey) agree += 1;
}
console.log(JSON.stringify({ step: 'identity PDA derived from the asset equals the account the registry holds', checked: Math.min(50, first.length), agree }));

// Things that are not agents.
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const notAgents = [usdc, 'DTB3Jtxb6dy7GvocUbypiJb548ZLGRzVdPrNNCWAKEdC', (await assetSignerPda(address(usdc)))];
for (const a of notAgents) {
  const v = await verifyAgent(rpc, a);
  console.log(JSON.stringify({ notAnAgent: a, registered: v.registered, reasons: v.reasons }));
}
