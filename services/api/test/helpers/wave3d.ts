// A small in-memory chain for the routes of the seven Wave 3D programs: accounts injected by address, mints and token accounts in the layouts the SPL
// programs use, crosses of cross_core with or without a rules tail, programs fabricated from the discriminators their instructions load, and a decoder
// that turns a built transaction back into instructions. The programs are not run here (their LiteSVM suites run against the real binaries, tests/core).
import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Instruction,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  none,
  some,
} from '@solana/kit';
import {
  CROSS_BODY_LEN,
  CROSS_CORE_PROGRAM_ADDRESS,
  CROSS_EXT_LEN,
  CrossKind,
  CrossState,
  Disclosure,
  SupplyMode,
  ata,
  completeRules,
  crossAddress,
  getCrossEncoder,
  getCrossExtEncoder,
} from '@opening-cross/sdk';
import { type NewProgramKey, NEW_PROGRAMS, type ProgramRelease } from '../../src/routes/programs-support.js';
import { RequestError } from '../../src/tx.js';
import type { ReleaseState } from '../../src/routes/programs-support.js';

export const NOW = 1_800_000_000;
export const BLOCKHASH = '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy';
export const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;
export const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
export const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const ZERO = '11111111111111111111111111111111' as Address;
export type Account = { data: Uint8Array; owner: Address };

export const key = async (): Promise<Address> => (await generateKeyPairSigner()).address;
export const ready: ProgramRelease = async () => 'ready';
export const releaseOf = (state: ReleaseState, only?: NewProgramKey): ProgramRelease => async (k) => (only === undefined || only === k ? state : 'ready');

export class Chain {
  readonly accounts = new Map<string, Account>();
  reads = 0;
  put(address: Address, owner: Address, data: Uint8Array) {
    this.accounts.set(address, { owner, data });
    return address;
  }
  del(address: Address) {
    this.accounts.delete(address);
  }
  readonly account = async (a: Address): Promise<Account | null> => {
    this.reads++;
    return this.accounts.get(a) ?? null;
  };
  readonly lifetime = async () => ({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 1n });

  /** A mint in the SPL layout: supply at 36, decimals at 44, initialized at 45. */
  mint(address: Address, o: { decimals?: number; supply?: bigint; program?: Address } = {}) {
    const data = new Uint8Array(82);
    new DataView(data.buffer).setBigUint64(36, o.supply ?? 0n, true);
    data[44] = o.decimals ?? 6;
    data[45] = 1;
    return this.put(address, o.program ?? SPL, data);
  }
  /** `owner`'s associated token account of `mint` with `amount` in it. */
  async token(owner: Address, mint: Address, amount: bigint, program: Address = SPL) {
    return this.tokenAt(await ata(owner, mint, program), owner, mint, amount, program);
  }
  tokenAt(address: Address, owner: Address, mint: Address, amount: bigint, program: Address = SPL) {
    const data = new Uint8Array(165);
    data.set(getAddressEncoder().encode(mint), 0);
    data.set(getAddressEncoder().encode(owner), 32);
    new DataView(data.buffer).setBigUint64(64, amount, true);
    data[108] = 1;
    return this.put(address, program, data);
  }
  setSupply(mint: Address, supply: bigint) {
    const a = this.accounts.get(mint)!;
    new DataView(a.data.buffer, a.data.byteOffset).setBigUint64(36, supply, true);
  }
  /** A program account whose data account holds an ELF that loads every discriminator given: the release check finds exactly those instructions. */
  deploy(key: NewProgramKey, extra: Uint8Array[] = [], dataAddress: Address = getAddressDecoder().decode(new Uint8Array(32).fill(150 + Object.keys(NEW_PROGRAMS).indexOf(key)))) {
    const p = NEW_PROGRAMS[key];
    const body = elf([p.control.discriminator, ...extra]);
    const data = new Uint8Array(45 + body.length);
    new DataView(data.buffer).setUint32(0, 3, true);
    new DataView(data.buffer).setBigUint64(4, 777n, true);
    data.set(body, 45);
    const program = new Uint8Array(36);
    new DataView(program.buffer).setUint32(0, 2, true);
    program.set(getAddressEncoder().encode(dataAddress), 4);
    this.put(p.address, LOADER, program);
    this.put(dataAddress, LOADER, data);
  }

  /** A cross of cross_core. `ext` adds the rules tail (flags, and the supply the mandate's share limit is measured against). */
  async cross(o: {
    creator: Address;
    id?: bigint;
    state?: CrossState;
    baseMint?: Address;
    quoteMint: Address;
    baseBound?: boolean;
    disclosure?: Disclosure;
    quoteProgram?: Address;
    baseProgram?: Address;
    ordersTotal?: number;
    ordersOpen?: number;
    cleared?: boolean;
    noPrintReason?: number | null;
    gateMint?: Address;
    closeTs?: bigint;
    ext?: { flags?: number; totalSupply?: bigint; maxMatched?: bigint; capQuote?: bigint };
    minPrice?: bigint;
    priceScale?: bigint;
  }): Promise<Address> {
    const id = o.id ?? 1n;
    const address = await crossAddress(o.creator, id);
    const state = o.state ?? CrossState.Live;
    const clearing = o.cleared === false || (state !== CrossState.Cleared && state !== CrossState.Finalized) ? none() : some({ price: 1_300_000n, matched: 1_000_000_000n, demand: 1_000_000_000n, supply: 1_000_000_000n, rationed: 0, marginalQuantity: 0n, marginalRemaining: 0n, marginalOrders: 0 });
    const body = getCrossEncoder().encode({
      creator: o.creator, crossId: id, kind: CrossKind.Launch, supplyMode: SupplyMode.Escrow, disclosure: o.disclosure ?? Disclosure.Open, state,
      baseMint: o.baseMint ?? ZERO, quoteMint: o.quoteMint, baseTokenProgram: o.baseProgram ?? SPL, quoteTokenProgram: o.quoteProgram ?? SPL, baseDecimals: 6, quoteDecimals: 6, proceedsTo: o.creator,
      minPrice: o.minPrice ?? 1_000_000n, tick: 100_000n, ticks: 20, priceScale: o.priceScale ?? 1_000_000n, openTs: NOW - 1000, closeTs: o.closeTs ?? BigInt(NOW + 3600), revealEndTs: (o.closeTs ?? BigInt(NOW + 3600)) + 600n,
      referencePrice: none(), minMatched: 0n, maxImbalanceBps: none(), protocolFeeBps: 30, integratorFeeBps: 0, integrator: o.creator, feeRecipient: o.creator,
      gateMint: o.gateMint ? some(o.gateMint) : none(), shards: 2, maxOrders: 64, dustBond: 0n, ordersTotal: o.ordersTotal ?? 0, ordersOpen: o.ordersOpen ?? 0, mergedMask: 3, clearing,
      noPrintReason: o.noPrintReason == null ? none() : some(o.noPrintReason), buyerPaid: 0n, baseBought: 0n, baseSold: 0n, sellerPaid: 0n, feesAccrued: 0n, oracle: none(), calendar: none(), settler: none(),
      settleDeadlineTs: 0n, baseBound: o.baseBound ?? o.baseMint !== undefined, bump: 1, quoteVaultBump: 1, baseVaultBump: 1, bookBump: 1,
    } as never);
    const data = new Uint8Array(CROSS_BODY_LEN + (o.ext ? CROSS_EXT_LEN : 0));
    data.set(body);
    if (o.ext) {
      const r = completeRules({ guards: { totalSupply: o.ext.totalSupply ?? 0n, maxMatched: o.ext.maxMatched ?? 0n }, identity: { capQuote: o.ext.capQuote ?? 0n } });
      data.set(
        getCrossExtEncoder().encode({
          version: 1, rulesSet: true, createdSlot: 1n, flags: o.ext.flags ?? 0, guards: { ...r.guards, haltSource: null }, ending: r.ending,
          draw: { epoch: 0, pendingSlot: 0n, pendingPurpose: 0, seed: new Uint8Array(32), seedEpoch: 0, seedReady: false, endBucket: 255, extPending: false, extensionUsed: false, auxMerged: 0n },
          identity: r.identity, alloc: { ...r.alloc, priorityGate: null }, neutrality: { insiders: Array.from({ length: 8 }, () => ZERO), insiderCount: 0, insiderCliffSecs: 0, insiderVestSecs: 0, bondQuote: 0n, challengeSecs: 0 },
          neutralState: { bondHeld: 0n, slashed: 0n, openChallenges: 0, challenges: 0 }, clearing: { classQty: [0n, 0n, 0n], tickets: 0, rho: 0, clearedTs: 0n, insiderUb: 0n }, referral: r.referral,
          oracleSet: { extraFeeds: [new Uint8Array(32), new Uint8Array(32)] as never, extraCount: 0, quorum: 0, maxSpreadBps: 0, offHoursWidenBps: 0 },
        } as never),
        CROSS_BODY_LEN,
      );
    }
    this.put(address, CROSS_CORE_PROGRAM_ADDRESS, data);
    return address;
  }
}

/** Eight-byte-aligned filler with one lddw per discriminator: 0x18, regs, offset, the low half, then the high half, as the compiler emits it. */
export function elf(discs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(4096 + discs.length * 64);
  out.fill(0x07, 0, 4096);
  discs.forEach((d, n) => {
    const at = 4096 + n * 64;
    out[at] = 0x18;
    out[at + 1] = 0x01;
    out.set(d.subarray(0, 4), at + 4);
    out.set(d.subarray(4, 8), at + 12);
  });
  return out;
}

export const decode = (tx: string): Instruction[] => {
  const decoded = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(tx, 'base64')));
  return decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)).instructions as Instruction[];
};
export const startsWith = (ix: Instruction, disc: ArrayLike<number>): boolean => ix.data !== undefined && Array.from(disc).every((b, i) => ix.data![i] === b);
export const ofProgram = (ixs: Instruction[], program: Address) => ixs.filter((i) => i.programAddress === program);

/** A server with the error handler the real one has, so a `RequestError` becomes its status and body. */
export function server() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RequestError) return reply.code(err.status).type('application/json').send(JSON.stringify({ error: err.message, ...err.detail }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const e = err as { statusCode?: number; message?: string };
    return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'internal error' });
  });
  return app;
}
export const caller = (app: ReturnType<typeof Fastify>) => ({
  post: async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
  },
  get: async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
  },
});

/** A PGlite database with every indexer migration applied, wrapped in the slice of `pg.Pool` the routes use. */
export async function database() {
  const pg = new PGlite();
  const dir = fileURLToPath(new URL('../../../indexer/migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await pg.exec(readFileSync(`${dir}${f}`, 'utf8'));
  return { pg, db: { query: async (text: string, params?: unknown[]) => ({ rows: (await pg.query(text, params as never[])).rows as Record<string, unknown>[] }) } };
}
