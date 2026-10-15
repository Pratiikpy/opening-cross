// The routes the Wave 5 packages added, mounted in the real server (`buildServer`) over a real Postgres (PGlite) carrying every one of the indexer's own migrations:
//   * /v1/router/quote prices Meteora pools and merges them (ADR-0921), /v1/pools/* are mounted
//   * /v1/treasuries/:address/movements and /movements/totals (ADR-0930)
//   * /v1/crosses/:address/settlement lists the DAOs and presale tranches a cross opened (ADR-0930)
//   * /v1/crosses/:address/receipt-attestation (ADR-0941)
//   * /v1/gates/presets carries the jurisdiction presets (ADR-0903)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Address } from '@solana/kit';
import { buildServer } from '../src/server.js';

const dir = fileURLToPath(new URL('../../indexer/migrations/', import.meta.url));
type Account = { data: Uint8Array; owner: Address };
const fx = JSON.parse(readFileSync(new URL('../../../packages/router/test/fixtures/devnet-pools.json', import.meta.url), 'utf8')) as { accounts: Record<string, { owner: string; data: string }> };
const accounts = new Map<string, Account>(Object.entries(fx.accounts).map(([k, v]) => [k, { data: new Uint8Array(Buffer.from(v.data, 'base64')), owner: v.owner as Address }]));
// The DAMM v2 pool the fixtures hold, by its two mints.
const A = 'EkisVxYv7x5pJfXUM75WiQC9AgYKy2ps5R3pyTEeovCV';
const B = '7BavPghywmfMMvt7VctXpFvqKCB8kwnXDyA2iZUQzidy';
const DLMM_X = 'AypfHSmpMQ2C1zaGRHRyoYbQBjFA8Wphc7AQrkmCLZXN';
const TREASURY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CROSS = 'ELVKGevyF2qarSYiZHAkRdAkfKruKSgKL7aS9XTrVBK8';
const WALLET = '7MjUeRtbGsXYXQWj8CeW1iKQSMki5xQvNZR8TnJixU1A';
const SIG = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

let db: PGlite;
let app: Awaited<ReturnType<typeof buildServer>>;
const get = async (u: string) => {
  const r = await app.inject({ method: 'GET', url: u });
  return { status: r.statusCode, body: JSON.parse(r.body) as any };
};

beforeAll(async () => {
  db = new PGlite();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await db.exec(readFileSync(dir + f, 'utf8'));
  await db.query(
    `INSERT INTO treasuries (address, coin_mint, authority, allowance, period_secs, created_signature, created_slot, state, updated_slot) VALUES ($1, $2, $3, 1, 1, 'x', 1, 'Active', 1)`,
    [TREASURY, A, WALLET],
  );
  const mv = (n: number, kind: string, direction: string, asset: string, amount: string, team: boolean, slot: number) =>
    db.query(
      `INSERT INTO treasury_movements (signature, seq, slot, block_time, treasury, kind, direction, asset, amount, counterparty, reference, team_outflow, detail)
       VALUES ($1, $2, $3::bigint, to_timestamp(1800000000 + $11::int), $4, $5, $6, $7, $8::numeric, $9, NULL, $10, '{}')`,
      [`${SIG}${n}`, 0, slot, TREASURY, kind, direction, asset, amount, WALLET, team, slot],
    );
  await mv(1, 'spend', 'out', 'quote', '5000000', true, 100);
  await mv(2, 'redemption', 'out', 'quote', '700', false, 101);
  await mv(3, 'distribution_deposit', 'in', 'quote', '9000', false, 102);
  await mv(4, 'spend', 'out', 'quote', '1000000', true, 103);
  await db.query(
    `INSERT INTO settle_futarchy_daos (cross_address, dao, clearing_price, base_amount, quote_amount, signature, slot) VALUES ($1, $2, 1500000, 1000, 2000, $3, 7)`,
    [CROSS, WALLET, SIG],
  );
  app = await buildServer({
    db: db as never,
    account: async (a) => accounts.get(a) ?? null,
    lifetime: async () => ({ blockhash: '4NCYB3kRT8sCNodPNuCZo8VkwveZSHhg7R7mrRBFM1Uy' as never, lastValidBlockHeight: 100n }),
    network: 'devnet',
    promiseSigner: WALLET,
    clock: () => 1_800_000_000,
    w2a: false,
  });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe('GET /v1/router/quote prices Meteora pools', () => {
  it('lists the pool among the venues, executable now, and drops the old "not priced" exclusion', async () => {
    const r = await get(`/v1/router/quote?base=${A}&quote=${B}&side=sell&amount=5000000`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pool = r.body.venues.find((v: { venue: string }) => v.venue === 'meteora-damm-v2');
    expect(pool).toMatchObject({ fill: 'full', executableNow: true });
    expect(BigInt(pool.quoteAtoms)).toBeGreaterThan(0n);
    expect(r.body.best).toMatchObject({ venue: 'meteora-damm-v2' });
    expect(JSON.stringify(r.body.excluded)).not.toContain('does not price Meteora');
  });

  it('pools=0 leaves them out and keeps the earlier statement (GET /v1/pools/route asks that way)', async () => {
    const r = await get(`/v1/router/quote?base=${A}&quote=${B}&side=sell&amount=5000000&pools=0`);
    expect(r.status).toBe(200);
    expect(r.body.venues.some((v: { venue: string }) => v.venue === 'meteora-damm-v2')).toBe(false);
    expect(JSON.stringify(r.body.excluded)).toContain('does not price Meteora');
  });

  it('GET /v1/pools/route returns each pool once, not merged twice', async () => {
    const r = await get(`/v1/pools/route?base=${A}&quote=${B}&side=sell&amount=5000000`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.venues.filter((v: { venue: string }) => v.venue === 'meteora-damm-v2')).toHaveLength(1);
  });

  it('a pair with no pool says so instead of claiming Meteora is not priced', async () => {
    // Two real mints of the fixtures that no pool trades against each other.
    const r = await get(`/v1/router/quote?base=${A}&quote=${DLMM_X}&side=buy&amount=1000000`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.venues.some((v: { venue: string }) => v.venue.startsWith('meteora'))).toBe(false);
    expect(JSON.stringify(r.body.excluded)).not.toContain('does not price Meteora');
    expect(r.body.excluded).toContainEqual({ venue: 'meteora', reason: expect.stringContaining('No Meteora DAMM v2 pool or DLMM pair exists for this pair') });
  });

  it('the same pool serves the reversed pair', async () => {
    const r = await get(`/v1/router/quote?base=${B}&quote=${A}&side=buy&amount=1000000`);
    expect(r.status).toBe(200);
    expect(r.body.venues.some((v: { venue: string }) => v.venue === 'meteora-damm-v2')).toBe(true);
  });
});

describe('GET /v1/treasuries/:address/movements', () => {
  it('lists newest first, pages with `next`, and the filters apply', async () => {
    const all = await get(`/v1/treasuries/${TREASURY}/movements`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.movements.map((m: { kind: string }) => m.kind)).toEqual(['spend', 'distribution_deposit', 'redemption', 'spend']);
    const p1 = await get(`/v1/treasuries/${TREASURY}/movements?limit=3`);
    expect(p1.body.movements).toHaveLength(3);
    const p2 = await get(`/v1/treasuries/${TREASURY}/movements?limit=3&before=${p1.body.next}`);
    expect(p2.body.movements).toHaveLength(1);
    expect(p2.body.next).toBeNull();
    expect((await get(`/v1/treasuries/${TREASURY}/movements?teamOutflow=true`)).body.movements).toHaveLength(2);
    expect((await get(`/v1/treasuries/${TREASURY}/movements?direction=in`)).body.movements.map((m: { kind: string }) => m.kind)).toEqual(['distribution_deposit']);
    expect((await get(`/v1/treasuries/${TREASURY}/movements?kind=redemption,spend&minAmount=1000000`)).body.movements).toHaveLength(2);
    expect((await get(`/v1/treasuries/${TREASURY}/movements?sinceSlot=102`)).body.movements).toHaveLength(2);
  });

  it('refuses a malformed filter with a 400 and the reason', async () => {
    for (const q of ['kind=teleport', 'direction=sideways', 'asset=gold', 'teamOutflow=maybe', 'minAmount=-1', 'sinceSlot=x', 'before=z', 'limit=0', 'limit=999', 'limit=abc', 'counterparty=nope']) {
      const r = await get(`/v1/treasuries/${TREASURY}/movements?${q}`);
      expect(r.status, q).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    expect((await get('/v1/treasuries/notanaddress/movements')).status).toBe(400);
  });

  it('totals by kind, direction and asset, never adding the two assets', async () => {
    const r = await get(`/v1/treasuries/${TREASURY}/movements/totals`);
    expect(r.status).toBe(200);
    expect(r.body.totals).toContainEqual({ kind: 'spend', direction: 'out', asset: 'quote', count: 2, amount: '6000000' });
    expect(r.body.totals).toContainEqual({ kind: 'distribution_deposit', direction: 'in', asset: 'quote', count: 1, amount: '9000' });
    expect((await get(`/v1/treasuries/${TREASURY}/movements/totals?sinceSlot=103`)).body.totals).toEqual([{ kind: 'spend', direction: 'out', asset: 'quote', count: 1, amount: '1000000' }]);
    expect((await get(`/v1/treasuries/${TREASURY}/movements/totals?sinceSlot=x`)).status).toBe(400);
  });
});

describe('GET /v1/crosses/:address/settlement', () => {
  it('lists the futarchy DAOs and presale tranches the cross opened and drops the "nothing opened" note', async () => {
    const r = await get(`/v1/crosses/${CROSS}/settlement`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.futarchyDaos).toEqual([{ dao: WALLET, clearingPrice: '1500000', baseAmount: '1000', quoteAmount: '2000', signature: SIG, slot: '7' }]);
    expect(r.body.presales).toEqual([]);
    expect(r.body.note).toBeUndefined();
  });

  it('a cross that opened nothing still says so', async () => {
    const r = await get(`/v1/crosses/${WALLET}/settlement`);
    expect(r.body).toMatchObject({ futarchyDaos: [], presales: [] });
    expect(r.body.note).toMatch(/No settlement adapter/);
  });
});

describe('GET /v1/crosses/:address/receipt-attestation', () => {
  it('404 when none exists, a soft 200 with ?optional=1, 400 for a bad address', async () => {
    const none = await get(`/v1/crosses/${CROSS}/receipt-attestation`);
    expect(none.status).toBe(404);
    const soft = await get(`/v1/crosses/${CROSS}/receipt-attestation?optional=1`);
    expect(soft.status).toBe(200);
    expect(soft.body).toMatchObject({ cluster: 'devnet', cross: CROSS, attestation: null });
    expect((await get('/v1/crosses/nope/receipt-attestation')).status).toBe(400);
  });
});

describe('GET /v1/gates/presets', () => {
  it('keeps the three gate presets and adds the six jurisdiction templates', async () => {
    const r = await get('/v1/gates/presets');
    expect(r.status).toBe(200);
    expect(r.body.presets.map((p: { id: string }) => p.id)).toEqual(['open', 'allowlist', 'attested-wallet']);
    expect(r.body.jurisdictionPresets.map((p: { id: string }) => p.id)).toEqual(['reg-d-506c', 'reg-s', 'reg-cf', 'mica', 'vara', 'open']);
    for (const p of r.body.jurisdictionPresets) expect(p).toMatchObject({ requiresCounsel: true, rules: expect.any(Object), notes: expect.any(Array), sources: expect.any(Array) });
    const regS = r.body.jurisdictionPresets.find((p: { id: string }) => p.id === 'reg-s');
    expect(regS.rules.countries).toContain('US');
    expect(regS.resaleLockSecs).toBe('31536000');
  });

  it('applies the issuer’s restricted countries and validates its input', async () => {
    const r = await get('/v1/gates/presets?restricted=kp,ir&quoteUnit=1000000');
    expect(r.status).toBe(200);
    expect(r.body.restrictedCountries).toEqual(['KP', 'IR']);
    expect(r.body.jurisdictionPresets.find((p: { id: string }) => p.id === 'reg-s').rules.countries).toEqual(['US', 'KP', 'IR']);
    expect(r.body.jurisdictionPresets.find((p: { id: string }) => p.id === 'reg-cf').rules.defaultCap).toBe('2500000000');
    expect((await get('/v1/gates/presets?restricted=KOREA')).status).toBe(400);
    expect((await get('/v1/gates/presets?quoteUnit=0')).status).toBe(400);
  });
});
