// Devnet proof for the cross_calendar off-chain stack (ROADMAP C6 / W5, T2, S9): a cross bound to a calendar is cleared at the
// session boundary by the keeper, with nobody pressing anything, and the indexer and API show the same thing the chain does.
//
// What runs, as real processes against the deployed programs on devnet:
//   - the API (services/api) and the indexer (services/indexer) on a throwaway Postgres database,
//   - the keeper (services/keeper) scoped with KEEPER_CREATORS to the issuer of the calendar cross only.
// What this script does is only create things and then watch: a calendar whose first session starts a few minutes from now,
// a cross scheduled on that session with a bid on it, and a second cross by another creator on the same session that the
// keeper's scope must leave alone. It never sends a settle, claim or finalize for the issuer's cross.
//
//   DATABASE_URL=postgres://postgres:oc@localhost:55461/d_w5 pnpm --filter @opening-cross/devnet-proofs dp:calendar-live
// The database must exist and be empty of this run's data. Postgres and the Solana RPC (RPC_URL, default public devnet) are the only externals.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { type Address, createKeyPairSignerFromBytes, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  CROSS_CALENDAR_PROGRAM_ADDRESS,
  getCalendarDecoder,
  getCreateCalendarInstruction,
} from '@opening-cross/cross-calendar-client';
import { CROSS_CORE_PROGRAM_ADDRESS, CrossState, OrderSide, buildClaim, buildFinalize, buildPlaceOrder, buildSettleBook, orderAddress } from '@opening-cross/sdk';
import { Evidence, ROOT, rpc } from './lib.js';
import { crossView, ensureFeeRecipientAccount, prepareLaunch } from './cross-helpers.js';
import { accountData, balanceOf, chainTime, freshFunder, fundWallets, mintTo, newMint, send, sleep, sweepBack, waitUntil } from './kit.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (an empty Postgres database for this run)');
  process.exit(2);
}
const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const PORT = Number(process.env.API_PORT ?? 8473);
const API = `http://127.0.0.1:${PORT}`;
const WEEK = 7n * 24n * 3600n;
const LEAD = 360n; // seconds from now to the first session start: time for the indexer to catch the cross before the keeper has to act

const ev = new Evidence('W5-calendar-live.md', 'Devnet proof: the calendar-driven keeper trigger, indexer and API (W5, T2, S9)', [
  'Script `tests/devnet/src/calendar-live-proof.ts` (`dp:calendar-live`). Real devnet transactions. The API, indexer and keeper run as separate processes (`services/*/src/main.ts`, `services/keeper` with `KEEPER_CREATORS` set to the issuer) against a throwaway Postgres database.',
  `Programs: cross_calendar \`${CROSS_CALENDAR_PROGRAM_ADDRESS}\`, cross_core \`${CROSS_CORE_PROGRAM_ADDRESS}\`. Issuer, second creator, bidder and keeper are throwaway keys funded from the devnet promiser key and swept back afterwards.`,
  '',
  'The script sends no settle, claim or finalize for the issuer\'s cross: those come from the keeper process. The indexer starts from the newest cross_core signature at the start of the run (a checkpoint, not a backfill of devnet history); because orders by others on older crosses then arrive without their cross, the orders foreign key is dropped in this throwaway database; the cross_calendar history is read from the beginning, so earlier calendars from the C6 proof appear too.',
]);

const children: ChildProcess[] = [];
const logs = { keeper: [] as string[], indexer: [] as string[], api: [] as string[] };
let cleanup: (() => Promise<void>) | undefined;

function start(name: keyof typeof logs, cwd: string, env: Record<string, string>, entry = 'src/main.ts'): ChildProcess {
  const p = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: `${ROOT}${cwd}`, env: { ...process.env, DATABASE_URL, RPC_URL, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (d: Buffer) => logs[name].push(...d.toString().split(/\r?\n/).filter(Boolean));
  p.stdout!.on('data', keep);
  p.stderr!.on('data', keep);
  children.push(p);
  return p;
}
const stopAll = () => {
  for (const p of children) if (!p.killed && p.exitCode === null) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
};

async function api<T = any>(path: string): Promise<{ status: number; body: T }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}${path}`);
      return { status: res.status, body: (await res.json()) as T };
    } catch (e) {
      if (attempt > 5) throw e;
      await sleep(1_000);
    }
  }
}
async function until<T>(what: string, ms: number, probe: () => Promise<T | null | false>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(3_000);
  }
}
const pgScript = (sql: string) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', `import pg from 'pg'; const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); await c.query(${JSON.stringify(sql)}); await c.end();`], {
    cwd: `${ROOT}services/indexer`,
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });

/** A throwaway wallet whose key is kept in the git-ignored key folder, so what it does not spend can be swept back. */
async function throwaway(role: string) {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const bytes = new Uint8Array([...pkcs8.slice(-32), ...raw]);
  const file = `${ROOT}.keys/devnet-w5-${role}.json`;
  writeFileSync(file, JSON.stringify([...bytes]));
  return { signer: await createKeyPairSignerFromBytes(bytes), file };
}

async function calendarAddress(admin: Address, id: bigint): Promise<Address> {
  const id8 = new Uint8Array(8);
  new DataView(id8.buffer).setBigUint64(0, id, true);
  return (await getProgramDerivedAddress({ programAddress: CROSS_CALENDAR_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('calendar'), getAddressEncoder().encode(admin), id8] }))[0];
}

async function main() {
  const { funder: issuer, promiser } = await freshFunder(450_000_000n);
  const [aliceW, otherW, keeperW] = await Promise.all([throwaway('bidder'), throwaway('creator2'), throwaway('keeper')]);
  const [alice, other, keeperSigner] = [aliceW.signer, otherW.signer, keeperW.signer];
  const keeperKeyFile = keeperW.file;
  cleanup = async () => {
    stopAll();
    let back = 0n;
    for (const w of [alice, other, keeperSigner, issuer]) back += await sweepBack(w, promiser).catch(() => 0n);
    ev.check('cleanup', 'unused devnet SOL returned to the promiser key and the processes stopped', true, `${back} lamports returned`);
  };
  await fundWallets(issuer, [alice.address], 10_000_000n);
  await fundWallets(issuer, [other.address], 95_000_000n);
  await fundWallets(issuer, [keeperSigner.address], 40_000_000n);

  // ---- 1. The API (it runs the migrations), then the indexer from a checkpoint.
  // server.ts does not register the calendar routes yet (the coordinator wires them), so the API is started through the entry that does.
  start('api', 'services/api', { PORT: String(PORT), HOST: '127.0.0.1', NETWORK: 'devnet' }, 'src/routes/calendar-serve.ts');
  await until('the API to answer', 120_000, async () => (await api('/v1/health')).status === 200 && true);
  const empty = await api('/v1/calendar');
  ev.check('api-before-index', 'GET /v1/calendar answers on an empty index with an empty list, not an error', empty.status === 200 && Array.isArray(empty.body.calendars) && empty.body.calendars.length === 0, `status ${empty.status}, ${empty.body.calendars?.length} calendars, network ${empty.body.network}`);
  const latest = await rpc.getSignaturesForAddress(CROSS_CORE_PROGRAM_ADDRESS, { limit: 1, commitment: 'finalized' }).send();
  const checkpoint = latest[0]!;
  const seeded = pgScript(`INSERT INTO cursors (source, last_signature, last_slot) VALUES ('rpc:${CROSS_CORE_PROGRAM_ADDRESS}', '${checkpoint.signature}', ${checkpoint.slot}) ON CONFLICT (source) DO NOTHING`);
  if (seeded.status !== 0) throw new Error(`could not seed the cross_core cursor: ${seeded.stderr}`);
  // The index starts at a checkpoint, so it never sees the CrossCreated of crosses made before it, yet other people's orders on
  // those crosses keep arriving on the shared devnet program; with the foreign key in place the first one stops ingestion for good.
  // In this throwaway database the constraint is dropped, so such orders land beside no cross and are ignored; everything about the
  // crosses of this run is unaffected, because their CrossCreated is after the checkpoint.
  const relaxed = pgScript('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_cross_address_fkey');
  if (relaxed.status !== 0) throw new Error(`could not relax the orders constraint: ${relaxed.stderr}`);
  start('indexer', 'services/indexer', { POLL_MS: '5000' });

  // ---- 2. A calendar whose first session starts in a few minutes, a cross scheduled on it, a bid, and a cross the keeper must not touch.
  const t0 = await chainTime();
  const first = t0 + LEAD;
  const sessions = [{ startTs: first, endTs: first + 900n }, { startTs: first + 86_400n, endTs: first + 86_400n + 900n }];
  const id = BigInt(Date.now());
  const cal = await calendarAddress(issuer.address, id);
  const calSig = await send([getCreateCalendarInstruction({ admin: issuer, calendar: cal, id, timelockSecs: WEEK, sessions, feeds: [] })], issuer);
  const c0 = getCalendarDecoder().decode(await accountData(cal));
  ev.check('calendar-create', 'a calendar with two sessions is created; the first starts in about five minutes', c0.sessions.length === 2 && c0.sessions[0]!.startTs === first, `calendar ${cal}; first session ${first} (chain time ${t0}), second ${sessions[1]!.startTs}`, calSig);

  const quoteMint = await newMint(issuer, issuer.address);
  await mintTo(issuer, quoteMint, issuer.address, issuer, 1_000_000_000_000n);
  await mintTo(issuer, quoteMint, alice.address, issuer, 10_000_000_000n);
  const mine = await prepareLaunch({ issuer, quoteMint, closeTs: first, calendar: cal });
  const crossSig = await send([mine.built.create, ...mine.built.shards], issuer);
  const view = await crossView(mine.cross);
  ev.check('cross-create', 'a cross scheduled on that session is created and records the calendar', view.data.calendar.__option === 'Some' && view.data.calendar.value === cal && view.data.closeTs === first, `cross ${mine.cross}, closes ${first}`, crossSig);
  const bidSig = await send([await buildPlaceOrder({ cross: view, owner: alice, nonce: 0n, side: OrderSide.Buy, price: 1_200_000n, quantity: 400_000_000n })], alice);
  ev.check('bid', 'a bid is placed while the call is open', true, `order ${await orderAddress(mine.cross, alice.address, 0n)}`, bidSig);
  // The second creator launches against the same quote mint and needs a quote token account of its own (the program requires `creator_quote`).
  await mintTo(issuer, quoteMint, other.address, issuer, 1_000_000_000n);
  const theirs = await prepareLaunch({ issuer: other, quoteMint, closeTs: first, calendar: cal });
  const theirSig = await send([theirs.built.create, ...theirs.built.shards], other);
  ev.check('foreign-cross', 'a second creator schedules a cross on the same session (outside the keeper\'s scope)', (await crossView(theirs.cross)).data.state === CrossState.Live, `cross ${theirs.cross}`, theirSig);
  await ensureFeeRecipientAccount(issuer, quoteMint);

  // ---- 3. The keeper, scoped to the issuer. Its discovery is the indexer's tables, as in production.
  start('keeper', 'services/keeper', { KEEPER_KEYPAIR: keeperKeyFile, KEEPER_CREATORS: issuer.address, PASS_MS: '10000' });

  // ---- 4. The index and the API show the calendar before anything happens.
  const seen = await until('the API to list the calendar with its cross', 240_000, async () => {
    const r = await api(`/v1/calendar/${cal}`);
    return r.status === 200 && r.body.crosses?.some((c: { address: string }) => c.address === mine.cross) && r.body.indexInSync === true ? r.body : null;
  });
  ev.check('api-before', 'before the boundary the API shows the calendar closed, the first session as next, the index equal to the chain, and the cross bound to that session',
    seen.state === 'closed' && seen.next?.startTs === String(first) && seen.verified === true && seen.indexInSync === true && seen.halted === false && seen.sessions.length === 2
      && seen.crosses.find((c: { address: string }) => c.address === mine.cross)?.session?.startTs === String(first),
    `state ${seen.state}, next ${seen.next?.startTs}, ${seen.crosses.length} cross(es), events ${seen.events.map((e: { name: string }) => e.name).join(',')}, as of ${seen.asOf}`);
  const list = await api('/v1/calendar');
  const mineInList = list.body.calendars.find((c: { address: string }) => c.address === cal);
  ev.check('api-list', 'GET /v1/calendar lists it too; the list is built from the index and re-read from chain', Boolean(mineInList) && mineInList.verified === true && list.body.network === 'devnet', `${list.body.calendars.length} calendar(s) listed; ours: ${JSON.stringify({ state: mineInList?.state, next: mineInList?.next?.startTs })}`);
  const evt = seen.events.find((e: { name: string }) => e.name === 'CalendarUpdated');
  ev.check('indexed-event', 'the creation event is in the index under the creation transaction', evt?.signature === calSig, `CalendarUpdated ${evt?.signature?.slice(0, 12)}…`);

  // ---- 5. The boundary. The program refuses a settle before the cross's time, so what is worth measuring is how soon after it the keeper acts.
  const skew = Math.floor(Date.now() / 1000) - Number(await chainTime()); // this machine's clock minus the cluster's, to place keeper log lines against the boundary
  await waitUntil(first);
  const cleared = await until('the keeper to clear the cross', 150_000, async () => {
    const v = await crossView(mine.cross);
    return v.data.state !== CrossState.Live ? v : null;
  });
  const clearing = cleared.data.clearing.__option === 'Some' ? cleared.data.clearing.value : null;
  // The keeper logs a pass when it ends, after the claims and the finalize that follow the clearing, so the line arrives later than the clearing does.
  const trigger = await until('the keeper to log the calendar trigger', 240_000, async () =>
    logs.keeper.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.calendarTrigger?.cross === mine.cross)?.calendarTrigger ?? null,
  ).catch(() => undefined);
  const clearTx = trigger ? await rpc.getTransaction(trigger.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send() : null;
  const lag = clearTx?.blockTime ? Number(clearTx.blockTime) - Number(first) : null;
  const wakes = logs.keeper.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l?.calendarWake);
  const lastWake = wakes.filter((w) => Date.parse(w.at) / 1000 - skew < Number(first)).at(-1);
  ev.check('keeper-wake', 'before the boundary the keeper shortened its sleep to wake at the session start instead of waiting out a full pass', Boolean(lastWake) && lastWake.calendarWake.sleepMs <= 10_000 && lastWake.calendarWake.watching >= 1,
    lastWake ? `${wakes.length} wake line(s); the last one before the boundary: ${JSON.stringify(lastWake)}` : `no calendarWake line before the boundary; keeper log tail: ${logs.keeper.slice(-4).join(' | ').slice(0, 500)}`);
  ev.check('keeper-cleared', 'the keeper cleared the cross within a minute of the session start with nobody pressing anything; its log names the calendar session', cleared.data.state !== CrossState.Live && clearing !== null && trigger?.sessionStartTs === String(first) && trigger?.calendar === cal && lag !== null && lag >= 0 && lag <= 60,
    `state ${cleared.data.state}, P* ${clearing?.price}, matched ${clearing?.matched}; cleared ${lag}s after the boundary (block time of the keeper's settle); log: ${JSON.stringify(trigger)}`, trigger?.signature);

  const finalized = await until('the keeper to finish the cross', 240_000, async () => {
    const v = await crossView(mine.cross);
    return v.data.state === CrossState.Finalized ? v : null;
  });
  const got = await balanceOf(alice.address, mine.baseMint);
  ev.check('keeper-finalized', 'the keeper then paid the bidder its fill and finalized the cross', finalized.data.state === CrossState.Finalized && got > 0n, `alice holds ${got} base atoms; cross state Finalized`);

  // ---- 6. The scope. The other creator's cross, on the same session and past its time, was not touched.
  const foreign = await crossView(theirs.cross);
  const keeperTouchedForeign = logs.keeper.some((l) => l.includes(theirs.cross));
  ev.check('scope', 'the other creator\'s cross on the same session is still Live after the keeper finished its own: KEEPER_CREATORS is respected', foreign.data.state === CrossState.Live && !keeperTouchedForeign, `state ${foreign.data.state}; keeper log mentions it: ${keeperTouchedForeign}`);

  // ---- 7. The API after the boundary, against the chain.
  const after = await until('the API to show the cross finalized', 120_000, async () => {
    const r = await api(`/v1/calendar/${cal}`);
    const c = r.body.crosses?.find((x: { address: string }) => x.address === mine.cross);
    return c?.state === 'Finalized' ? r.body : null;
  });
  const apiCross = after.crosses.find((c: { address: string }) => c.address === mine.cross);
  ev.check('api-after', 'after the clearing the API shows the calendar open on the first session and the cross finalized with the chain\'s clearing price', after.state === 'open' && after.current?.startTs === String(first) && apiCross.clearingPrice === String(clearing?.price) && apiCross.matched === String(clearing?.matched),
    `state ${after.state}, current ${after.current?.startTs}-${after.current?.endTs}, cross ${apiCross.state} P* ${apiCross.clearingPrice} matched ${apiCross.matched}, chain P* ${clearing?.price} matched ${clearing?.matched}`);

  // ---- 8. The index equals the chain.
  const rec = spawnSync(process.execPath, ['--import', 'tsx', 'src/calendar-reconcile-cli.ts'], { cwd: `${ROOT}services/indexer`, env: { ...process.env, DATABASE_URL, RPC_URL, WAIT_MS: '8000', ATTEMPTS: '4' }, encoding: 'utf8' });
  let report: { calendarsIndexed: number; calendarsOnChain: number; driftCount: number } | null = null;
  try { report = JSON.parse(rec.stdout); } catch { /* reported below */ }
  ev.check('reconcile', 'the calendar reconciler finds the index equal to every cross_calendar account on chain (zero drift)', rec.status === 0 && report?.driftCount === 0, report ? `${report.calendarsIndexed} calendar(s) indexed, ${report.calendarsOnChain} on chain, ${report.driftCount} drift` : `exit ${rec.status}: ${rec.stderr.slice(0, 300)}`);

  // ---- Tidy up the second creator's cross: it has no orders, so it settles as a no-print and finalizes.
  try {
    for (const ix of await buildSettleBook(await crossView(theirs.cross))) await send([ix], issuer);
    await send([await buildFinalize(await crossView(theirs.cross), issuer)], issuer);
  } catch (e) {
    console.log(`tidy-up of the out-of-scope cross failed (left on devnet): ${String(e).slice(0, 200)}`);
  }
  const alerts = logs.indexer.filter((l) => l.includes('calendarDrift') || l.includes('"error"'));
  ev.check('indexer-log', 'the indexer logged no calendar drift and no error during the run', alerts.length === 0, alerts.length ? alerts.slice(0, 3).join(' | ').slice(0, 400) : `${logs.indexer.length} log line(s)`);
  const errors = logs.keeper.filter((l) => l.includes('"error"') || l.includes('"failed":[{'));
  ev.check('keeper-log', 'the keeper reported no failed step', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ').slice(0, 400) : `${logs.keeper.length} log line(s)`);
}

const done = (error?: unknown) => (cleanup?.() ?? Promise.resolve()).catch((e) => console.error('cleanup failed', e)).finally(() => { stopAll(); ev.write(error); });
main().then(() => done(), (e) => { console.error(e); console.error('--- keeper log tail ---\n' + logs.keeper.slice(-15).join('\n') + '\n--- indexer log tail ---\n' + logs.indexer.slice(-15).join('\n') + '\n--- api log tail ---\n' + logs.api.slice(-8).join('\n')); return done(e); });
