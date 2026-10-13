// The integrity routes over a real database and a scripted chain: indexed crosses and orders, accounts on a fake chain, and an RPC
// that answers from a table of wallet histories. The analysis itself is tested in packages/integrity; here the wiring is: what is
// read, what is cached, who may post a document, and what an unconfigured deployment says.
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Address, generateKeyPair, getAddressFromPublicKey } from '@solana/kit';
import { signDocument } from '@opening-cross/attest';
import { BACKING_SCHEMA, SUPPLY_SCHEMA, TEAM_SCHEMA, type RpcLike } from '@opening-cross/integrity';
import { registerIntegrity } from '../src/routes/integrity.js';
import { RequestError } from '../src/tx.js';
import { Chain, databaseUrl, insertCross, insertOrder, newAddress, openSchema } from './helpers/w2a.js';

const describeDb = databaseUrl ? describe : describe.skip;
if (!databaseUrl) console.warn('integrity.test.ts: SKIPPED; set DATABASE_URL to a Postgres to run it');

const NOW = 1_800_000_000;

/** A scripted RPC: wallets with a first funder, and mints with holders. Counts the calls it answers. */
class FakeRpc implements RpcLike {
  readonly calls: string[] = [];
  readonly funder = new Map<string, string>();
  readonly mints = new Map<string, { supply: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null; holders: { account: string; owner: string; amount: string }[] }>();
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push(method);
    const p0 = params[0] as string;
    switch (method) {
      case 'getSignaturesForAddress':
        return (this.funder.has(p0) ? [{ signature: `fund-${p0}`, err: null }] : []) as T;
      case 'getTransaction': {
        const wallet = p0.replace('fund-', '');
        const from = this.funder.get(wallet)!;
        return { blockTime: 100, meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: from, destination: wallet, lamports: 1_000_000 } } }] } } } as T;
      }
      case 'getAccountInfo': {
        const m = this.mints.get(p0);
        return { value: m ? { owner: 'Tokenkeg', data: { parsed: { type: 'mint', info: { supply: m.supply, decimals: m.decimals, mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority } } } } : null } as T;
      }
      case 'getTokenSupply':
        return { value: { amount: this.mints.get(p0)!.supply, decimals: this.mints.get(p0)!.decimals } } as T;
      case 'getTokenLargestAccounts':
        return { value: this.mints.get(p0)!.holders.map((h) => ({ address: h.account, amount: h.amount })) } as T;
      case 'getMultipleAccounts': {
        const list = p0 as unknown as string[];
        const all = [...this.mints.values()].flatMap((m) => m.holders);
        return { value: list.map((a) => { const h = all.find((x) => x.account === a); return h ? { owner: 'Tokenkeg', lamports: 1, data: { parsed: { info: { owner: h.owner } } } } : null; }) } as T;
      }
      default:
        throw new Error(`unscripted ${method}`);
    }
  }
}

describeDb('integrity routes', () => {
  let db: pg.Pool;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let bare: FastifyInstance;
  const chain = new Chain();
  const rpc = new FakeRpc();
  const attester = { kp: undefined as unknown as CryptoKeyPair, addr: '' };
  const issuer = { kp: undefined as unknown as CryptoKeyPair, addr: '' as Address };

  const get = async (url: string, a: FastifyInstance = app) => {
    const r = await a.inject({ method: 'GET', url });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };
  const post = async (url: string, payload: unknown, a: FastifyInstance = app) => {
    const r = await a.inject({ method: 'POST', url, payload: payload as never });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  };

  beforeAll(async () => {
    ({ db, close } = await openSchema());
    attester.kp = await generateKeyPair();
    attester.addr = await getAddressFromPublicKey(attester.kp.publicKey);
    issuer.kp = await generateKeyPair();
    issuer.addr = await getAddressFromPublicKey(issuer.kp.publicKey);
    const mk = (rpcOpt: RpcLike | null) => {
      const a = Fastify();
      a.setErrorHandler((err, _req, reply) => (err instanceof RequestError ? reply.code(err.status).send({ error: err.message }) : (err as { statusCode?: number }).statusCode ? reply.code((err as { statusCode: number }).statusCode).send({ error: String(err) }) : reply.code(500).send({ error: String(err) })));
      registerIntegrity(a, { db, account: chain.read, clock: () => NOW, network: 'test' }, { rpc: rpcOpt, trustedAttesters: new Set([attester.addr]), serviceFunders: new Set(['FAUCET']) });
      return a;
    };
    app = mk(rpc);
    bare = mk(null);
    await app.ready();
    await bare.ready();
  });
  afterAll(async () => {
    await app.close();
    await bare.close();
    await close();
  });

  /** A finalized cross with the given orders; funders are scripted for every owner. */
  async function scenario(owners: { who: string; side: 'buy' | 'sell'; qty: bigint; funder?: string }[], over: { creator?: string; proceedsTo?: string; mint?: string; state?: string } = {}) {
    const mint = over.mint ?? (await newAddress());
    const creator = over.creator ?? issuer.addr;
    const cross = await chain.putCross({ creator, proceedsTo: over.proceedsTo ?? creator, baseMint: mint, kind: 1, ordersTotal: owners.length, protocolFeeBps: 5 });
    await insertCross(db, cross, { state: over.state ?? 'Finalized' });
    await db.query('UPDATE crosses SET creator = $2, base_mint = $3 WHERE address = $1', [cross, creator, mint]);
    let i = 0;
    for (const o of owners) {
      await insertOrder(db, cross, i++, o.who, o.side, 1_500_000n, o.qty);
      if (o.funder) rpc.funder.set(o.who, o.funder);
    }
    await db.query('UPDATE orders SET fill = quantity WHERE cross_address = $1', [cross]);
    return { cross, mint, creator };
  }

  it('flags bidders tied to the issuer, with evidence, and reads each wallet\'s history only once', async () => {
    const child = await newAddress();
    const stranger = await newAddress();
    rpc.funder.set(issuer.addr, 'ISSUERFUNDER');
    const s = await scenario([
      { who: issuer.addr, side: 'sell', qty: 100n },
      { who: child, side: 'buy', qty: 20n, funder: issuer.addr },
      { who: stranger, side: 'buy', qty: 80n, funder: 'SOMEONE' },
    ]);
    const before = rpc.calls.length;
    const r = await get(`/v1/integrity/cross/${s.cross}/conflicts`);
    expect(r.status).toBe(200);
    expect(r.body.perOwner[issuer.addr][0]).toMatchObject({ kind: 'issuer', strength: 'high' });
    expect(r.body.perOwner[child][0]).toMatchObject({ kind: 'funded-by-issuer' });
    expect(r.body.perOwner[stranger]).toBeUndefined();
    expect(r.body.flagged).toMatchObject({ orders: 2, ordersOfTotal: 3, volumeBps: 6000 });
    expect(r.body.funding).toMatchObject({ untraced: 0 });
    expect(rpc.calls.length).toBeGreaterThan(before);
    const cached = (await db.query('SELECT count(*)::int AS n FROM funding_cache')).rows[0].n;
    expect(cached).toBeGreaterThanOrEqual(3);
    // 30 seconds of memo plus the database cache: a clock that has moved on still does not read history again.
    const after = rpc.calls.length;
    await get(`/v1/integrity/cross/${s.cross}/conflicts`);
    expect(rpc.calls.length).toBe(after);
  });

  it('scores a wash injection lower on the organic interval, and calls itself experimental', async () => {
    const honest = [];
    for (let i = 0; i < 6; i++) honest.push({ who: await newAddress(), side: (i % 2 ? 'sell' : 'buy') as 'buy' | 'sell', qty: 100n, funder: `HONEST${i}` });
    const clean = await scenario(honest);
    const a = await get(`/v1/integrity/cross/${clean.cross}/organic`);
    expect(a.body).toMatchObject({ status: 'experimental', lowerBps: 10_000, upperBps: 10_000 });
    const dirty = [...honest];
    for (let i = 0; i < 4; i++) dirty.push({ who: await newAddress(), side: (i % 2 ? 'sell' : 'buy') as 'buy' | 'sell', qty: 150n, funder: 'WASHER' });
    const wash = await scenario(dirty);
    const b = await get(`/v1/integrity/cross/${wash.cross}/organic`);
    expect(b.body.lowerBps).toBeLessThan(a.body.lowerBps);
    expect(b.body.upperBps).toBeLessThan(a.body.upperBps);
    expect(b.body.clusters).toHaveLength(1);
    expect(b.body.crossSideClusters).toHaveLength(1);
    expect(b.body.barsUnmet.length).toBeGreaterThan(0);
  });

  it('does not link wallets through a funder listed as a service', async () => {
    const wallets = [await newAddress(), await newAddress(), await newAddress()];
    const s = await scenario(wallets.map((who, i) => ({ who, side: (i % 2 ? 'sell' : 'buy') as 'buy' | 'sell', qty: 10n, funder: 'FAUCET' })));
    const r = await get(`/v1/integrity/cross/${s.cross}/organic`);
    expect(r.body.clusters).toHaveLength(0);
    expect(r.body.ignoredServices[0]).toMatchObject({ funder: 'FAUCET', why: 'listed as a service' });
    expect(r.body.serviceFundedBps).toBe(10_000);
    expect(r.body.lowerBps).toBe(0); // shown independent: none
  });

  it('answers 404, 400 and 501 the way the rest of the API does', async () => {
    expect((await get(`/v1/integrity/cross/${await newAddress()}/conflicts`)).status).toBe(404);
    expect((await get('/v1/integrity/cross/not-an-address/conflicts')).status).toBe(400);
    expect((await get('/v1/integrity/mint/nope/holders')).status).toBe(400);
    const s = await scenario([{ who: await newAddress(), side: 'buy', qty: 1n, funder: 'X' }]);
    const r = await get(`/v1/integrity/mint/${s.mint}/supply`, bare);
    expect(r.status).toBe(501);
    expect(r.body.error).toMatch(/no RPC configured/);
    expect((await post('/v1/integrity/documents', null)).status).toBe(400);
    expect((await post('/v1/integrity/documents', { body: { schema: 'something/else/v1' } })).status).toBe(400);
  });

  it('labels holders with the facts behind each label, and a team declaration changes a label', async () => {
    const team = await newAddress();
    const holder = await newAddress();
    const mint = await newAddress();
    rpc.mints.set(mint, {
      supply: '1000',
      decimals: 6,
      mintAuthority: issuer.addr,
      freezeAuthority: null,
      holders: [{ account: 'TA-i', owner: issuer.addr, amount: '400' }, { account: 'TA-t', owner: team, amount: '200' }, { account: 'TA-p', owner: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', amount: '150' }, { account: 'TA-h', owner: holder, amount: '50' }],
    });
    rpc.funder.set(holder, 'H');
    let r = await get(`/v1/integrity/mint/${mint}/holders`);
    expect(r.status).toBe(200);
    expect(r.body.holders.map((h: { label: { kind: string } }) => h.label.kind)).toEqual(['issuer', 'wallet', 'protocol', 'wallet']);
    expect(r.body.holders[0].label.basis).toBe('the mint authority of the token');
    expect(r.body.coveredBps).toBe(8000);

    const declaration = await signDocument({ schema: TEAM_SCHEMA, mint, wallets: [team], asOf: NOW - 10 }, issuer.kp);
    expect((await post('/v1/integrity/documents', declaration)).status).toBe(201);
    r = await get(`/v1/integrity/mint/${mint}/holders`);
    expect(r.body.holders[1].label).toMatchObject({ kind: 'team' });
    expect(r.body.holders[1].label.basis).toContain('listed as team by');
    expect(r.body.byKind.team).toMatchObject({ holders: 1, shareBps: 2000 });
  });

  it('accepts a supply declaration only from someone tied to the token, and reconciles it', async () => {
    const mint = await newAddress();
    rpc.mints.set(mint, { supply: '1000', decimals: 6, mintAuthority: issuer.addr, freezeAuthority: null, holders: [{ account: 'TA-1', owner: issuer.addr, amount: '1000' }] });
    const stranger = await generateKeyPair();
    const bad = await signDocument({ schema: SUPPLY_SCHEMA, mint, totalSupply: '1000', asOf: NOW - 5, policy: 'mintable' }, stranger);
    expect((await post('/v1/integrity/documents', bad)).status).toBe(403);
    const forged = { ...(await signDocument({ schema: SUPPLY_SCHEMA, mint, totalSupply: '1000', asOf: NOW - 5, policy: 'mintable' }, issuer.kp)), body: { schema: SUPPLY_SCHEMA, mint, totalSupply: '999999', asOf: NOW - 5, policy: 'mintable' } };
    expect((await post('/v1/integrity/documents', forged)).status).toBe(400);
    const future = await signDocument({ schema: SUPPLY_SCHEMA, mint, totalSupply: '1000', asOf: NOW + 99_999, policy: 'mintable' }, issuer.kp);
    expect((await post('/v1/integrity/documents', future)).status).toBe(400);

    const good = await signDocument({ schema: SUPPLY_SCHEMA, mint, totalSupply: '900', asOf: NOW - 5, policy: 'fixed' }, issuer.kp);
    expect((await post('/v1/integrity/documents', good)).status).toBe(201);
    const r = await get(`/v1/integrity/mint/${mint}/supply`);
    expect(r.body.findings.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(['SUPPLY_DIFFERS', 'FIXED_BUT_MINTABLE']));
    expect(r.body).toMatchObject({ onchainSupply: '1000', declaredSupply: '900' });
    expect(r.body.circulating).toMatchObject({ atoms: '0' });
  });

  it('checks backing: untrusted signers are refused, a trusted one is verified, and the feed lists it', async () => {
    const mint = await newAddress();
    rpc.mints.set(mint, { supply: '1000', decimals: 6, mintAuthority: issuer.addr, freezeAuthority: null, holders: [] });
    expect((await get(`/v1/integrity/mint/${mint}/backing`)).body).toMatchObject({ status: 'unverifiable' });
    const stranger = await generateKeyPair();
    const body = { schema: BACKING_SCHEMA, mint, reserveAtoms: '1000', asOf: NOW - 3600, custodian: 'Example Custody', evidence: 'https://example.invalid/r' };
    expect((await post('/v1/integrity/documents', await signDocument(body, stranger))).status).toBe(403);
    expect((await post('/v1/integrity/documents', await signDocument(body, attester.kp))).status).toBe(201);
    expect((await get(`/v1/integrity/mint/${mint}/backing`)).body).toMatchObject({ status: 'verified', coverageBps: 10_000, custodian: 'Example Custody' });
    // A newer attestation for less covers less.
    expect((await post('/v1/integrity/documents', await signDocument({ ...body, reserveAtoms: '400', asOf: NOW - 60 }, attester.kp))).status).toBe(201);
    expect((await get(`/v1/integrity/mint/${mint}/backing`)).body).toMatchObject({ status: 'undercollateralised', coverageBps: 4000 });
    const feed = await get('/v1/integrity/backing');
    expect(feed.body.tokens.find((t: { mint: string }) => t.mint === mint)).toMatchObject({ status: 'undercollateralised', liveCross: false });
  });

  it('rates a finished cross, records it once, and publishes a track record that makes no claim without outcomes', async () => {
    const owners = [];
    for (let i = 0; i < 8; i++) owners.push({ who: await newAddress(), side: (i % 2 ? 'sell' : 'buy') as 'buy' | 'sell', qty: 100n, funder: `RATE${i}` });
    const s = await scenario(owners);
    rpc.mints.set(s.mint, { supply: '1000', decimals: 6, mintAuthority: null, freezeAuthority: null, holders: [{ account: 'TA-r', owner: owners[0]!.who, amount: '10' }] });
    const r = await get(`/v1/integrity/cross/${s.cross}/rating`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 'v0-unfitted', status: expect.stringMatching(/rated|abstained/) });
    expect(r.body.notFitted).toMatch(/not fitted/);
    await get(`/v1/integrity/cross/${s.cross}/rating`);
    expect((await db.query('SELECT count(*)::int AS n FROM rating_snapshots WHERE cross_address = $1', [s.cross])).rows[0].n).toBe(1);
    const feed = await get('/v1/integrity/ratings');
    expect(feed.body.ratings.some((x: { cross: string }) => x.cross === s.cross)).toBe(true);
    const t = await get('/v1/integrity/ratings/track-record');
    expect(t.body).toMatchObject({ status: 'insufficient-sample', hitRate: null, withOutcome: 0 });
    expect(t.body.statement).toMatch(/No claim is made/);
  });

  it('writes a cited brief and checks claims against the same facts', async () => {
    const owners = [];
    for (let i = 0; i < 4; i++) owners.push({ who: await newAddress(), side: (i % 2 ? 'sell' : 'buy') as 'buy' | 'sell', qty: 100n, funder: `BRIEF${i}` });
    const s = await scenario(owners);
    rpc.mints.set(s.mint, { supply: '1000', decimals: 6, mintAuthority: null, freezeAuthority: null, holders: [] });
    const brief = await get(`/v1/integrity/cross/${s.cross}/brief`);
    expect(brief.status).toBe(200);
    expect(brief.body.generated).toBe('template');
    expect(brief.body.statements[0].text).toMatch(/^This is a reopen cross with 4 orders, currently Finalized, charging a protocol fee of 5 bps\.$/);
    expect(brief.body.statements[0].cites.map((c: { metric: string }) => c.metric)).toContain('cross.protocolFeeBps');
    const checked = await post('/v1/integrity/verify-claims', { cross: s.cross, text: 'The cross had 4 orders. It had 9 orders. Everyone loved it.' });
    expect(checked.body.results.map((x: { verdict: string }) => x.verdict)).toEqual(['supported', 'contradicted']);
    expect(checked.body.unparsed).toEqual(['Everyone loved it.']);
    const structured = await post('/v1/integrity/verify-claims', { cross: s.cross, claims: [{ metric: 'cross.protocolFeeBps', op: '<=', value: '5' }, { metric: 'nonsense', op: '=', value: '1' }] });
    expect(structured.body.results.map((x: { verdict: string }) => x.verdict)).toEqual(['supported', 'unverifiable']);
    expect((await post('/v1/integrity/verify-claims', { cross: s.cross })).status).toBe(400);
    expect((await post('/v1/integrity/verify-claims', { cross: s.cross, claims: [{ metric: 'x', op: '~', value: '1' }] })).status).toBe(400);
  });
});
