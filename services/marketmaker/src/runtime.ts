// The bot's connections to the real world: the Opening Cross API, a Solana RPC, a keypair file, a state file and a log.
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createApiClient, createRpcClient, dryRun, signSendConfirm } from '@opening-cross/client';
import { loadKeypairSigner } from '@opening-cross/client/node';
import type { UnsignedTransaction } from '@opening-cross/client';
import type { BotApi, BotChain, BotState, StateStore } from './bot.js';
import { emptyState } from './bot.js';
import type { MmConfig } from './config.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function makeApi(baseUrl: string): BotApi {
  const api = createApiClient({ baseUrl });
  return {
    listCrosses: (o) => api.listCrosses(o),
    getCross: (a) => api.getCross(a),
    getBook: (a) => api.getBook(a),
    ownerOrders: (o) => api.ownerOrders(o),
    orders: (a) => api.orders(a),
    placeOrder: (b) => api.tx.placeOrder({ cross: b.cross, owner: b.owner, side: b.side, price: b.price.toString(), quantity: b.quantity.toString(), nonce: b.nonce.toString(), ...(b.salt ? { salt: hex(b.salt) } : {}) }),
    reveal: (b) => api.tx.reveal({ cross: b.cross, owner: b.owner, nonce: b.nonce.toString(), price: b.price.toString(), quantity: b.quantity.toString(), salt: hex(b.salt) }),
    claim: (b) => api.tx.claim({ cross: b.cross, owner: b.owner, nonce: b.nonce.toString() }),
  };
}

export async function makeChain(cfg: Pick<MmConfig, 'rpcUrl' | 'keypairPath' | 'dryRun'>, log: (e: Record<string, unknown>) => void) {
  const rpc = createRpcClient({ url: cfg.rpcUrl });
  const signer = await loadKeypairSigner(cfg.keypairPath);
  const chain: BotChain = {
    unixTime: () => rpc.unixTime(),
    async balance(owner, mint) {
      const r = await rpc.call<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      return r.value.reduce((a, v) => a + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
    },
    async send(txs: readonly UnsignedTransaction[], label: string) {
      if (cfg.dryRun) {
        const results = await dryRun(txs, rpc);
        log({ event: 'simulated', label, results: results.map((r) => ({ ok: r.simulation.err === null, err: r.simulation.err, units: r.simulation.unitsConsumed, note: r.note })) });
        return [];
      }
      return signSendConfirm(txs, { rpc, sign: signer.sign });
    },
  };
  return { chain, owner: signer.address as string, rpc };
}

export function fileStore(path: string): StateStore {
  return {
    load(): BotState {
      if (!existsSync(path)) return emptyState();
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as BotState;
      if (parsed.version !== 1 || typeof parsed.crosses !== 'object') throw new Error(`${path} is not a market-maker state file (version 1)`);
      return parsed;
    },
    save(s: BotState) {
      // Written beside the target and renamed over it, so a crash never leaves half a file.
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2));
      renameSync(tmp, path);
    },
  };
}

export function readSealSecret(path: string | null): Uint8Array | null {
  if (!path) return null;
  const text = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64,}$/.test(text) || text.length % 2 !== 0) throw new Error(`${path} must hold at least 32 bytes as hex`);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not every file system supports modes (Windows); the file is still read.
  }
  return Uint8Array.from(Buffer.from(text, 'hex'));
}

export function makeLog(path: string | null): (e: Record<string, unknown>) => void {
  return (e) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...e });
    console.log(line);
    if (path) appendFileSync(path, line + '\n');
  };
}
