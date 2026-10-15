// Insider and team watching for alerts (row F5, ADR-0940): which wallets the chain or the issuer ties to a token, and a scan that notices when one of them
// holds less of it than before.
//
// Who counts as tied to a token, each with the fact that says so (nothing is inferred from behaviour):
//   the mint authority of the token                                                    (the mint account)
//   the creator of a cross that sells the token                                        (the index, checked against the cross account on creation)
//   a wallet a cross declared as an insider in its rules                               (the cross account's rules tail, up to 8)
//   the authority of a treasury of the token as its ownership coin                      (the index)
//   a wallet named as an insider when a treasury was extended                           (the treasury account's extension, up to 4)
//   a wallet the issuer listed as team in a signed team declaration                    (a document whose signature is verified, @opening-cross/integrity)
// A wallet in the signed team declaration is `team`; every other is `insider`. A wallet nobody has declared is not here, so a hidden insider is not found by this.
//
// The scan reads each wallet's balance of the token and compares it with the last balance it accepted. It is a balance check, not a transaction trace: it sees a fall,
// not who received the tokens or why, and it misses a transfer that was reversed between two scans. A fall under the threshold is remembered, not forgotten, so many small
// sales add up until they cross it.
import { createHash } from 'node:crypto';
import type { Address } from '@solana/kit';
import { TEAM_SCHEMA, type TeamDeclaration, teamWallets } from '@opening-cross/integrity';
import { CROSS_CORE_PROGRAM_ADDRESS, CROSS_DISCRIMINATOR, readRuledCross } from '@opening-cross/sdk';
import { TREASURY_DISCRIMINATOR, TREASURY_PROGRAM_ADDRESS, decodeTreasuryExt } from '@opening-cross/treasury-client';
import { type WalletMovement, ppmOf, short } from './holder-alerts-core.js';
import type { AlertStore } from './holder-alerts-store.js';

/** The one thing the scan needs from Solana: a JSON-RPC call. */
export type Rpc = { call<T = unknown>(method: string, params?: unknown[]): Promise<T> };

/** A fall of at least this share of the supply, in parts per million, is an alert. 1000 is 0.1%. */
export const DEFAULT_MIN_PPM = 1000;
/** A wallet is rescanned at most this often (seconds). */
export const SCAN_EVERY_SECONDS = 60;
/** The wallets of one token that are watched, team first. */
export const MAX_INSIDERS = 25;
/** A baseline older than this was taken before nobody was watching; the next scan starts a new one instead of alerting on the gap. */
export const BASELINE_MAX_AGE_SECONDS = 86_400;
const INSIDER_SET_TTL_SECONDS = 600;
const ZERO = '11111111111111111111111111111111';

// ------------------------------------------------------------------------------------------------ RPC

/** JSON-RPC over RPC_URL (one or more, comma separated, tried in order), waiting out a 429. Null when RPC_URL is not set: insider watching is then off, and says so. */
export function envRpc(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Rpc | null {
  const urls = (env.RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) return null;
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      let last: unknown = new Error('no RPC endpoint answered');
      for (const url of urls) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(12_000) });
            if (r.status === 429 || r.status >= 500) {
              last = new Error(`RPC answered ${r.status}`);
              await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
              continue;
            }
            const j = (await r.json()) as { result?: T; error?: { message?: string } };
            if (j.error) throw new Error(`${method}: ${j.error.message ?? 'RPC error'}`);
            return j.result as T;
          } catch (e) {
            last = e;
            if (e instanceof Error && e.message.startsWith(`${method}:`)) throw e;
          }
        }
      }
      throw last;
    },
  };
}

type Chain = { data: Uint8Array; owner: string };
async function readAccount(rpc: Rpc, address: string): Promise<Chain | null> {
  const r = await rpc.call<{ value: { data: [string, string]; owner: string } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  return r.value ? { data: new Uint8Array(Buffer.from(r.value.data[0], 'base64')), owner: r.value.owner } : null;
}
const starts = (data: Uint8Array, prefix: ArrayLike<number>) => data.length >= prefix.length && Array.from(prefix).every((b, i) => data[i] === b);

export type MintInfo = { supply: bigint; decimals: number; mintAuthority: string | null };

/** The mint account of a token, or null when the address is not one (no account, or an account of another kind). */
export async function readMint(rpc: Rpc, mint: string): Promise<MintInfo | null> {
  const r = await rpc.call<{ value: { data?: { parsed?: { type?: string; info?: { supply: string; decimals: number; mintAuthority: string | null } } } } | null }>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const p = r.value?.data?.parsed;
  if (p?.type !== 'mint' || !p.info) return null;
  return { supply: BigInt(p.info.supply), decimals: p.info.decimals, mintAuthority: p.info.mintAuthority };
}

// ------------------------------------------------------------------------------------------------ who is tied to a token

export type Insider = { wallet: string; topic: 'insider' | 'team'; /** A verb phrase: "was the mint authority of the token". */ basis: string };

/** At most MAX_INSIDERS wallets with the facts that tie them to `mint`, team first. */
export async function insidersOf(store: AlertStore, rpc: Rpc, mint: string, mintAuthority: string | null): Promise<Insider[]> {
  const found = new Map<string, Insider>();
  const add = (wallet: string, topic: Insider['topic'], basis: string) => {
    if (wallet === ZERO) return;
    const have = found.get(wallet);
    if (!have) found.set(wallet, { wallet, topic, basis });
    else found.set(wallet, { wallet, topic: have.topic === 'team' || topic === 'team' ? 'team' : 'insider', basis: have.basis.includes(basis) ? have.basis : `${have.basis} and ${basis}` });
  };

  if (mintAuthority) add(mintAuthority, 'insider', 'is the mint authority of the token');

  const crosses = await store.crossesSelling(mint);
  for (const c of crosses) add(c.creator, 'insider', `created cross ${short(c.address)}, which sells the token`);
  for (const c of crosses.slice(0, 5)) {
    const acct = await readAccount(rpc, c.address).catch(() => null);
    if (!acct || acct.owner !== CROSS_CORE_PROGRAM_ADDRESS || !starts(acct.data, CROSS_DISCRIMINATOR)) continue;
    const x = readRuledCross(c.address as Address, acct.data).ext;
    for (const w of x?.neutrality.insiders.slice(0, x.neutrality.insiderCount) ?? []) add(w, 'insider', `was declared an insider by cross ${short(c.address)}`);
  }

  for (const t of await store.treasuriesOfCoin(mint)) {
    add(t.authority, 'insider', `is the authority of treasury ${short(t.address)}`);
    const acct = await readAccount(rpc, t.address).catch(() => null);
    if (!acct || acct.owner !== TREASURY_PROGRAM_ADDRESS || !starts(acct.data, TREASURY_DISCRIMINATOR)) continue;
    for (const w of decodeTreasuryExt(acct.data)?.insiders ?? []) add(w, 'insider', `was named an insider when treasury ${short(t.address)} was extended`);
  }

  const doc = (await store.signedDocument(mint, TEAM_SCHEMA)) as TeamDeclaration | null;
  for (const [w, fact] of await teamWallets(doc, mint)) add(w, 'team', fact.replace(/^listed /, 'was listed '));

  return [...found.values()].sort((a, b) => (a.topic === b.topic ? 0 : a.topic === 'team' ? -1 : 1)).slice(0, MAX_INSIDERS);
}

// ------------------------------------------------------------------------------------------------ the scan

type TokenAccounts = { value: { pubkey: string; account: { data: { parsed?: { info?: { tokenAmount?: { amount: string } } } } } }[] };

/** Everything a wallet holds of a token, over all its token accounts. */
export async function balanceOfWallet(rpc: Rpc, wallet: string, mint: string): Promise<bigint> {
  const r = await rpc.call<TokenAccounts>('getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  let total = 0n;
  for (const a of r.value) total += BigInt(a.account.data.parsed?.info?.tokenAmount?.amount ?? '0');
  return total;
}

async function newestTx(rpc: Rpc, wallet: string): Promise<string | null> {
  try {
    const sigs = await rpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [wallet, { limit: 3, commitment: 'confirmed' }]);
    return sigs.find((s) => s.err === null)?.signature ?? null;
  } catch {
    return null;
  }
}

export type ScanReport = {
  mint: string;
  /** Not a token mint on this cluster: nothing was scanned. */
  notAMint: boolean;
  wallets: number;
  /** Wallets whose first balance was taken now: there is nothing to compare with yet. */
  baselined: number;
  /** Wallets whose balance could not be read this time. */
  failed: number;
  recorded: WalletMovement[];
};

export type ScanOptions = { minPpm?: number; now: number; insiders?: readonly Insider[] };

/** One scan of one token. Records each fall at or over the threshold once and returns them. */
export async function scanMint(store: AlertStore, rpc: Rpc, mint: string, opts: ScanOptions): Promise<ScanReport> {
  const report: ScanReport = { mint, notAMint: false, wallets: 0, baselined: 0, failed: 0, recorded: [] };
  const info = await readMint(rpc, mint);
  if (!info || info.supply === 0n) {
    report.notAMint = !info;
    return report;
  }
  const minPpm = opts.minPpm ?? DEFAULT_MIN_PPM;
  const insiders = opts.insiders ?? (await insidersOf(store, rpc, mint, info.mintAuthority));
  const cross = await store.latestCrossFor(mint);
  const href = cross ? `/crosses/${cross}` : '/alerts';
  report.wallets = insiders.length;

  const queue = [...insiders];
  const work = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      let now: bigint;
      try {
        now = await balanceOfWallet(rpc, w.wallet, mint);
      } catch {
        report.failed += 1;
        continue;
      }
      const base = await store.balanceOf(mint, w.wallet);
      if (!base || opts.now - base.observedAt > BASELINE_MAX_AGE_SECONDS) {
        await store.setBalance(mint, w.wallet, w.topic, w.basis, now, opts.now);
        report.baselined += 1;
        continue;
      }
      if (now >= base.amount) {
        // Unchanged, or it grew: the higher balance is the baseline a later fall is measured from.
        await store.setBalance(mint, w.wallet, w.topic, w.basis, now, opts.now);
        continue;
      }
      const moved = ppmOf(base.amount - now, info.supply);
      if (moved < minPpm) {
        // Keep the old baseline so small falls add up; only say it is still being watched.
        await store.touchBalance(mint, w.wallet, opts.now);
        continue;
      }
      const m: WalletMovement = {
        topic: w.topic,
        id: createHash('sha256').update(`${mint}|${w.wallet}|${base.amount}|${now}|${opts.now}`).digest('hex').slice(0, 24),
        subject: mint,
        at: opts.now,
        wallet: w.wallet,
        basis: w.basis,
        beforePpm: ppmOf(base.amount, info.supply),
        afterPpm: ppmOf(now, info.supply),
        movedPpm: moved,
        latestTx: await newestTx(rpc, w.wallet),
        href,
      };
      if (await store.recordMovement(m)) report.recorded.push(m);
      await store.setBalance(mint, w.wallet, w.topic, w.basis, now, opts.now);
    }
  };
  await Promise.all([work(), work(), work()]);
  return report;
}

// ------------------------------------------------------------------------------------------------ scheduling

/**
 * Remembers which tokens to scan and when, and the insider set of each for a few minutes. `scanDue` scans at most `limit` tokens that are due, oldest scan first,
 * so one slow token cannot stall the others or the delivery loop.
 */
export function scanner(store: AlertStore, rpc: Rpc, opts: { minPpm?: number } = {}) {
  const last = new Map<string, number>();
  const sets = new Map<string, { at: number; list: Insider[] }>();
  const notMint = new Map<string, number>();

  async function insiders(mint: string, now: number): Promise<Insider[] | null> {
    const hit = sets.get(mint);
    if (hit && now - hit.at < INSIDER_SET_TTL_SECONDS) return hit.list;
    const info = await readMint(rpc, mint);
    if (!info) return null;
    const list = await insidersOf(store, rpc, mint, info.mintAuthority);
    sets.set(mint, { at: now, list });
    return list;
  }

  return {
    insiders,
    async scanDue(mints: readonly string[], now: number, limit = 5): Promise<ScanReport[]> {
      const due = mints
        .filter((m) => now - (last.get(m) ?? 0) >= SCAN_EVERY_SECONDS && (notMint.get(m) ?? 0) <= now)
        .sort((a, b) => (last.get(a) ?? 0) - (last.get(b) ?? 0))
        .slice(0, limit);
      const out: ScanReport[] = [];
      for (const m of due) {
        last.set(m, now);
        try {
          const list = await insiders(m, now);
          if (list === null) {
            notMint.set(m, now + 3600);
            continue;
          }
          out.push(await scanMint(store, rpc, m, { ...(opts.minPpm !== undefined && { minPpm: opts.minPpm }), now, insiders: list }));
        } catch (e) {
          console.error(JSON.stringify({ at: new Date().toISOString(), alerts: 'scan failed', mint: m, error: String(e) }));
        }
      }
      return out;
    },
  };
}
