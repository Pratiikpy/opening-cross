// Keeper process. RPC_URL and KEEPER_KEYPAIR (a Solana CLI JSON keypair that pays fees) are required;
// DATABASE_URL switches discovery to the indexer. Runs a pass every PASS_MS. Transactions are landed over
// plain HTTP (see send.ts), so no WebSocket endpoint is needed.
import { readFileSync } from 'node:fs';
import { type Address, createKeyPairSignerFromBytes, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc } from '@opening-cross/indexer';
import { calendarTriggers, createCalendarTrigger, wakeDelayMs, type CalendarWatch } from './calendar.js';
import { fromIndexer, fromProgramAccounts } from './discovery.js';
import { mintHaltCheck } from './halt.js';
import { type Deferred, runOnce } from './keeper.js';
import { pollingSender } from './send.js';

const { RPC_URL, KEEPER_KEYPAIR, DATABASE_URL } = process.env;
if (!RPC_URL || !KEEPER_KEYPAIR) {
  console.error('RPC_URL and KEEPER_KEYPAIR are required');
  process.exit(2);
}
const passMs = Number(process.env.PASS_MS ?? 10_000);
// KEEPER_CREATORS (comma-separated addresses) limits this keeper to crosses made by those creators.
const creatorList = (process.env.KEEPER_CREATORS ?? '').split(',').map((a) => a.trim()).filter(Boolean) as Address[];
const creators = creatorList.length ? new Set<string>(creatorList) : null;
const scope = creators ? { creators: creatorList } : {};
const rpc = createIndexerRpc(RPC_URL);
const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(KEEPER_KEYPAIR, 'utf8'))));
const send = pollingSender(rpc, payer);
const discovery = DATABASE_URL ? fromIndexer(new pg.Pool({ connectionString: DATABASE_URL }), scope) : fromProgramAccounts(rpc, undefined, scope);

const clusterNow = async () => {
  const slot = await rpc.getSlot({ commitment: 'confirmed' }).send();
  const t = await rpc.getBlockTime(slot).send();
  return BigInt(t);
};
const mintHalt = mintHaltCheck(rpc, { now: clusterNow });
// Steps found impossible because a mint is halted, kept across passes so they are not re-sent every pass.
const memory = new Map<string, Deferred>();
const fetchAccount = async (a: Address) => {
  const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
  return x.exists ? x.data : null;
};
// Crosses scheduled on a cross_calendar close at a session start: the keeper sleeps to that boundary instead of finding them a pass late.
const calendar = createCalendarTrigger({ ...discovery, fetch: fetchAccount, ...(creators ? { accept: (c) => creators.has(c.creator) } : {}) });
let sleepMs = passMs;
// A skip is logged when it first appears or its reason changes, not on every pass.
const reported = new Map<string, string>();

for (;;) {
  sleepMs = passMs;
  try {
    // A failed look at the calendars must not stop the pass: the ordinary pass clears these crosses on its own clock check.
    let watches: CalendarWatch[] = [];
    try {
      watches = await calendar.scan();
    } catch (e) {
      console.error(JSON.stringify({ at: new Date().toISOString(), calendarScan: String(e) }));
    }
    const res = await runOnce({
      payer,
      mintHalt,
      memory,
      ...(creators ? { accept: (c: { creator: string }) => creators.has(c.creator) } : {}),
      ...discovery,
      now: clusterNow,
      slot: async () => BigInt(await rpc.getSlot({ commitment: 'confirmed' }).send()),
      fetch: fetchAccount,
      send,
    });
    for (const t of calendarTriggers(res, watches)) console.log(JSON.stringify({ at: new Date().toISOString(), calendarTrigger: t }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const settled = new Set(res.done.filter((x) => x.action.kind === 'settle').map((x) => x.action.cross as string));
    sleepMs = wakeDelayMs(watches.filter((w) => !settled.has(w.cross)), await clusterNow(), passMs);
    // Shorter than a pass only when a calendar-bound cross is about to become clearable: say so, so the wait is visible in the log.
    if (sleepMs < passMs) console.log(JSON.stringify({ at: new Date().toISOString(), calendarWake: { sleepMs, watching: watches.length } }));
    // A cross held back for a typed reason (a paused mint, a frozen account) is logged when that appears or changes.
    const live = new Set<string>();
    for (const sk of res.skipped) {
      if (!sk.code) continue;
      live.add(sk.cross);
      if (reported.get(sk.cross) === `${sk.code}|${sk.reason}`) continue;
      reported.set(sk.cross, `${sk.code}|${sk.reason}`);
      console.log(JSON.stringify({ at: new Date().toISOString(), skipped: sk }));
    }
    for (const c of [...reported.keys()]) if (!live.has(c)) reported.delete(c);
    if (res.done.length || res.failed.length) console.log(JSON.stringify({ at: new Date().toISOString(), ...res }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, sleepMs));
}
