// A scoped keeper (KEEPER_CREATORS) serves the crosses of a recurring series whose authority it is scoped to. `spawn_next` makes the series' own address the creator of what it
// spawns (ADR-0456), so a scope that matched only the named creators would spawn a cross and then never clear, claim, refund or finalize it. This reads discovery against a real
// Postgres (when DATABASE_URL is set) and against a program-account scan, and runs the keeper over a series on the in-memory chain with the scope the process builds.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Address, getBase58Decoder } from '@solana/kit';
import { CrossState, SERIES_DISCRIMINATOR, getCrossDecoder, getSeriesDecoder } from '@opening-cross/cross-core-client';
import { crossAddress } from '@opening-cross/sdk';
import { migrate } from '@opening-cross/indexer';
import { fromIndexer, fromProgramAccounts, keeperScope, runOnce } from '../src/index.js';
import { DAY, NOW, World, key } from './helpers/world.js';

describe('keeperScope', () => {
  it('is nothing when no creator is named: the keeper then serves every cross it discovers', () => {
    expect(keeperScope([], async () => [])).toBeNull();
  });

  it('serves a named creator at once, and a series of a named authority once the series have been read', async () => {
    const [issuer, series, stranger] = [await key(), await key(), await key()];
    const scope = keeperScope([issuer], async () => [series])!;
    expect(scope.accept({ creator: issuer })).toBe(true);
    expect(scope.accept({ creator: series })).toBe(false); // not read yet
    await scope.refresh();
    expect(scope.accept({ creator: series })).toBe(true);
    expect(scope.accept({ creator: stranger })).toBe(false);
    expect([...scope.series()]).toEqual([series]);
  });

  it('keeps the last answer when the series cannot be read, and says so', async () => {
    const [issuer, series] = [await key(), await key()];
    let fail = false;
    const errors: unknown[] = [];
    const scope = keeperScope([issuer], async () => {
      if (fail) throw new Error('rpc down');
      return [series];
    }, (e) => errors.push(e))!;
    await scope.refresh();
    fail = true;
    await scope.refresh();
    expect(scope.accept({ creator: series })).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('a scoped keeper over a recurring series', () => {
  /** A series of the scoped authority, one pass to spawn, a trade in the spawned cross, and the clock moved past its close. */
  async function spawnedAndTraded() {
    const w = await World.create();
    const series = await w.series({ startTs: NOW - 2n * DAY, intervalSecs: DAY });
    const first = await runOnce(w.deps({ duties: 'series' }));
    expect(first.done.map((d) => d.action.kind)).toEqual(['spawn-next']);
    const spawned = await crossAddress(series, getSeriesDecoder().decode(w.get(series)).nextIndex - 1n);
    expect(getCrossDecoder().decode(w.get(spawned)).creator).toBe(series); // the program's rule, which the model reproduces
    const order = await w.order(spawned, { side: 'buy', price: 100n });
    w.clock += 700n;
    return { w, series, spawned, order };
  }

  it('clears, claims and finalizes what the series spawned, when the scope is the issuer\'s wallet and the process builds its scope', async () => {
    const { w, series, spawned, order } = await spawnedAndTraded();
    const scope = keeperScope([w.payer.address], async () => [series])!;
    await scope.refresh();
    const r = await runOnce(w.deps({ duties: 'refunds', accept: scope.accept }));
    expect(r.failed).toEqual([]);
    expect(r.done.map((d) => d.action.kind)).toEqual(['settle', 'claim', 'finalize']);
    expect(getCrossDecoder().decode(w.get(spawned)).state).toBe(CrossState.Finalized);
    expect(w.accounts.has(order)).toBe(false); // the buyer's order was paid out or refunded
  });

  it('is what was missing: a scope that matches only the named wallets never touches the spawned cross, and its buyers are left waiting', async () => {
    const { w, spawned, order } = await spawnedAndTraded();
    const named = new Set<string>([w.payer.address]);
    const r = await runOnce(w.deps({ duties: 'refunds', accept: (c) => named.has(c.creator) }));
    expect(r.done).toEqual([]);
    expect(getCrossDecoder().decode(w.get(spawned)).state).toBe(CrossState.Live);
    expect(w.accounts.has(order)).toBe(true);
  });

  it('does not serve the crosses of a series whose authority is not in scope', async () => {
    const { w, spawned } = await spawnedAndTraded();
    const scope = keeperScope([await key()], async () => [])!; // another issuer's scope; this series is not in it
    await scope.refresh();
    const r = await runOnce(w.deps({ duties: 'refunds', accept: scope.accept }));
    expect(r.done).toEqual([]);
    expect(getCrossDecoder().decode(w.get(spawned)).state).toBe(CrossState.Live);
  });
});

describe('discovery follows the scope to the series\' crosses', () => {
  const databaseUrl = process.env.DATABASE_URL;
  const describeDb = databaseUrl ? describe : describe.skip;
  if (!databaseUrl) console.warn('scope.test.ts: the Postgres discovery tests are SKIPPED; set DATABASE_URL to a Postgres to run them');

  describeDb('the indexer queries (real Postgres)', () => {
    let db: pg.Pool;
    let drop: () => Promise<void>;
    let issuer: Address;
    let series: Address;
    let directCross: Address;
    let spawnedCross: Address;
    let strangerCross: Address;
    let otherSeriesCross: Address;

    const insertCross = (address: string, creator: string, state: string, slot: number) =>
      db.query(
        `INSERT INTO crosses (address, creator, kind, supply_mode, disclosure, base_mint, quote_mint, open_ts, close_ts, reveal_end_ts, protocol_fee_bps, integrator_fee_bps, state, created_slot, updated_slot)
         VALUES ($1,$2,3,0,1,'b','q',1,2,2,5,0,$3,$4,$4)`,
        [address, creator, state, slot],
      );

    beforeAll(async () => {
      const schema = `t_${randomBytes(6).toString('hex')}`;
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
      await migrate(db);
      drop = async () => {
        await db.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      };
      [issuer, series, directCross, spawnedCross, strangerCross, otherSeriesCross] = await Promise.all([key(), key(), key(), key(), key(), key()]);
      const [stranger, otherSeries] = [await key(), await key()];
      await db.query(`INSERT INTO series (address, authority, created_slot) VALUES ($1,$2,1), ($3,$4,2)`, [series, issuer, otherSeries, stranger]);
      await insertCross(directCross, issuer, 'Live', 10);
      await insertCross(spawnedCross, series, 'Cleared', 11);
      await insertCross(strangerCross, stranger, 'Live', 12);
      await insertCross(otherSeriesCross, otherSeries, 'Live', 13);
    });
    afterAll(async () => {
      await drop?.();
    });

    it('a scoped keeper discovers its issuer\'s crosses and the crosses its issuer\'s series spawned, and nobody else\'s', async () => {
      const found = await fromIndexer(db, { creators: [issuer] }).crosses();
      expect(new Set(found)).toEqual(new Set([directCross, spawnedCross]));
    });

    it('an unscoped keeper discovers all of them', async () => {
      expect(new Set(await fromIndexer(db).crosses())).toEqual(new Set([directCross, spawnedCross, strangerCross, otherSeriesCross]));
    });

    it('the partner-fee candidates follow the same scope, finalized crosses included', async () => {
      await db.query(`UPDATE crosses SET state = 'Finalized' WHERE address = $1`, [spawnedCross]);
      expect(await fromIndexer(db, { creators: [issuer] }).partnerCrosses()).toEqual([spawnedCross]);
    });

    it('the series the scope names are those of the named authorities', async () => {
      expect(await fromIndexer(db, { creators: [issuer] }).series()).toEqual([series]);
    });
  });

  it('a program-account scan asks for the series of each named authority and then for the crosses of the authority and of each series', async () => {
    const [issuer, series] = [await key(), await key()];
    const seriesDiscriminator = getBase58Decoder().decode(SERIES_DISCRIMINATOR as Uint8Array);
    const creatorsAsked: string[] = [];
    const rpc = {
      getProgramAccounts: (_program: string, o: { filters: { memcmp: { offset: bigint; bytes: string } }[] }) => ({
        send: async () => {
          const creator = o.filters.find((f) => f.memcmp.offset === 8n)?.memcmp.bytes;
          const isSeriesScan = o.filters[0]!.memcmp.bytes === seriesDiscriminator;
          if (creator && !isSeriesScan) creatorsAsked.push(creator);
          // Only the series scan of the issuer finds anything: the issuer's series.
          return isSeriesScan && creator === issuer ? [{ pubkey: series }] : [];
        },
      }),
    };
    await fromProgramAccounts(rpc as never, undefined, { creators: [issuer] }).crosses();
    expect(creatorsAsked.sort()).toEqual([issuer, series].sort()); // the issuer's own crosses, and those the series spawned
  });
});
