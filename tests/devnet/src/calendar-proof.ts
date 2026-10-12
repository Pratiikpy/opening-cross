// Devnet proof for cross_calendar (ROADMAP C6): sessions, approved oracle feeds and the 7-day timelock, on the
// deployed program, plus a cross_core cross bound to the calendar that must close at a session start.
//
// The timelock cannot be waited out: MIN_TIMELOCK_SECS is a constant of the program (7 days,
// programs/cross_calendar/src/lib.rs) and a calendar with a shorter lock is refused at creation. What a real
// clock can show in minutes is proved here; applying a proposal once its lock has passed is proved in
// tests/core/test/calendar.test.ts with the LiteSVM clock moved forward.
//
//   pnpm --filter @opening-cross/devnet-proofs dp:calendar
import { type Address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import {
  CROSS_CALENDAR_PROGRAM_ADDRESS,
  getApplyAdminInstruction,
  getApplyUpdateInstruction,
  getCalendarDecoder,
  getCancelUpdateInstruction,
  getCreateCalendarInstruction,
  getProposeAdminInstruction,
  getProposeUpdateInstruction,
} from '@opening-cross/cross-calendar-client';
import { CrossState, OrderSide, buildClaim, buildFinalize, buildPlaceOrder, buildSettleBook, orderAddress } from '@opening-cross/sdk';
import { Evidence } from './lib.js';
import { crossView, ensureFeeRecipientAccount, prepareLaunch } from './cross-helpers.js';
import { accountData, balanceOf, chainTime, exists, freshFunder, fundWallets, mintTo, mustFail, mustSucceed, newMint, send, sweepBack, waitUntil } from './kit.js';

const WEEK = 7n * 24n * 3600n;
const FEED = new Uint8Array(32).fill(7);
const OTHER_FEED = new Uint8Array(32).fill(9);
const session = (start: bigint) => ({ startTs: start, endTs: start + 6n * 3600n });

const ev = new Evidence('C6-calendar-devnet.md', 'Devnet proof — cross_calendar sessions, approved feeds and the 7-day timelock (C6)', [
  'Script `tests/devnet/src/calendar-proof.ts` (`dp:calendar`). Real devnet transactions; expected refusals are simulated against the deployed program, so nothing failed is billed or recorded.',
  `Programs: cross_calendar \`${CROSS_CALENDAR_PROGRAM_ADDRESS}\`, cross_core \`F5k8EDDXBF24xgt4Y8MMtwPZFH9TikJvJcNmD1NJQPnZ\`. Admin, stranger and bidder are throwaway keys funded from the devnet promiser key.`,
  '',
  '**The 7-day timelock is a program constant** (`MIN_TIMELOCK_SECS`, `programs/cross_calendar/src/lib.rs`): a calendar with a shorter lock cannot be created, so no devnet calendar can be made to mature in minutes. The program was not changed to make that possible.',
  '',
  'Not covered on devnet: a permissionless `apply_update` / `apply_admin` once the lock has passed (needs 7 real days). It is covered by `tests/core/test/calendar.test.ts`, which moves the LiteSVM clock to one second before and one second after the lock. A cross bound to an approved Pyth feed is shown to be accepted at creation (simulated); settling an oracle-guarded cross is covered by `oracle-pull.ts`.',
]);

let cleanup: (() => Promise<void>) | undefined;

async function calendarAddress(admin: Address, id: bigint): Promise<Address> {
  const id8 = new Uint8Array(8);
  new DataView(id8.buffer).setBigUint64(0, id, true);
  return (await getProgramDerivedAddress({ programAddress: CROSS_CALENDAR_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode('calendar'), getAddressEncoder().encode(admin), id8] }))[0];
}

async function main() {
  const { funder: admin, promiser } = await freshFunder(200_000_000n);
  cleanup = async () => {
    const back = await sweepBack(admin, promiser);
    ev.check('cleanup', 'unused devnet SOL returned to the promiser key', true, `${back} lamports returned`);
  };
  const [stranger, alice] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  await fundWallets(admin, [stranger.address, alice.address], 8_000_000n);

  const id = BigInt(Date.now());
  const cal = await calendarAddress(admin.address, id);
  const read = async () => getCalendarDecoder().decode(await accountData(cal));
  const create = (timelockSecs: bigint, sessions: ReturnType<typeof session>[], calId = id, calendar = cal) =>
    getCreateCalendarInstruction({ admin, calendar, id: calId, timelockSecs, sessions, feeds: [FEED] });

  // 1. Creation rules.
  const t0 = await chainTime();
  const first = t0 + 240n; // the first session opens in four minutes; a cross will close exactly there
  ev.check('refuse-short-lock', `a timelock under seven days (${WEEK - 1n} s) is refused`, true, await mustFail([create(WEEK - 1n, [session(first)])], admin, 'TimelockTooShort'));
  ev.check('refuse-overlap', 'overlapping sessions are refused', true, await mustFail([create(WEEK, [session(first), session(first + 100n)])], admin, 'BadSessions'));
  const createSig = await send([create(WEEK, [session(first), session(first + 86_400n)])], admin);
  const c0 = await read();
  ev.check('create', 'a calendar with a seven-day timelock, two sessions and one approved feed is created', c0.timelockSecs === WEEK && c0.sessions.length === 2 && c0.feeds.length === 1 && c0.admin === admin.address, `calendar ${cal}; sessions ${c0.sessions.map((s) => s.startTs).join(', ')}`, createSig);

  // 2. A cross bound to the calendar must close at a session start and use an approved feed.
  const quoteMint = await newMint(admin, admin.address);
  await mintTo(admin, quoteMint, admin.address, admin, 1_000_000_000_000n);
  await mintTo(admin, quoteMint, alice.address, admin, 10_000_000_000n);
  const real = await prepareLaunch({ issuer: admin, quoteMint, closeTs: first, calendar: cal });
  const off = await prepareLaunch({ issuer: admin, quoteMint, closeTs: first + 1n, calendar: cal });
  ev.check('refuse-off-session', 'a cross bound to the calendar cannot close at a time that is not a session start', true, await mustFail([off.built.create], admin, 'NotACalendarSession'));
  const unapproved = await prepareLaunch({ issuer: admin, quoteMint, closeTs: first, calendar: cal, oracle: { feedId: OTHER_FEED, maxDivergenceBps: 300, maxStalenessSecs: 600 } });
  ev.check('refuse-unapproved-feed', 'a cross cannot pin an oracle feed the calendar has not approved', true, await mustFail([unapproved.built.create], admin, 'FeedNotApproved'));
  const approved = await prepareLaunch({ issuer: admin, quoteMint, closeTs: first, calendar: cal, oracle: { feedId: FEED, maxDivergenceBps: 300, maxStalenessSecs: 600 } });
  ev.check('accept-approved-feed', 'the same cross with the approved feed is accepted', true, await mustSucceed([approved.built.create], admin));
  const crossSig = await send([real.built.create, ...real.built.shards], admin);
  const view = await crossView(real.cross);
  ev.check('calendar-cross', 'a cross closing at the session start is created and records the calendar', view.data.calendar.__option === 'Some' && view.data.calendar.value === cal && view.data.closeTs === first, `cross ${real.cross}, closes ${first}`, crossSig);
  const bidSig = await send([await buildPlaceOrder({ cross: view, owner: alice, nonce: 0n, side: OrderSide.Buy, price: 1_200_000n, quantity: 400_000_000n })], alice);
  ev.check('calendar-bid', 'a bid is accepted while the call is open', await exists(await orderAddress(real.cross, alice.address, 0n)), 'order account exists', bidSig);

  // 3. The timelock, while the cross runs.
  const strangerPropose = getProposeUpdateInstruction({ admin: stranger, calendar: cal, sessions: [], feeds: [] });
  ev.check('refuse-stranger-propose', 'a non-admin cannot propose a change', true, await mustFail([strangerPropose], stranger, 'Unauthorized'));
  const next = [session(first + 3n * 86_400n)];
  const propSig = await send([getProposeUpdateInstruction({ admin, calendar: cal, sessions: next, feeds: [] })], admin);
  const propTime = await chainTime();
  const c1 = await read();
  const pending = c1.pending.__option === 'Some' ? c1.pending.value : null;
  ev.check('propose', 'the admin proposes a new session list; its apply time is the proposal time plus seven days', Boolean(pending) && pending!.eta >= propTime - 30n + WEEK && pending!.eta <= propTime + WEEK, `eta ${pending?.eta} (chain time ${propTime}, +${pending ? pending.eta - propTime : '?'} s)`, propSig);
  ev.check('live-unchanged', 'the live calendar is unchanged while the proposal waits', c1.sessions.length === 2 && c1.sessions[0]!.startTs === first, `${c1.sessions.length} sessions`);
  ev.check('refuse-apply-now', 'anyone applying immediately is refused (TimelockActive)', true, await mustFail([getApplyUpdateInstruction({ calendar: cal })], stranger, 'TimelockActive'));
  const cancelSig = await send([getCancelUpdateInstruction({ admin, calendar: cal })], admin);
  ev.check('cancel', 'the admin cancels the proposal during the wait', (await read()).pending.__option === 'None', 'pending cleared', cancelSig);
  ev.check('refuse-apply-cancelled', 'applying a cancelled proposal is refused (NothingPending)', true, await mustFail([getApplyUpdateInstruction({ calendar: cal })], stranger, 'NothingPending'));
  await send([getProposeUpdateInstruction({ admin, calendar: cal, sessions: [], feeds: [] })], admin); // restarts the lock
  const adminSig = await send([getProposeAdminInstruction({ admin, calendar: cal, newAdmin: stranger.address })], admin);
  const c2 = await read();
  ev.check('propose-admin', 'an admin handover is queued behind the same lock', c2.pendingAdmin.__option === 'Some' && c2.pendingAdmin.value.admin === stranger.address && c2.pendingAdmin.value.eta >= propTime + WEEK, `eta ${c2.pendingAdmin.__option === 'Some' ? c2.pendingAdmin.value.eta : '—'}`, adminSig);
  ev.check('refuse-apply-admin', 'the handover cannot be applied early (TimelockActive)', true, await mustFail([getApplyAdminInstruction({ calendar: cal })], stranger, 'TimelockActive'));

  // 4. Settle the calendar cross at its session start.
  await waitUntil(first + 1n);
  let last = '';
  for (const ix of await buildSettleBook(await crossView(real.cross))) last = await send([ix], admin);
  const cleared = await crossView(real.cross);
  ev.check('calendar-clear', 'the cross clears at the session start', cleared.data.state === CrossState.Cleared && cleared.data.clearing.__option === 'Some', cleared.data.clearing.__option === 'Some' ? `P* ${cleared.data.clearing.value.price}, matched ${cleared.data.clearing.value.matched}` : 'no clearing', last);
  const claimSig = await send(await buildClaim(await crossView(real.cross), admin, alice.address, 0n), admin);
  ev.check('calendar-claim', 'the bidder receives its fill', (await balanceOf(alice.address, real.baseMint)) > 0n, `alice holds ${await balanceOf(alice.address, real.baseMint)} base atoms`, claimSig);
  await ensureFeeRecipientAccount(admin, quoteMint);
  const finSig = await send([await buildFinalize(await crossView(real.cross), admin)], admin);
  ev.check('calendar-finalize', 'the cross finalises', (await crossView(real.cross)).data.state === CrossState.Finalized, 'state Finalized', finSig);

  // 5. Minutes later the lock is still running.
  const now = await chainTime();
  const c3 = await read();
  const eta = c3.pending.__option === 'Some' ? c3.pending.value.eta : 0n;
  ev.check('lock-still-running', 'after the cross has settled the restarted lock still has almost the full seven days left, and a stranger still cannot apply', eta - now > WEEK - 3_600n, `${eta - now} s remaining of ${WEEK}`);
  ev.check('refuse-apply-late', 'applying is still refused (TimelockActive)', true, await mustFail([getApplyUpdateInstruction({ calendar: cal })], stranger, 'TimelockActive'));
}

const done = (error?: unknown) => (cleanup?.() ?? Promise.resolve()).catch((e) => console.error('cleanup failed', e)).finally(() => ev.write(error));
main().then(() => done(), (e) => { console.error(e); return done(e); });
