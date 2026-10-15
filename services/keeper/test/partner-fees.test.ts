// The partner-fees duty (row P2, ADR-0961): on a schedule, the keeper reads the DBC pool of each cleared cross and, when the partner's accrued trading fee reaches the minimum,
// opens the fee recipient's two token accounts and sends cross_settle's permissionless `claim_partner_fee`, whose destinations the program fixes to the fee recipient.
// The layout the keeper reads is checked against Meteora's own IDL, decoded by Anchor's coder; the pass runs on the in-memory chain of test/helpers/world.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BorshAccountsCoder } from '@coral-xyz/anchor';
import { describe, expect, it } from 'vitest';
import type { Address, Instruction } from '@solana/kit';
import { CrossState, getCrossDecoder } from '@opening-cross/cross-core-client';
import { TOKEN_2022, continuationAddresses } from '@opening-cross/adapters';
import { ASSOCIATED_TOKEN_PROGRAM, ata } from '@opening-cross/sdk';
import { CLAIM_PARTNER_FEE_DISCRIMINATOR, CROSS_SETTLE_PROGRAM_ADDRESS } from '@opening-cross/cross-settle-client';
import { type Deferred, ALL_DUTIES, DEFAULT_DUTIES, POOL_ACCOUNT_LEN, POOL_DISCRIMINATORS, POOL_PARTNER_BASE_FEE_OFFSET, POOL_PARTNER_QUOTE_FEE_OFFSET, parseDuties, planPartnerClaim, readPartnerFees, runOnce } from '../src/index.js';
import { World, key } from './helpers/world.js';

const idl = JSON.parse(readFileSync(fileURLToPath(new URL('../../../idls/dynamic_bonding_curve.json', import.meta.url)), 'utf8'));

// ------------------------------------------------------------------ the layout, against the IDL

type IdlField = { name: string; type: unknown };
const SIZE: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, pubkey: 32, bool: 1 };
const types = new Map<string, { type: { fields: IdlField[] } }>((idl.types as { name: string; type: { fields: IdlField[] } }[]).map((t) => [t.name, t]));
function sizeOf(t: unknown): number {
  if (typeof t === 'string') return SIZE[t] ?? NaN;
  const o = t as { array?: [unknown, number]; defined?: { name: string } };
  if (o.array) return sizeOf(o.array[0]) * o.array[1];
  if (o.defined) return types.get(o.defined.name)!.type.fields.reduce((a, f) => a + sizeOf(f.type), 0);
  return NaN;
}
const offsetOf = (struct: string, field: string): number => {
  let at = 0;
  for (const f of types.get(struct)!.type.fields) {
    if (f.name === field) return at;
    at += sizeOf(f.type);
  }
  throw new Error(`no field ${field}`);
};

/** A pool account with distinct sentinels in the neighbouring fields, so that reading the wrong offset cannot pass. */
function poolBytes(o: { kind?: 0 | 1; base: bigint; quote: bigint; protocolQuote?: bigint; creatorQuote?: bigint }): Uint8Array {
  const data = new Uint8Array(POOL_ACCOUNT_LEN);
  data.set(POOL_DISCRIMINATORS[o.kind ?? 1]!, 0);
  const v = new DataView(data.buffer);
  v.setBigUint64(8 + offsetOf('PoolState', 'protocol_base_fee'), 111n, true);
  v.setBigUint64(8 + offsetOf('PoolState', 'protocol_quote_fee'), o.protocolQuote ?? 222n, true);
  v.setBigUint64(POOL_PARTNER_BASE_FEE_OFFSET, o.base, true);
  v.setBigUint64(POOL_PARTNER_QUOTE_FEE_OFFSET, o.quote, true);
  v.setBigUint64(8 + offsetOf('PoolState', 'creator_quote_fee'), o.creatorQuote ?? 999n, true);
  return data;
}

describe('the pool layout the keeper reads is the one Meteora\'s IDL defines', () => {
  it('puts partner_base_fee and partner_quote_fee at the offsets the keeper uses, after the 8-byte discriminator', () => {
    expect(8 + offsetOf('PoolState', 'partner_base_fee')).toBe(POOL_PARTNER_BASE_FEE_OFFSET);
    expect(8 + offsetOf('PoolState', 'partner_quote_fee')).toBe(POOL_PARTNER_QUOTE_FEE_OFFSET);
  });

  it('the account is 8 + 416 bytes, which the program asserts, so the IDL has no hidden padding before those fields', () => {
    expect(sizeOf({ defined: { name: 'PoolState' } })).toBe(416);
    expect(POOL_ACCOUNT_LEN).toBe(424);
  });

  it('the two discriminators are the IDL\'s VirtualPool and TransferHookPool', () => {
    const disc = (name: string) => (idl.accounts as { name: string; discriminator: number[] }[]).find((a) => a.name === name)!.discriminator;
    expect(POOL_DISCRIMINATORS).toEqual([disc('VirtualPool'), disc('TransferHookPool')]);
  });

  it('Anchor\'s decoder, driven only by the IDL, reads the same fee values out of bytes laid out as the keeper expects', () => {
    const coder = new BorshAccountsCoder(idl);
    for (const [kind, name] of [[0, 'VirtualPool'], [1, 'TransferHookPool']] as const) {
      const pool = coder.decode(name, Buffer.from(poolBytes({ kind, base: 7_000_001n, quote: 13_000_013n }))).pool_state;
      expect(BigInt(pool.partner_base_fee.toString())).toBe(7_000_001n);
      expect(BigInt(pool.partner_quote_fee.toString())).toBe(13_000_013n);
      expect(BigInt(pool.protocol_quote_fee.toString())).toBe(222n);
      expect(BigInt(pool.creator_quote_fee.toString())).toBe(999n);
    }
  });

  it('readPartnerFees returns the partner\'s two legs of either pool kind, and nothing for bytes that are not a pool', () => {
    expect(readPartnerFees(poolBytes({ kind: 0, base: 5n, quote: 6n }))).toEqual({ base: 5n, quote: 6n });
    expect(readPartnerFees(poolBytes({ kind: 1, base: 0n, quote: 2n ** 63n }))).toEqual({ base: 0n, quote: 2n ** 63n });
    expect(readPartnerFees(new Uint8Array(POOL_ACCOUNT_LEN))).toBeNull(); // no discriminator
    expect(readPartnerFees(poolBytes({ base: 1n, quote: 1n }).slice(0, POOL_ACCOUNT_LEN - 1))).toBeNull(); // short
    const wrong = poolBytes({ base: 1n, quote: 1n });
    wrong[0] = wrong[0]! ^ 0xff;
    expect(readPartnerFees(wrong)).toBeNull();
  });
});

// ------------------------------------------------------------------ planning

describe('planPartnerClaim', () => {
  const cross = '11111111111111111111111111111112' as Address;
  const cfg = { everySecs: 3600, minQuote: 1_000n, minBase: 5_000n };
  it('claims when either leg reaches its minimum, exactly at it, and not a unit below', () => {
    expect(planPartnerClaim({ cross, fees: { base: 0n, quote: 1_000n } }, cfg).actions).toHaveLength(1);
    expect(planPartnerClaim({ cross, fees: { base: 0n, quote: 999n } }, cfg).actions).toEqual([]);
    expect(planPartnerClaim({ cross, fees: { base: 5_000n, quote: 0n } }, cfg).actions).toHaveLength(1);
    expect(planPartnerClaim({ cross, fees: { base: 4_999n, quote: 999n } }, cfg).actions).toEqual([]);
  });
  it('never claims nothing, whatever the minimum is, and says nothing about a pool without a pool or a fee', () => {
    const zero = { everySecs: 1, minQuote: 0n, minBase: 0n };
    expect(planPartnerClaim({ cross, fees: { base: 0n, quote: 0n } }, zero)).toEqual({ actions: [], skipped: [] });
    expect(planPartnerClaim({ cross, fees: null }, zero)).toEqual({ actions: [], skipped: [] });
  });
  it('carries the amounts it saw', () => {
    expect(planPartnerClaim({ cross, fees: { base: 3n, quote: 4n } }).actions).toEqual([{ kind: 'claim-partner-fee', cross, baseFee: 3n, quoteFee: 4n }]);
  });
});

describe('duty names', () => {
  it('is a named duty that is not done by default: it spends the keeper\'s rent on accounts of the protocol\'s', () => {
    expect(ALL_DUTIES).toContain('partner-fees');
    expect(DEFAULT_DUTIES).not.toContain('partner-fees');
    expect(parseDuties('partner-fees')).toEqual(new Set(['partner-fees']));
    expect(parseDuties('all').has('partner-fees')).toBe(true);
    expect(() => parseDuties('partner_fees')).toThrow(/unknown keeper duty/);
  });
});

// ------------------------------------------------------------------ the pass

const startsWith = (ix: Instruction, d: ArrayLike<number>) => Array.from(d).every((b, i) => ix.data![i] === b);

async function withPool(w: World, state: CrossState, pool: { base: bigint; quote: bigint } | null, opts: { kind?: 0 | 1 } = {}) {
  const cross = await w.cross({ state });
  const a = await continuationAddresses(cross, w.quote);
  if (pool) w.accounts.set(a.pool, poolBytes({ ...pool, ...(opts.kind === undefined ? {} : { kind: opts.kind }) }));
  return { cross, pool: a.pool };
}

describe('the keeper claims the protocol\'s partner fees', () => {
  it('opens the fee recipient\'s two accounts and claims in one transaction; the pool is emptied; a second pass finds nothing', async () => {
    const w = await World.create();
    const { cross, pool } = await withPool(w, CrossState.Finalized, { base: 0n, quote: 1_250_000n });
    const memory = new Map<string, Deferred>();
    const r = await runOnce(w.deps({ duties: 'partner-fees', memory }));
    expect(r.failed).toEqual([]);
    expect(r.done.map((d) => d.action)).toEqual([{ kind: 'claim-partner-fee', cross, baseFee: 0n, quoteFee: 1_250_000n }]);

    const data = getCrossDecoder().decode(w.get(cross));
    // The base leg is a Token-2022 mint (the continuation's transfer hook), the quote leg whatever token program the cross's quote mint uses.
    const [quoteAta, baseAta] = [await ata(data.feeRecipient, data.quoteMint, data.quoteTokenProgram), await ata(data.feeRecipient, data.baseMint, TOKEN_2022)];
    const tx = w.sent.at(-1)!;
    expect(tx.map((ix) => ix.programAddress)).toEqual([ASSOCIATED_TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, CROSS_SETTLE_PROGRAM_ADDRESS]);
    expect(startsWith(tx[2]!, CLAIM_PARTNER_FEE_DISCRIMINATOR)).toBe(true);
    // The quote destination is the fee recipient's account for the quote mint: that is the only owner the program accepts.
    expect(w.claims).toHaveLength(1);
    expect(w.claims[0]).toMatchObject({ cross, pool, baseDestination: baseAta, quoteDestination: quoteAta, base: 0n, quote: 1_250_000n });
    expect(w.accounts.has(quoteAta) && w.accounts.has(baseAta)).toBe(true);
    expect(readPartnerFees(w.get(pool))).toEqual({ base: 0n, quote: 0n });

    const before = w.sent.length;
    w.clock += 3_601n; // a later look: the pool is empty, so there is nothing to claim
    const again = await runOnce(w.deps({ duties: 'partner-fees', memory }));
    expect(again.done).toEqual([]);
    expect(again.failed).toEqual([]);
    expect(w.sent.length).toBe(before);
  });

  it('looks at a pool at most once per interval, and claims again when more has accrued', async () => {
    const w = await World.create();
    const { pool } = await withPool(w, CrossState.Finalized, { base: 0n, quote: 500n });
    const memory = new Map<string, Deferred>();
    let poolReads = 0;
    const deps = () => w.deps({ duties: 'partner-fees', memory, partnerFees: { everySecs: 3_600, minQuote: 1n, minBase: 1n }, fetch: async (a) => { if (a === pool) poolReads++; return w.accounts.get(a) ?? null; } });

    expect((await runOnce(deps())).done).toHaveLength(1);
    expect(poolReads).toBe(1);
    // Fees accrue, but the interval has not passed: the pool is not read again, so nothing is sent.
    w.accounts.set(pool, poolBytes({ base: 0n, quote: 900n }));
    w.clock += 3_599n;
    expect((await runOnce(deps())).done).toEqual([]);
    expect(poolReads).toBe(1);
    // The interval passes: the accrued fee is claimed.
    w.clock += 1n;
    expect((await runOnce(deps())).done).toHaveLength(1);
    expect(poolReads).toBe(2);
    expect(w.claims.map((c) => c.quote)).toEqual([500n, 900n]);
  });

  it('waits for the minimum, then claims everything that has accrued', async () => {
    const w = await World.create();
    const { pool } = await withPool(w, CrossState.Finalized, { base: 0n, quote: 9_999n });
    const memory = new Map<string, Deferred>();
    const deps = () => w.deps({ duties: 'partner-fees', memory, partnerFees: { everySecs: 60, minQuote: 10_000n, minBase: 10_000n } });
    expect((await runOnce(deps())).done).toEqual([]);
    w.accounts.set(pool, poolBytes({ base: 0n, quote: 10_000n }));
    w.clock += 60n;
    expect((await runOnce(deps())).done).toHaveLength(1);
    expect(w.claims[0]!.quote).toBe(10_000n);
  });

  it('claims a base-token fee as well, and a Cleared cross whose lifecycle is still open is looked at too', async () => {
    const w = await World.create();
    await withPool(w, CrossState.Cleared, { base: 4_000n, quote: 0n }, { kind: 0 });
    const r = await runOnce(w.deps({ duties: 'partner-fees' }));
    // The cross is finalized by the lifecycle in the same pass, and its pool is then claimed.
    expect(r.done.map((d) => d.action.kind)).toEqual(['finalize', 'claim-partner-fee']);
    expect(w.claims[0]).toMatchObject({ base: 4_000n, quote: 0n });
  });

  it('does nothing for a cross with no continuation pool, a live cross, a cross whose base mint is not bound, or bytes that are not a pool', async () => {
    const w = await World.create();
    await withPool(w, CrossState.Finalized, null); // settled some other way: no DBC pool at the derived address
    const live = await withPool(w, CrossState.Live, { base: 1n, quote: 1n });
    w.patchCross(live.cross, (c) => ({ ...c, closeTs: w.clock + 3_000n, revealEndTs: w.clock + 3_600n })); // still trading: the lifecycle leaves it alone
    const unbound = await w.cross({ state: CrossState.Finalized });
    w.patchCross(unbound, (c) => ({ ...c, baseBound: false }));
    w.accounts.set((await continuationAddresses(unbound, w.quote)).pool, poolBytes({ base: 1n, quote: 1n }));
    const junk = await w.cross({ state: CrossState.Finalized });
    w.accounts.set((await continuationAddresses(junk, w.quote)).pool, new Uint8Array(POOL_ACCOUNT_LEN).fill(7));
    const r = await runOnce(w.deps({ duties: 'partner-fees' }));
    expect(r.done).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(w.sent.length).toBe(0);
  });

  it('is off unless named, and a dry run plans the claim and sends nothing', async () => {
    const w = await World.create();
    await withPool(w, CrossState.Finalized, { base: 0n, quote: 77n });
    expect((await runOnce(w.deps({ duties: 'default' }))).done).toEqual([]);
    expect((await runOnce(w.deps({ duties: 'none' }))).done).toEqual([]);
    const dry = await runOnce(w.deps({ duties: 'partner-fees', dryRun: true }));
    expect(dry.planned.map((a) => a.kind)).toEqual(['claim-partner-fee']);
    expect(w.sent.length).toBe(0);
    expect(w.claims).toEqual([]);
  });

  it('serves only the crosses of its scope', async () => {
    const w = await World.create();
    const mine = await withPool(w, CrossState.Finalized, { base: 0n, quote: 10n });
    const theirs = await withPool(w, CrossState.Finalized, { base: 0n, quote: 20n });
    w.patchCross(theirs.cross, (c) => ({ ...c, creator: '11111111111111111111111111111112' }));
    const r = await runOnce(w.deps({ duties: 'partner-fees', accept: (c) => c.creator === w.payer.address }));
    expect(r.done.map((d) => (d.action.kind === 'claim-partner-fee' ? d.action.cross : null))).toEqual([mine.cross]);
  });

  it('a refused claim is a failure of that cross only: the others are claimed, and the refused one is tried again next interval, not next pass', async () => {
    const w = await World.create();
    const bad = await withPool(w, CrossState.Finalized, { base: 0n, quote: 11n });
    const good = await withPool(w, CrossState.Finalized, { base: 0n, quote: 22n });
    const memory = new Map<string, Deferred>();
    let refuse = true;
    const send = async (ixs: Instruction[]) => {
      if (refuse && ixs.some((ix) => startsWith(ix, CLAIM_PARTNER_FEE_DISCRIMINATOR) && ix.accounts![0]!.address === bad.cross)) throw new Error('custom program error: 0x1 (the claim is refused)');
      return w.deps().send(ixs);
    };
    const first = await runOnce(w.deps({ duties: 'partner-fees', memory, send }));
    expect(first.failed.map((f) => (f.action.kind === 'claim-partner-fee' ? f.action.cross : null))).toEqual([bad.cross]);
    expect(first.done.map((d) => (d.action.kind === 'claim-partner-fee' ? d.action.cross : null))).toEqual([good.cross]);
    // The next pass is inside the interval: not retried.
    const second = await runOnce(w.deps({ duties: 'partner-fees', memory, send }));
    expect(second.failed).toEqual([]);
    refuse = false;
    w.clock += 3_600n;
    const third = await runOnce(w.deps({ duties: 'partner-fees', memory, send }));
    expect(third.failed).toEqual([]);
    expect(third.done.map((d) => (d.action.kind === 'claim-partner-fee' ? d.action.cross : null))).toEqual([bad.cross]);
  });

  it('reads the candidate list the operator gave it, not only the lifecycle\'s: finalized crosses are not in `crosses`', async () => {
    const w = await World.create();
    const { cross } = await withPool(w, CrossState.Finalized, { base: 0n, quote: 5n });
    const r = await runOnce(w.deps({ duties: 'partner-fees', crosses: async () => [], partnerCrosses: async () => [cross] }));
    expect(r.done).toHaveLength(1);
  });

  it('a key for the fee recipient is whatever the cross names, not the keeper: the destinations follow the cross', async () => {
    const w = await World.create();
    const { cross } = await withPool(w, CrossState.Finalized, { base: 0n, quote: 5n });
    const recipient = await key();
    w.patchCross(cross, (c) => ({ ...c, feeRecipient: recipient }));
    await runOnce(w.deps({ duties: 'partner-fees' }));
    const data = getCrossDecoder().decode(w.get(cross));
    expect(w.claims[0]!.quoteDestination).toBe(await ata(recipient, data.quoteMint, data.quoteTokenProgram));
    expect(w.claims[0]!.quoteDestination).not.toBe(await ata(w.payer.address, data.quoteMint, data.quoteTokenProgram));
  });
});
