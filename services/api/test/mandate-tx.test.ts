// cross_mandate over HTTP with accounts injected in memory: the release gate (a program that is not on the cluster refuses every route and every read says so),
// the refusals that come before a transaction (limits, who may sign, the vault, the rent float, the share limit), and every built transaction decoded back to
// its instruction. The program itself is not run here (tests/core/test/mandate.test.ts runs it against the real cross_core).
import { beforeAll, describe, expect, it } from 'vitest';
import { type Address } from '@solana/kit';
import {
  AllowKind,
  CANCEL_ORDER_DISCRIMINATOR,
  CREATE_MANDATE_DISCRIMINATOR,
  FUND_DISCRIMINATOR,
  PLACE_ORDER_DISCRIMINATOR,
  REVEAL_ORDER_DISCRIMINATOR,
  REVOKE_DISCRIMINATOR,
  SET_LIMITS_DISCRIMINATOR,
  SWEEP_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR,
  WITHDRAW_LAMPORTS_DISCRIMINATOR,
  getCreateMandateInstructionDataDecoder,
  getFundInstructionDataDecoder,
  getMandateEncoder,
  getPlaceOrderInstructionDataDecoder,
  getWithdrawInstructionDataDecoder,
} from '@opening-cross/cross-mandate-client';
import { CROSS_MANDATE_PROGRAM_ADDRESS, CROSS_CORE_PROGRAM_ADDRESS, CrossState, Disclosure, MANDATE_MIN_SIGNER_LAMPORTS, ata, inspectMandateAgentTransaction, mandateAddresses, orderAddress } from '@opening-cross/sdk';
import { registerMandateTx } from '../src/routes/mandate-tx.js';
import { type Db } from '../src/routes/programs-support.js';
import { Chain, NOW, SPL, T22, caller, database, decode, key, ready, releaseOf, server, startsWith } from './helpers/wave3d.js';

const EXPIRES = NOW + 30 * 86_400;
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(opts: { lamports?: bigint | undefined } = {}) {
  const chain = new Chain();
  const [owner, agent, creator, quote, base, stranger] = await Promise.all([key(), key(), key(), key(), key(), key()]);
  chain.mint(quote, { decimals: 6 });
  chain.mint(base, { decimals: 6, supply: 1_000_000_000n });
  chain.deploy('crossMandate');
  const { mandate, signer, vault } = await mandateAddresses(owner, 0n, quote, SPL);
  const putMandate = (o: Partial<{ revoked: boolean; expiresAt: number; maxPerOrder: bigint; totalCap: bigint; committed: bigint; maxShareBps: number; allow: { kind: AllowKind; key: Address }[] }> = {}) =>
    chain.put(
      mandate,
      CROSS_MANDATE_PROGRAM_ADDRESS,
      getMandateEncoder().encode({
        owner, agent, id: 0n, quoteMint: quote, quoteTokenProgram: SPL, maxPerOrder: o.maxPerOrder ?? 1_000_000_000n, totalCap: o.totalCap ?? 5_000_000_000n, committed: o.committed ?? 0n, maxShareBps: o.maxShareBps ?? 2_500,
        expiresAt: BigInt(o.expiresAt ?? EXPIRES), revoked: o.revoked ?? false, allow: o.allow ?? [{ kind: AllowKind.Creator, key: creator }], bump: 1, signerBump: 1,
      }),
    );
  putMandate();
  await chain.token(owner, quote, 10_000_000_000n);
  chain.tokenAt(vault, signer, quote, 4_000_000_000n);
  const cross = await chain.cross({ creator, quoteMint: quote, baseMint: base, ext: { totalSupply: 1_000_000_000n } });
  const app = server();
  registerMandateTx(app, { account: chain.account, lifetime: chain.lifetime, clock: () => NOW, gate: ready, lamports: async () => opts.lamports ?? MANDATE_MIN_SIGNER_LAMPORTS * 3n });
  return { chain, owner, agent, creator, quote, base, stranger, mandate, signer, vault, cross, putMandate, app, ...caller(app) };
}

const LIMITS = (creator: Address) => ({ maxPerOrder: '1000000000', totalCap: '5000000000', maxShareBps: 2500, expiresAt: EXPIRES, allow: [{ kind: 'creator', key: creator }] });
const programIxs = (tx: string) => decode(tx).filter((i) => i.programAddress === CROSS_MANDATE_PROGRAM_ADDRESS);

describe('cross_mandate: the release gate', () => {
  it('refuses every transaction route with PROGRAM_NOT_DEPLOYED when the program is not on the cluster, and says so on the reads', async () => {
    const f = await fixture();
    const app = server();
    const absent = new Chain();
    registerMandateTx(app, { account: absent.account, lifetime: absent.lifetime, clock: () => NOW, db: (await database()).db as Db });
    const c = caller(app);
    const a = f.owner;
    const bodies: [string, Record<string, unknown>][] = [
      ['mandate-create', { owner: a, agent: f.agent, quoteMint: f.quote, limits: LIMITS(f.creator) }],
      ['mandate-fund', { owner: a, mandate: f.mandate, amount: '1' }],
      ['mandate-set-limits', { owner: a, mandate: f.mandate, limits: LIMITS(f.creator) }],
      ['mandate-revoke', { owner: a, mandate: f.mandate }],
      ['mandate-withdraw', { owner: a, mandate: f.mandate }],
      ['mandate-withdraw-lamports', { owner: a, mandate: f.mandate, all: true }],
      ['mandate-sweep', { payer: a, mandate: f.mandate, mint: f.base }],
      ['mandate-place-order', { agent: f.agent, mandate: f.mandate, cross: f.cross, price: '1300000', quantity: '1000' }],
      ['mandate-cancel-order', { caller: a, mandate: f.mandate, cross: f.cross, nonce: '0' }],
      ['mandate-reveal-order', { caller: a, mandate: f.mandate, cross: f.cross, nonce: '0', price: '1', quantity: '1', salt: '00'.repeat(32) }],
    ];
    for (const [route, body] of bodies) {
      const r = await c.post(`/v1/tx/${route}`, body);
      expect(r.status, route).toBe(409);
      expect(r.body.reason, route).toBe('PROGRAM_NOT_DEPLOYED');
      expect(r.body.program).toBe(CROSS_MANDATE_PROGRAM_ADDRESS);
      expect(r.body.error).toMatch(/H27/);
    }
    const one = await c.get(`/v1/mandates/${f.mandate}`);
    expect(one.status).toBe(404);
    expect(one.body.reason).toBe('PROGRAM_NOT_DEPLOYED');
    const list = await c.get('/v1/mandates');
    expect(list.status).toBe(200);
    expect(list.body.mandates).toEqual([]);
    expect(list.body.release.deployed).toBe(false);
    expect(list.body.note).toMatch(/not deployed/);
  }, 30_000);

  it('says the release was not checked, and builds, when the cluster cannot be read', async () => {
    const f = await fixture();
    const app = server();
    registerMandateTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: releaseOf('unknown'), lamports: async () => MANDATE_MIN_SIGNER_LAMPORTS * 3n });
    const r = await caller(app).post('/v1/tx/mandate-revoke', { owner: f.owner, mandate: f.mandate });
    expect(r.status).toBe(200);
    expect(r.body.release.deployed).toBeNull();
  });

  it('reads the program bytes by default: a program with the instruction passes, one without it is refused', async () => {
    const f = await fixture();
    const app = server();
    registerMandateTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, lamports: async () => 0n });
    const c = caller(app);
    // deploy() loaded only create_mandate: revoke is not in the bytes
    const missing = await c.post('/v1/tx/mandate-revoke', { owner: f.owner, mandate: f.mandate });
    expect(missing.status).toBe(409);
    expect(missing.body).toMatchObject({ reason: 'PROGRAM_NOT_DEPLOYED', instruction: 'revoke' });
    f.chain.deploy('crossMandate', [REVOKE_DISCRIMINATOR as Uint8Array]);
    const app2 = server();
    registerMandateTx(app2, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW });
    const ok = await caller(app2).post('/v1/tx/mandate-revoke', { owner: f.owner, mandate: f.mandate });
    expect(ok.status).toBe(200);
    expect(ok.body.release).toMatchObject({ deployed: true, instruction: 'revoke' });
  });
});

describe('cross_mandate: creating and funding', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  it('builds create_mandate with the owner paying, the first free id and the funding in the same transaction', async () => {
    const r = await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: LIMITS(f.creator), fund: { amount: '2000000000', lamports: '50000000' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.id).toBe('1'); // id 0 exists in the fixture
    const next = await mandateAddresses(f.owner, 1n, f.quote, SPL);
    expect(r.body).toMatchObject({ mandate: next.mandate, signer: next.signer, vault: next.vault });
    expect(r.body.signers).toEqual([f.owner]);
    const ixs = programIxs(r.body.transaction);
    expect(ixs.map((i) => (startsWith(i, CREATE_MANDATE_DISCRIMINATOR) ? 'create' : startsWith(i, FUND_DISCRIMINATOR) ? 'fund' : '?'))).toEqual(['create', 'fund']);
    const args = getCreateMandateInstructionDataDecoder().decode(ixs[0]!.data!);
    expect(args).toMatchObject({ id: 1n, limits: { maxPerOrder: 1_000_000_000n, totalCap: 5_000_000_000n, maxShareBps: 2500, expiresAt: BigInt(EXPIRES) } });
    expect(args.limits.allow).toEqual([{ kind: AllowKind.Creator, key: f.creator }]);
    expect(getFundInstructionDataDecoder().decode(ixs[1]!.data!)).toMatchObject({ amount: 2_000_000_000n, lamports: 50_000_000n });
    const accounts = ixs[0]!.accounts!.map((a) => a.address);
    for (const a of [f.owner, f.agent, f.quote, next.mandate, next.signer, next.vault]) expect(accounts).toContain(a);
    expect(r.body.minSignerLamports).toBe(MANDATE_MIN_SIGNER_LAMPORTS.toString());
  });

  it('warns that the agent cannot place an order until the signer account holds SOL, when no SOL is funded', async () => {
    const r = await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: LIMITS(f.creator), id: 7 });
    expect(r.status).toBe(200);
    expect(r.body.note).toMatch(/signer account holds at least/);
  });

  it('refuses limits the program would refuse, each with the program\'s own name, and says which field', async () => {
    const bad = async (patch: Record<string, unknown>) => (await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: { ...LIMITS(f.creator), ...patch }, id: 9 })).body;
    for (const [patch, field] of [
      [{ maxPerOrder: '0' }, 'maxPerOrder'],
      [{ totalCap: '999' }, 'totalCap'],
      [{ maxShareBps: 2501 }, 'maxShareBps'],
      [{ maxShareBps: 0 }, 'maxShareBps'],
      [{ expiresAt: NOW - 1 }, 'expiresAt'],
      [{ allow: [] }, 'allow'],
      [{ allow: Array.from({ length: 9 }, () => ({ kind: 'cross', key: f.cross })) }, 'allow'],
    ] as [Record<string, unknown>, string][]) {
      const b = await bad(patch);
      expect(b.reason, JSON.stringify(patch)).toBe('BAD_LIMITS');
      expect(b.issues.map((i: { field: string }) => i.field)).toContain(field);
    }
    const sameKey = await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.owner, quoteMint: f.quote, limits: LIMITS(f.creator), id: 9 });
    expect(sameKey.status).toBe(422);
    expect(sameKey.body.reason).toBe('AGENT_IS_OWNER');
  });

  it('refuses an id that exists, an unknown quote mint, a quote mint with a transfer hook, and a funding the owner cannot cover', async () => {
    expect((await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: LIMITS(f.creator), id: 0 })).body.reason).toBe('ALREADY_EXISTS');
    expect((await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.agent, quoteMint: await key(), limits: LIMITS(f.creator) })).body.reason).toBe('MINT_NOT_FOUND');
    const hooked = await key();
    const data = new Uint8Array(166 + 4 + 64 + 8);
    data[165] = 1;
    new DataView(data.buffer).setUint16(166, 14, true);
    new DataView(data.buffer).setUint16(168, 64, true);
    data.fill(7, 166 + 4 + 32, 166 + 4 + 64);
    f.chain.put(hooked, T22, data);
    const hook = await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.agent, quoteMint: hooked, limits: LIMITS(f.creator) });
    expect(hook.status).toBe(422);
    expect(hook.body.reason).toBe('MINT_HAS_TRANSFER_HOOK');
    const poor = await f.post('/v1/tx/mandate-create', { owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: LIMITS(f.creator), id: 12, fund: { amount: '99999999999' } });
    expect(poor.status).toBe(422);
    expect(poor.body).toMatchObject({ reason: 'INSUFFICIENT_QUOTE', have: '10000000000' });
  });

  it('rejects malformed input before any chain read: unknown fields, bad addresses, bad kinds', async () => {
    const before = f.chain.reads;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: LIMITS(f.creator), extra: 1 }, /unknown field extra/],
      [{ owner: 'nope', agent: f.agent, quoteMint: f.quote, limits: LIMITS(f.creator) }, /owner must be a base58/],
      [{ owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: { ...LIMITS(f.creator), allow: [{ kind: 'wallet', key: f.creator }] } }, /kind must be/],
      [{ owner: f.owner, agent: f.agent, quoteMint: f.quote, limits: { ...LIMITS(f.creator), maxPerOrder: '-1' } }, /maxPerOrder must be/],
      [{ owner: f.owner, agent: f.agent, quoteMint: f.quote }, /limits must be a JSON object/],
    ];
    for (const [body, error] of cases) {
      const r = await f.post('/v1/tx/mandate-create', body);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(error);
    }
    expect((await f.post('/v1/tx/mandate-create', [] as never)).status).toBe(400);
    expect(f.chain.reads - before).toBeLessThanOrEqual(2 * cases.length); // the release scan reads the program, never the mandate
  });

  it('funds only for the owner, checks the owner\'s balance and builds fund', async () => {
    const f2 = await fixture();
    const ok = await f2.post('/v1/tx/mandate-fund', { owner: f2.owner, mandate: f2.mandate, amount: '1000', lamports: '5' });
    expect(ok.status).toBe(200);
    expect(getFundInstructionDataDecoder().decode(programIxs(ok.body.transaction)[0]!.data!)).toMatchObject({ amount: 1000n, lamports: 5n });
    expect((await f2.post('/v1/tx/mandate-fund', { owner: f2.stranger, mandate: f2.mandate, amount: '1' })).body.reason).toBe('NOT_THE_OWNER');
    expect((await f2.post('/v1/tx/mandate-fund', { owner: f2.owner, mandate: f2.mandate })).body.reason).toBe('NOTHING_TO_DO');
    expect((await f2.post('/v1/tx/mandate-fund', { owner: f2.owner, mandate: f2.mandate, amount: '99999999999999' })).body.reason).toBe('INSUFFICIENT_QUOTE');
    expect((await f2.post('/v1/tx/mandate-fund', { owner: f2.owner, mandate: f2.cross, amount: '1' })).body.reason).toBe('NO_SUCH_MANDATE');
    expect((await f2.post('/v1/tx/mandate-fund', { owner: f2.owner, mandate: await key(), amount: '1' })).status).toBe(404);
  });
});

describe('cross_mandate: limits, revoke, withdraw, sweep', () => {
  it('changes limits for the owner only, never on a revoked mandate, and refuses invalid ones', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/mandate-set-limits', { owner: f.owner, mandate: f.mandate, limits: { ...LIMITS(f.creator), maxPerOrder: '5' } });
    expect(ok.status).toBe(200);
    expect(startsWith(programIxs(ok.body.transaction)[0]!, SET_LIMITS_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/mandate-set-limits', { owner: f.stranger, mandate: f.mandate, limits: LIMITS(f.creator) })).body.reason).toBe('NOT_THE_OWNER');
    expect((await f.post('/v1/tx/mandate-set-limits', { owner: f.owner, mandate: f.mandate, limits: { ...LIMITS(f.creator), totalCap: '1' } })).body.reason).toBe('BAD_LIMITS');
    f.putMandate({ revoked: true });
    expect((await f.post('/v1/tx/mandate-set-limits', { owner: f.owner, mandate: f.mandate, limits: LIMITS(f.creator) })).body.reason).toBe('REVOKED');
  });

  it('revokes once, for the owner, and says it is permanent', async () => {
    const f = await fixture();
    const ok = await f.post('/v1/tx/mandate-revoke', { owner: f.owner, mandate: f.mandate });
    expect(ok.status).toBe(200);
    expect(ok.body.permanent).toBe(true);
    expect(startsWith(programIxs(ok.body.transaction)[0]!, REVOKE_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/mandate-revoke', { owner: f.agent, mandate: f.mandate })).body.reason).toBe('NOT_THE_OWNER');
    f.putMandate({ revoked: true });
    expect((await f.post('/v1/tx/mandate-revoke', { owner: f.owner, mandate: f.mandate })).body.reason).toBe('REVOKED');
  });

  it('withdraws the whole vault by default, any part on request, never more, and works on a revoked and an expired mandate', async () => {
    const f = await fixture();
    const all = await f.post('/v1/tx/mandate-withdraw', { owner: f.owner, mandate: f.mandate });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ amount: '4000000000', remaining: '0' });
    const ixs = decode(all.body.transaction);
    expect(ixs.some((i) => i.programAddress === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')).toBe(true); // the owner's token account is created when missing
    const w = programIxs(all.body.transaction)[0]!;
    expect(startsWith(w, WITHDRAW_DISCRIMINATOR)).toBe(true);
    expect(getWithdrawInstructionDataDecoder().decode(w.data!).amount).toBe(4_000_000_000n);
    expect((await f.post('/v1/tx/mandate-withdraw', { owner: f.owner, mandate: f.mandate, amount: '1' })).body.remaining).toBe('3999999999');
    const over = await f.post('/v1/tx/mandate-withdraw', { owner: f.owner, mandate: f.mandate, amount: '4000000001' });
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ reason: 'OVER_VAULT', held: '4000000000' });
    f.putMandate({ revoked: true, expiresAt: NOW - 10 });
    expect((await f.post('/v1/tx/mandate-withdraw', { owner: f.owner, mandate: f.mandate })).status).toBe(200);
    expect((await f.post('/v1/tx/mandate-withdraw', { owner: f.stranger, mandate: f.mandate })).body.reason).toBe('NOT_THE_OWNER');
    f.chain.tokenAt(f.vault, f.signer, f.quote, 0n);
    expect((await f.post('/v1/tx/mandate-withdraw', { owner: f.owner, mandate: f.mandate })).body.reason).toBe('NOTHING_TO_WITHDRAW');
  });

  it('withdraws SOL from the signer only down to the rent of an empty account, or all of it', async () => {
    const f = await fixture({ lamports: 10_000_000n });
    const partial = await f.post('/v1/tx/mandate-withdraw-lamports', { owner: f.owner, mandate: f.mandate, lamports: '4000000' });
    expect(partial.status).toBe(200);
    expect(startsWith(programIxs(partial.body.transaction)[0]!, WITHDRAW_LAMPORTS_DISCRIMINATOR)).toBe(true);
    const tooMuch = await f.post('/v1/tx/mandate-withdraw-lamports', { owner: f.owner, mandate: f.mandate, lamports: '9999999' });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.reason).toBe('BELOW_RENT_EXEMPT');
    expect((await f.post('/v1/tx/mandate-withdraw-lamports', { owner: f.owner, mandate: f.mandate, lamports: '10000001' })).body.reason).toBe('OVER_BALANCE');
    const all = await f.post('/v1/tx/mandate-withdraw-lamports', { owner: f.owner, mandate: f.mandate, all: true });
    expect(all.body.lamports).toBe('10000000');
  });

  it('sweeps a base token to the owner, creates the owner\'s account first, and never the quote token', async () => {
    const f = await fixture();
    expect((await f.post('/v1/tx/mandate-sweep', { payer: f.stranger, mandate: f.mandate, mint: f.base })).body.reason).toBe('NOTHING_TO_SWEEP');
    await f.chain.token(f.signer, f.base, 777n);
    const ok = await f.post('/v1/tx/mandate-sweep', { payer: f.stranger, mandate: f.mandate, mint: f.base });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ amount: '777', to: f.owner });
    const ixs = decode(ok.body.transaction);
    const sweep = ixs.find((i) => startsWith(i, SWEEP_DISCRIMINATOR))!;
    const destination = await ata(f.owner, f.base, SPL);
    expect(sweep.accounts!.map((a) => a.address)).toContain(destination);
    expect((await f.post('/v1/tx/mandate-sweep', { payer: f.stranger, mandate: f.mandate, mint: f.quote })).body.reason).toBe('QUOTE_STAYS_IN_VAULT');
  });
});

describe('cross_mandate: the agent', () => {
  const place = (f: Fixture, patch: Record<string, unknown> = {}) => f.post('/v1/tx/mandate-place-order', { agent: f.agent, mandate: f.mandate, cross: f.cross, price: '1300000', quantity: '1000000', ...patch });

  it('builds place_order for the agent: the signer PDA owns the order, the vault pays, the first free nonce, the exact cost as escrow', async () => {
    const f = await fixture();
    const r = await place(f);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.signers).toEqual([f.agent]);
    expect(r.body).toMatchObject({ nonce: '0', escrow: '1300000', order: await orderAddress(f.cross, f.signer, 0n), mandate: f.mandate });
    const ix = programIxs(r.body.transaction)[0]!;
    expect(startsWith(ix, PLACE_ORDER_DISCRIMINATOR)).toBe(true);
    expect(getPlaceOrderInstructionDataDecoder().decode(ix.data!)).toMatchObject({ nonce: 0n, escrow: 1_300_000n, price: 1_300_000n, quantity: 1_000_000n });
    const accounts = ix.accounts!.map((a) => a.address);
    for (const a of [f.agent, f.mandate, f.signer, f.vault, f.cross, r.body.order, CROSS_CORE_PROGRAM_ADDRESS]) expect(accounts).toContain(a);
    // the order belongs to the signer PDA, not to the agent: the agent's address is only the signer of the transaction
    expect(accounts).not.toContain(await orderAddress(f.cross, f.agent, 0n));
    expect(r.body.remainingAfter).toEqual({ vault: '3998700000', totalCap: '4998700000' });
  });

  it('takes the next nonce and refuses one that is used', async () => {
    const f = await fixture();
    f.chain.put(await orderAddress(f.cross, f.signer, 0n), CROSS_CORE_PROGRAM_ADDRESS, new Uint8Array(200));
    expect((await place(f)).body.nonce).toBe('1');
    expect((await place(f, { nonce: '0' })).body.reason).toBe('NONCE_USED');
  });

  it('refuses everyone but the agent, with the agent named', async () => {
    const f = await fixture();
    for (const who of [f.owner, f.stranger]) {
      const r = await place(f, { agent: who });
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ reason: 'NOT_THE_AGENT', agent: f.agent });
    }
  });

  it('refuses each limit at its edge with the program\'s own error name', async () => {
    const f = await fixture();
    // per order: 1,000,000,000 allowed; price 1.0 x 1,000,000,000 base = 1,000,000,000 quote
    f.putMandate({ maxPerOrder: 1_300_000n, maxShareBps: 2_500 });
    expect((await place(f)).status).toBe(200);
    expect((await place(f, { quantity: '1000001' })).body.reason).toBe('OVER_PER_ORDER_LIMIT');
    f.putMandate({ totalCap: 2_000_000n, maxPerOrder: 1_300_000n, committed: 700_000n });
    expect((await place(f)).status).toBe(200);
    f.putMandate({ totalCap: 2_000_000n, maxPerOrder: 1_300_000n, committed: 700_001n });
    expect((await place(f)).body.reason).toBe('OVER_TOTAL_CAP');
    f.putMandate({ maxShareBps: 2_500, maxPerOrder: 10_000_000_000n, totalCap: 10_000_000_000n });
    // 25% of the 1,000,000,000 declared supply is 250,000,000 base
    expect((await place(f, { quantity: '250000000', price: '1000000' })).status).toBe(200);
    const over = await place(f, { quantity: '250000001', price: '1000000' });
    expect(over.body.reason).toBe('OVER_SHARE_LIMIT');
    f.putMandate();
    f.chain.tokenAt(f.vault, f.signer, f.quote, 1_299_999n);
    expect((await place(f)).body.reason).toBe('VAULT_TOO_LOW');
    f.chain.tokenAt(f.vault, f.signer, f.quote, 4_000_000_000n);
    f.putMandate({ revoked: true });
    expect((await place(f)).body.reason).toBe('REVOKED');
    f.putMandate({ expiresAt: NOW });
    expect((await place(f)).body.reason).toBe('EXPIRED');
    f.putMandate({ allow: [{ kind: AllowKind.Creator, key: f.stranger }] });
    expect((await place(f)).body.reason).toBe('NOT_ALLOWED');
    f.putMandate({ allow: [{ kind: AllowKind.BaseMint, key: f.base }] });
    expect((await place(f)).status).toBe(200);
    f.putMandate({ allow: [{ kind: AllowKind.Cross, key: f.cross }] });
    expect((await place(f)).status).toBe(200);
  });

  it('refuses a cross in another quote token, a cross that declares no supply, a cross that is not live, and a signer without the rent float', async () => {
    const f = await fixture();
    const otherQuote = await key();
    f.chain.mint(otherQuote);
    const wrong = await f.chain.cross({ creator: f.creator, id: 2n, quoteMint: otherQuote, baseMint: f.base, ext: { totalSupply: 1_000_000_000n } });
    expect((await place(f, { cross: wrong })).body.reason).toBe('WRONG_QUOTE');
    const noSupply = await f.chain.cross({ creator: f.creator, id: 3n, quoteMint: f.quote, baseMint: f.base });
    expect((await place(f, { cross: noSupply })).body.reason).toBe('NO_SUPPLY_REFERENCE');
    const done = await f.chain.cross({ creator: f.creator, id: 4n, quoteMint: f.quote, baseMint: f.base, state: CrossState.Cleared, ext: { totalSupply: 1_000_000_000n } });
    const notLive = await place(f, { cross: done });
    expect(notLive.status).toBe(409);
    expect(notLive.body.reason).toBe('NOT_LIVE');
    const poor = await fixture({ lamports: MANDATE_MIN_SIGNER_LAMPORTS - 1n });
    expect((await place(poor)).body.reason).toBe('NEED_RENT_FUNDING');
    expect((await place(f, { cross: f.mandate })).status).toBe(404);
  });

  it('measures a sealed order by its escrow at the lowest price, needs a salt, and warns about a gated cross', async () => {
    const f = await fixture();
    const sealed = await f.chain.cross({ creator: f.creator, id: 5n, quoteMint: f.quote, baseMint: f.base, disclosure: Disclosure.Sealed, ext: { totalSupply: 1_000_000_000n } });
    const noSalt = await place(f, { cross: sealed, escrow: '100000000' });
    expect(noSalt.status).toBe(400);
    expect(noSalt.body.error).toMatch(/salt/);
    const ok = await place(f, { cross: sealed, escrow: '100000000', salt: 'ab'.repeat(32) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // sealed: price and quantity are not in the instruction, the commitment is
    const data = getPlaceOrderInstructionDataDecoder().decode(programIxs(ok.body.transaction)[0]!.data!);
    expect(data).toMatchObject({ price: 0n, quantity: 0n });
    expect(Buffer.from(data.commitment).toString('hex')).toBe(ok.body.commitment);
    // 1,000,000,000 quote at the minimum price 1.0 could buy 1,000,000,000 base: over 25%
    const over = await place(f, { cross: sealed, escrow: '300000000', salt: 'ab'.repeat(32) });
    expect(over.body.reason).toBe('OVER_SHARE_LIMIT');
    const gateMint = await key();
    const gated = await f.chain.cross({ creator: f.creator, id: 6n, quoteMint: f.quote, baseMint: f.base, gateMint, ext: { totalSupply: 1_000_000_000n } });
    const g = await place(f, { cross: gated });
    expect(g.status).toBe(200);
    expect(g.body.warnings.join(' ')).toMatch(/gated.*pass/);
  });

  it('cancels for the owner or the agent, refunds into the vault, and reveals for either', async () => {
    const f = await fixture();
    const order = await orderAddress(f.cross, f.signer, 0n);
    // an order account: only the discriminator, cross, owner and state matter to the route
    const { getOrderEncoder } = await import('@opening-cross/cross-core-client');
    f.chain.put(order, CROSS_CORE_PROGRAM_ADDRESS, getOrderEncoder().encode({ cross: f.cross, owner: f.signer, nonce: 0n, index: 0, side: 0, state: 0, commitment: new Uint8Array(32), price: 1_300_000n, quantity: 1_000_000n, escrow: 1_300_000n, bump: 1 } as never) as Uint8Array);
    for (const who of [f.owner, f.agent]) {
      const r = await f.post('/v1/tx/mandate-cancel-order', { caller: who, mandate: f.mandate, cross: f.cross, nonce: '0' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.refundTo).toBe(f.vault);
      expect(startsWith(programIxs(r.body.transaction)[0]!, CANCEL_ORDER_DISCRIMINATOR)).toBe(true);
    }
    expect((await f.post('/v1/tx/mandate-cancel-order', { caller: f.stranger, mandate: f.mandate, cross: f.cross, nonce: '0' })).body.reason).toBe('NOT_OWNER_OR_AGENT');
    expect((await f.post('/v1/tx/mandate-cancel-order', { caller: f.owner, mandate: f.mandate, cross: f.cross, nonce: '9' })).body.reason).toBe('NO_SUCH_ORDER');
    const reveal = await f.post('/v1/tx/mandate-reveal-order', { caller: f.agent, mandate: f.mandate, cross: f.cross, nonce: '0', price: '1300000', quantity: '1000000', salt: 'cd'.repeat(32) });
    expect(reveal.status).toBe(200);
    expect(startsWith(programIxs(reveal.body.transaction)[0]!, REVEAL_ORDER_DISCRIMINATOR)).toBe(true);
    expect((await f.post('/v1/tx/mandate-reveal-order', { caller: f.stranger, mandate: f.mandate, cross: f.cross, nonce: '0', price: '1', quantity: '1', salt: 'cd'.repeat(32) })).body.reason).toBe('NOT_OWNER_OR_AGENT');
    expect((await f.post('/v1/tx/mandate-reveal-order', { caller: f.agent, mandate: f.mandate, cross: f.cross, nonce: '0', price: '1', quantity: '1', salt: 'zz' })).status).toBe(400);
  });

  it('the guard an agent host runs: an agent transaction passes, anything else does not', async () => {
    const f = await fixture();
    const order = (await place(f)).body.transaction as string;
    const ok = await f.post('/v1/mandates/check-transaction', { transaction: order });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, issues: [] });
    expect(ok.body.instructions.map((i: { name: string }) => i.name)).toEqual(['place_order']);
    // a withdrawal is the owner's instruction: an agent key never signs it
    const withdrawal = (await f.post('/v1/tx/mandate-withdraw', { owner: f.owner, mandate: f.mandate })).body.transaction as string;
    const bad = await f.post('/v1/mandates/check-transaction', { transaction: withdrawal });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.issues.map((i: { code: string }) => i.code)).toContain('NotAllowed');
    expect((await f.post('/v1/mandates/check-transaction', { transaction: 'AAAA' })).body.ok).toBe(false);
    expect(inspectMandateAgentTransaction(Buffer.from('nonsense').toString('base64')).issues[0]?.code).toBe('Undecodable');
    expect((await f.post('/v1/mandates/check-transaction', {})).status).toBe(400);
  });
});

describe('cross_mandate: reads', () => {
  it('reads a mandate from chain with its balances and says what blocks the agent', async () => {
    const f = await fixture({ lamports: 1n });
    const r = await f.get(`/v1/mandates/${f.mandate}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mandate: f.mandate, owner: f.owner, agent: f.agent, status: 'active', committed: '0', capRemaining: '5000000000', vaultBalance: '4000000000', signerLamports: '1', canPlaceOrder: false, release: { deployed: true } });
    expect(r.body.blockers).toEqual(['signer account needs SOL for order rent']);
    expect(r.body.limits.allow).toEqual([{ kind: 'creator', key: f.creator }]);
    f.putMandate({ revoked: true });
    expect((await f.get(`/v1/mandates/${f.mandate}`)).body.status).toBe('revoked');
    f.putMandate({ expiresAt: NOW - 1 });
    expect((await f.get(`/v1/mandates/${f.mandate}`)).body.status).toBe('expired');
    expect((await f.get(`/v1/mandates/${f.cross}`)).status).toBe(404);
    expect((await f.get('/v1/mandates/not-an-address')).status).toBe(400);
  });

  it('lists from the index, filtered by owner and agent, with the status computed from the clock', async () => {
    const f = await fixture();
    const { db, pg } = await database();
    const app = server();
    registerMandateTx(app, { account: f.chain.account, lifetime: f.chain.lifetime, clock: () => NOW, gate: ready, db: db as Db });
    const c = caller(app);
    await pg.query(`INSERT INTO mandates (address, owner, agent, quote_mint, max_per_order, total_cap, max_share_bps, expires_at, allow, committed, revoked, funded, orders, created_slot, updated_slot) VALUES ($1,$2,$3,$4,10,100,2500,$5,$6,7,false,50,1,5,6), ($7,$8,$3,$4,10,100,2500,$9,'[]',0,true,0,0,4,4)`, [f.mandate, f.owner, f.agent, f.quote, EXPIRES, JSON.stringify([{ kind: 1, key: f.creator }]), f.vault, f.stranger, NOW - 5]);
    const all = await c.get('/v1/mandates');
    expect(all.body.mandates.map((m: { mandate: string }) => m.mandate)).toEqual([f.mandate, f.vault]);
    const mine = await c.get(`/v1/owners/${f.owner}/mandates`);
    expect(mine.body.mandates).toHaveLength(1);
    expect(mine.body.mandates[0]).toMatchObject({ status: 'active', committed: '7', orders: 1, limits: { allow: [{ kind: 'creator', key: f.creator }] } });
    expect((await c.get(`/v1/mandates?agent=${f.agent}`)).body.mandates).toHaveLength(2);
    expect((await c.get(`/v1/mandates?owner=${f.stranger}`)).body.mandates[0]).toMatchObject({ status: 'revoked' });
    await pg.query(`INSERT INTO program_events (signature, seq, slot, program, name, subject, payload) VALUES ('s1',0,9,'cross_mandate','MandateRevoked',$1,'{}')`, [f.mandate]);
    await pg.query(`INSERT INTO mandate_orders (order_address, mandate, cross_address, escrow, slot) VALUES ($1,$2,$3,1300000,8)`, [await orderAddress(f.cross, f.signer, 0n), f.mandate, f.cross]);
    const activity = await c.get(`/v1/mandates/${f.mandate}/activity`);
    expect(activity.body.events.map((e: { name: string }) => e.name)).toEqual(['MandateRevoked']);
    expect(activity.body.orders[0]).toMatchObject({ cross_address: f.cross, escrow: '1300000' });
  }, 30_000);
});
