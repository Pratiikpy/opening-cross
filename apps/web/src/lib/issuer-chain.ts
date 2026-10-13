'use client';

// Reads the facts the issuer's readiness checklist judges, straight from the network the app is pointed at: both mints, this wallet's
// SOL and quote token account, the cluster's clock, and the rent the cluster charges for the real sizes of a cross's accounts (measured
// on the newest cross that already exists, so a program upgrade that changes a size is picked up without a code change).
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { API_URL } from './api';
import { RPC_URL } from './config';
import type { ChainFacts, MintRead, RentModel } from './issuer-readiness';
import { CROSS_CORE } from './power';

const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const text = new TextEncoder();

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  // The public devnet endpoint answers bursts with 429; reads are safe to repeat.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const json = (await res.json().catch(() => ({ error: { message: `The RPC endpoint answered HTTP ${res.status}.` } }))) as { result?: T; error?: { code?: number; message: string } };
    if ((res.status === 429 || json.error?.code === 429) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      continue;
    }
    if (json.error) throw new Error(json.error.message);
    return json.result as T;
  }
}

type Parsed = { value: { owner: string; space?: number; lamports: number; data: { parsed?: { type: string; info: Record<string, unknown> } } } | null };

/** A mint's decimals, program, authorities and Token-2022 extensions, as the chain holds them now. */
export async function readMintFull(mint: string): Promise<MintRead> {
  try {
    const { value } = await rpc<Parsed>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    if (!value) return { ok: false, reason: 'No account exists at this address.' };
    const p = value.data.parsed;
    if (p?.type !== 'mint') return { ok: false, reason: 'This address is not a token mint.' };
    const i = p.info as { decimals: number; supply?: string; mintAuthority?: string | null; freezeAuthority?: string | null; extensions?: { extension: string; state?: { name?: string; symbol?: string } }[] };
    const meta = (i.extensions ?? []).find((e) => e.extension === 'tokenMetadata')?.state;
    return {
      ok: true,
      program: value.owner,
      decimals: i.decimals,
      mintAuthority: i.mintAuthority ?? null,
      freezeAuthority: i.freezeAuthority ?? null,
      extensions: (i.extensions ?? []).map((e) => e.extension),
      ...(i.supply !== undefined && /^\d+$/.test(i.supply) && { supply: BigInt(i.supply) }),
      metadata: meta?.name !== undefined && meta.symbol !== undefined ? { name: meta.name, symbol: meta.symbol } : null,
    };
  } catch (e) {
    return { ok: false, reason: `The network could not be reached to read this mint (${e instanceof Error ? e.message : String(e)}).` };
  }
}

async function ata(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({ programAddress: address(ATA_PROGRAM), seeds: [enc.encode(address(owner)), enc.encode(address(tokenProgram)), enc.encode(address(mint))] });
  return pda;
}

async function readQuoteAccount(wallet: string, quote: MintRead | null, quoteMint: string): Promise<ChainFacts['quoteAccount']> {
  if (!quote?.ok) return null;
  try {
    const account = await ata(wallet, quoteMint, quote.program);
    const { value } = await rpc<Parsed>('getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    if (!value) return { exists: false, amount: 0n };
    const amount = (value.data.parsed?.info as { tokenAmount?: { amount: string } } | undefined)?.tokenAmount?.amount;
    return amount === undefined ? null : { exists: true, amount: BigInt(amount) };
  } catch {
    return null;
  }
}

async function readClock(): Promise<ChainFacts['clock']> {
  try {
    let slot = await rpc<number>('getSlot', [{ commitment: 'confirmed' }]);
    // A slot can be skipped and have no block time; the previous one has.
    for (let i = 0; i < 6; i++, slot--) {
      const t = await rpc<number | null>('getBlockTime', [slot]).catch(() => null);
      if (t) return { chainMs: t * 1000, localMs: Date.now() };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Account sizes in bytes, as measured on devnet on 2026-10-13: a cross, a book or shard (Levels::SIZE = 8 + 6184), and a token vault.
 * Used only when no cross exists yet to measure; the rent for them is still the cluster's own.
 */
const BUILT_IN_SIZES = { cross: 668, level: 6192, vault: 165 };

/** Rent for the accounts of a cross, from the sizes of the newest cross that exists (or the built-in sizes if there is none to read). */
async function readRent(): Promise<RentModel | null> {
  const min = (n: number) => rpc<number>('getMinimumBalanceForRentExemption', [n]).then(BigInt);
  try {
    let sizes: { cross: number; level: number; vault: number } | null = null;
    try {
      const res = await fetch(`${API_URL}/v1/crosses`, { cache: 'no-store' });
      const body = res.ok ? ((await res.json()) as { crosses?: { address: string; created_slot?: number }[] } | { address: string; created_slot?: number }[]) : null;
      const list = body ? (Array.isArray(body) ? body : (body.crosses ?? [])) : [];
      const newest = [...list].sort((a, b) => (b.created_slot ?? 0) - (a.created_slot ?? 0))[0];
      if (newest) {
        const enc = getAddressEncoder();
        const program = address(CROSS_CORE);
        const key = enc.encode(address(newest.address));
        const pda = async (seed: string) => (await getProgramDerivedAddress({ programAddress: program, seeds: [text.encode(seed), key] }))[0];
        const space = async (a: string) => {
          const v = (await rpc<{ value: { space: number } | null }>('getAccountInfo', [a, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }])).value;
          if (!v) throw new Error('account missing');
          return v.space;
        };
        const [cross, level, vault] = await Promise.all([space(newest.address), space(await pda('book')), space(await pda('quote_vault'))]);
        sizes = { cross, level, vault };
      }
    } catch {
      sizes = null;
    }
    const used = sizes ?? BUILT_IN_SIZES;
    const [cross, level, vault] = await Promise.all([min(used.cross), min(used.level), min(used.vault)]);
    return { cross, level, vault, sizes: sizes ? 'chain' : 'built-in' };
  } catch {
    return null;
  }
}

/** Everything the checklist needs, read now. Each part fails on its own: a missing fact makes only its own item fail. */
export async function readFacts(input: { wallet: string; baseMint: string; quoteMint: string; /** Mints already read by the caller, so they are not read twice. */ mints?: { base: MintRead; quote: MintRead } }): Promise<ChainFacts> {
  const [base, quote] = input.mints ? [input.mints.base, input.mints.quote] : await Promise.all([readMintFull(input.baseMint), readMintFull(input.quoteMint)]);
  const [lamports, quoteAccount, rent, clock] = await Promise.all([
    rpc<{ value: number }>('getBalance', [input.wallet, { commitment: 'confirmed' }]).then((r) => BigInt(r.value), () => null),
    readQuoteAccount(input.wallet, quote, input.quoteMint),
    readRent(),
    readClock(),
  ]);
  return { base, quote, lamports, quoteAccount, rent, clock };
}
