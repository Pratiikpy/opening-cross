// Keeper process. RPC_URL and KEEPER_KEYPAIR (a Solana CLI JSON keypair that pays fees) are required;
// DATABASE_URL switches discovery to the indexer. Runs a pass every PASS_MS. Transactions are landed over
// plain HTTP (see send.ts), so no WebSocket endpoint is needed.
//
//   (A blank variable is an unset one: see config.ts.)
//   KEEPER_DUTIES         which optional duties to do: a comma-separated list of refunds, challenges, locks, series, halts, graduation, listings, bounties, backing, partner-fees; or all, none, default.
//                         default = refunds, challenges, halts, graduation, backing. locks (pays for a first token account per owner), series (pays the rent of every cross
//                         it spawns, which is not returned), listings (a slash creates the venue's slash account when it is missing) and bounties (the reward of a claim is paid
//                         to this keeper's wallet) are done only when named. graduation, listings, bounties and backing are the Wave 3D programs: on a cluster without them
//                         discovery finds nothing and they do nothing (docs/HUMAN_TASKS.md H27, H43). partner-fees (claim the protocol's accrued DBC trading fees to the cross's fee recipient,
//                         opening the recipient's two token accounts first) is done only when named.
//   KEEPER_DRY_RUN        1: plan everything, send nothing, and log what would have been sent (the lifecycle of crosses included).
//   KEEPER_MIN_RELEASE    base atoms below which a vesting release waits for more to vest (default 1; the last release is always sent).
//   KEEPER_BREAKER_FEEDS  comma-separated hex Pyth feed ids whose sponsored push-oracle account the keeper may feed to a halt state's circuit breaker.
//   KEEPER_BILLING_URL    the billing service (for example http://billing:8791). When set, the series duty spawns the next cross only for issuers with a paid subscription period
//                         (ADR-0960); settling, claims, refunds, finalizing and lock releases are never conditioned on it. Unset: every series in scope is served.
//   KEEPER_ENTITLEMENT_EXEMPT  comma-separated series authorities served without a subscription (the operator's own issuers).
//   KEEPER_PARTNER_FEE_EVERY_SECS  seconds between two looks at one cross's DBC pool for partner fees (default 3600).
//   KEEPER_MIN_PARTNER_QUOTE / KEEPER_MIN_PARTNER_BASE  accrued atoms below which a partner-fee claim waits (default 1: any accrued fee).
import { readFileSync } from 'node:fs';
import { type Address, createKeyPairSignerFromBytes, fetchEncodedAccount } from '@solana/kit';
import pg from 'pg';
import { createIndexerRpc } from '@opening-cross/indexer';
import { calendarTriggers, createCalendarTrigger, wakeDelayMs, type CalendarWatch } from './calendar.js';
import { parsePriceUpdate, pythFeedAccount } from '@opening-cross/sdk';
import { fetchMintSafety } from '@opening-cross/token-safety';
import { fromIndexer, fromProgramAccounts } from './discovery.js';
import { keeperConfig } from './config.js';
import { keeperScope } from './scope.js';
import { billingEntitlements } from './entitlements.js';
import { mintHaltCheck } from './halt.js';
import { type Deferred, runOnce } from './keeper.js';
import { crossOf } from './plan.js';
import { pollingSender } from './send.js';

const { RPC_URL, KEEPER_KEYPAIR, DATABASE_URL } = process.env;
if (!RPC_URL || !KEEPER_KEYPAIR) {
  console.error('RPC_URL and KEEPER_KEYPAIR are required');
  process.exit(2);
}
// A blank variable is an unset one (config.ts). KEEPER_CREATORS (comma-separated addresses) limits this keeper to crosses made by those creators and by the recurring series
// those creators are the authority of (a spawned cross is created by its series' address: scope.ts).
const cfg = keeperConfig(process.env);
const { passMs, duties, dryRun, minRelease, breakerFeeds, entitlementExempt, partnerFees } = cfg;
const creatorList = cfg.creators;
const scope = creatorList.length ? { creators: creatorList } : {};
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
const entitlement = cfg.billingUrl ? billingEntitlements({ baseUrl: cfg.billingUrl }) : undefined;
console.log(JSON.stringify({ at: new Date().toISOString(), keeper: { duties: [...duties], dryRun, minRelease: minRelease.toString(), breakerFeeds: breakerFeeds.size, entitlements: cfg.billingUrl ?? 'off', partnerFees: duties.has('partner-fees') ? partnerFees.everySecs : 'off' } }));
// Steps found impossible because a mint is halted, kept across passes so they are not re-sent every pass.
const memory = new Map<string, Deferred>();
const fetchAccount = async (a: Address) => {
  const x = await fetchEncodedAccount(rpc, a, { commitment: 'confirmed' });
  return x.exists ? x.data : null;
};
// Whether a mint's pausable extension is paused now (null when it cannot be read): the token-safety package's own MINT_PAUSED risk.
const mintPaused = async (mint: Address): Promise<boolean | null> => {
  const report = await fetchMintSafety(rpc, mint, await clusterNow());
  return report.risks.some((r) => r.code === 'MINT_PAUSED');
};
// A verified update for a breaker's feed: the sponsored push-oracle account of the feed, when the operator named the feed. Nothing posts updates from here.
const priceUpdate = async (feedId: string) => {
  if (!breakerFeeds.has(feedId.toLowerCase())) return null;
  const account = await pythFeedAccount(feedId);
  const data = await fetchAccount(account);
  const parsed = data ? parsePriceUpdate(data) : null;
  return parsed?.fullyVerified ? { account, publishTime: parsed.publishTime } : null;
};
// Crosses scheduled on a cross_calendar close at a session start: the keeper sleeps to that boundary instead of finding them a pass late.
const keeping = keeperScope(creatorList, () => discovery.series(), (e) => console.error(JSON.stringify({ at: new Date().toISOString(), seriesScan: String(e) })));
const calendar = createCalendarTrigger({ ...discovery, fetch: fetchAccount, ...(keeping ? { accept: keeping.accept } : {}) });
let sleepMs = passMs;
// A skip is logged when it first appears or its reason changes, not on every pass.
const reported = new Map<string, string>();

for (;;) {
  sleepMs = passMs;
  // The series of the named authorities, read once a pass: the crosses they spawn are served too.
  await keeping?.refresh();
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
      ...(keeping ? { accept: keeping.accept } : {}),
      ...discovery,
      duties,
      dryRun,
      minRelease,
      ...(entitlement ? { entitlement, entitlementExempt } : {}),
      partnerFees,
      mintPaused,
      priceUpdate,
      now: clusterNow,
      slot: async () => BigInt(await rpc.getSlot({ commitment: 'confirmed' }).send()),
      fetch: fetchAccount,
      send,
    });
    for (const t of calendarTriggers(res, watches)) console.log(JSON.stringify({ at: new Date().toISOString(), calendarTrigger: t }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const settled = new Set(res.done.filter((x) => x.action.kind === 'settle').map((x) => crossOf(x.action) as string));
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
    if (res.done.length || res.failed.length || res.planned.length) console.log(JSON.stringify({ at: new Date().toISOString(), ...res }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    console.error(JSON.stringify({ at: new Date().toISOString(), error: String(e) }));
  }
  await new Promise((r) => setTimeout(r, sleepMs));
}
