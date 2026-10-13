// The holder screens for the Wave 2D features, driven in a real browser against the harness in services/api/test/holder-w3c-harness.ts: the
// API is the real one (cross reads, the rules and treasury transaction builders), the accounts are the ones the extended programs would
// hold, and the cluster records every transaction the wallet signs. Each action is judged by decoding the transaction the wallet sent:
// the instruction, its arguments and its accounts.
//
//   cd services/api && RPC_URL=http://127.0.0.1:8482 PORT=8481 RPC_PORT=8482 npx tsx test/holder-w3c-harness.ts
//   cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:8481 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8482 npx next dev -p 3481
//   BASE_URL=http://localhost:3481 node e2e/holder-w3c-flow.mjs
import { BASE, OUT, axe, check, connect, launch, person, report, results, shot, sleep } from './holder-lib.mjs';
import { walletSecret } from './holder-keys.mjs';

const RPC = process.env.RPC ?? 'http://127.0.0.1:8482';
const fx = await (await fetch(`${RPC}/__fixtures`)).json();
const addr = await (await fetch(`${RPC}/__addresses`)).json();
const sent = async () => (await fetch(`${RPC}/__sent`)).json();
const reset = () => fetch(`${RPC}/__sent`, { method: 'DELETE' });
const setRelease = (crossCore, treasury) => fetch(`${RPC}/__release`, { method: 'POST', body: JSON.stringify({ crossCore, treasury }) });
const last = async () => (await sent()).at(-1);
const ix = (tx, name) => tx?.instructions.find((i) => i.name === name);

const browser = await launch();
const wallet = (label, o = {}) => person(browser, { name: label, secret: walletSecret(label), ...o });
const cross = (name) => `${BASE}/crosses/${fx.crosses[name]}`;
const treasury = (name) => `${BASE}/treasury/${fx.treasuries[name]}`;
const text = (p) => p.locator('main').innerText();
const have = async (p, re) => re.test(await text(p));

/** One scenario: a failure is recorded and the run goes on, so one broken screen does not hide the others. */
async function step(name, fn) {
  // ONLY="classes,ending" runs the named scenarios alone (a prefix of the scenario name is enough).
  if (process.env.ONLY && !process.env.ONLY.split(',').some((o) => name.startsWith(o.trim()))) return;
  try {
    await fn();
  } catch (e) {
    check(false, `${name}: threw ${String(e).slice(0, 300)}`);
  }
}
async function open(u, url, waitFor) {
  await u.page.goto(url, { waitUntil: 'domcontentloaded' });
  await connect(u);
  if (waitFor) await waitFor.waitFor({ timeout: 30_000 });
}
async function order(p, price, qty) {
  await p.getByLabel('Most you would pay per token').fill(price);
  await p.getByLabel(/^Tokens/).fill(qty);
}
async function accept(p) {
  const box = p.getByLabel('I have read this and I understand the risks');
  if (await box.isVisible().catch(() => false)) await box.click();
}
const placed = async (p) => p.getByText('Order placed.').waitFor({ timeout: 30_000 }).then(() => true, () => false);

// ======================================================================= the rules, the classes and the order ticket
await step('classes', async () => {
  const u = await wallet('pass');
  await reset();
  await open(u, cross('classes'), u.page.getByRole('heading', { name: 'Place an order' }));
  await u.page.getByRole('tab', { name: 'Rules' }).click();
  await u.page.getByTestId('rules-panel').waitFor();
  const t = await text(u.page);
  check(/5,000 quote/.test(t) && /At most 1,000 tokens are sold/.test(t) && /25 times the amount sold/.test(t), 'rules: the print guards are stated with their figures');
  check(/at most 1 live order in this cross/.test(t) && /at most 100 quote escrowed/.test(t), 'rules: the per-wallet limits are stated');
  check(/Class 1, small verified buyer/.test(t) && /Class 2, locked buyer.*30 days/s.test(t) && /Class 3, priority/.test(t), 'rules: all three classes are explained');
  check(/1 insider wallet/.test(t) && /bond of 100 quote/.test(t) && /25% of the protocol fee/.test(t), 'rules: insiders, bond and referral are explained');
  check((await u.page.getByTestId('rules-wallet').getByTestId(/class-/).count()) === 4, 'rules: this wallet sees four classes');
  check((await u.page.getByTestId('class-1').getAttribute('data-available')) === 'true', 'rules: class 1 is available to a wallet with the gate pass');
  await shot(u, 'rules-classes-1440-light');
  const ax = await axe(u);
  check(ax.length === 0, `axe clean on the rules tab${ax.length ? ': ' + JSON.stringify(ax).slice(0, 400) : ''}`);

  const p = u.page;
  await p.getByRole('tab', { name: 'Overview' }).click();
  await accept(p);
  await order(p, '1.5', '10');
  await p.getByLabel(/Small verified buyer/).check();
  check(/at most 5 quote.*locks 15 quote/s.test(await p.getByTestId('rule-blocks').innerText()), 'ticket: a class-1 order over the small-buyer cap is blocked, with both figures');
  check(await p.getByTestId('place-order').isDisabled(), 'ticket: the button is off while a rule blocks the order');
  await p.getByLabel(/^Tokens/).fill('2');
  check((await p.getByTestId('rule-blocks').count()) === 0, 'ticket: a class-1 order within the cap is not blocked');
  await p.getByLabel(/Locked buyer/).check();
  await p.getByTestId('lock-days').fill('10');
  check(/at least 30 days; 10 days is too short/.test(await p.getByTestId('rule-blocks').innerText()), 'ticket: a lockup shorter than the minimum is blocked');
  await p.getByTestId('lock-days').fill('45');
  check((await p.getByTestId('rule-blocks').count()) === 0 && /locked for 45 days and then vest/.test(await p.getByTestId('rule-checks').innerText()), 'ticket: a valid lockup is explained, not blocked');
  await shot(u, 'ticket-class2-1440-light');
  await p.getByTestId('place-order').click();
  check(await placed(p), 'ticket: the class-2 order is signed and confirmed');
  const tx = await last();
  const c = ix(tx, 'commit_order_ext');
  check(!!c, `tx: the wallet sent commit_order_ext (${tx?.names.join(', ')})`);
  check(c?.args?.class === 2 || c?.args?.extra?.class === 2 || JSON.stringify(c?.args).includes('"class":2'), `tx: the class is 2 (${JSON.stringify(c?.args).slice(0, 300)})`);
  check(JSON.stringify(c?.args).includes(String(45 * 86400)), 'tx: the lockup is 45 days in seconds');
  check(c?.accounts.includes(addr.classBook), 'tx: the class book account is passed');
  check(tx.signedBy.includes(fx.wallets.pass), 'tx: signed by the connected wallet');
  report(u);
  await u.context.close();
});

await step('classes: other wallets', async () => {
  const no = await wallet('nopass');
  await open(no, cross('classes'), no.page.getByRole('heading', { name: 'Place an order' }));
  await no.page.getByRole('tab', { name: 'Rules' }).click();
  await no.page.getByTestId('rules-wallet').waitFor();
  check((await no.page.getByTestId('class-1').getAttribute('data-available')) === 'false', 'a wallet without the gate pass cannot take class 1');
  check(/no pass for the cross’s gate/.test(await no.page.getByTestId('class-1').innerText()), 'and is told why');
  await no.page.getByRole('tab', { name: 'Overview' }).click();
  check(await no.page.getByLabel(/Small verified buyer/).isDisabled(), 'the class-1 choice is disabled in the ticket');
  report(no);
  await no.context.close();

  const ins = await wallet('insider');
  await open(ins, cross('classes'), ins.page.getByRole('heading', { name: 'Place an order' }));
  await accept(ins.page);
  await order(ins.page, '1.5', '2');
  check(/declared insider/.test(await ins.page.getByTestId('rule-checks').innerText()), 'a declared insider is told its fill is locked and left out of the raise');
  check((await ins.page.getByTestId('class-choice').count()) === 0, 'and is offered no class');
  report(ins);
  await ins.context.close();

  const lim = await wallet('limit');
  await open(lim, cross('classes'), lim.page.getByRole('heading', { name: 'Place an order' }));
  await accept(lim.page);
  await order(lim.page, '1.5', '2');
  await sleep(1500);
  check(/allows 1 live order per wallet and you have 1/.test(await lim.page.getByTestId('rule-blocks').innerText()), 'a wallet that has used its one order is blocked before signing');
  check(await lim.page.getByTestId('place-order').isDisabled(), 'and cannot press the button');
  report(lim);
  await lim.context.close();
});

await step('plain cross', async () => {
  const u = await wallet('pass');
  await open(u, cross('plain'), u.page.getByRole('heading', { name: 'Place an order' }));
  await u.page.getByRole('tab', { name: 'Rules' }).click();
  await u.page.getByTestId('rules-none').waitFor();
  check(/This cross has no rules/.test(await text(u.page)) && /plain call auction/.test(await text(u.page)), 'a cross without rules says so, and is a plain call auction');
  check((await u.page.getByTestId('class-choice').count()) === 0, 'and offers no class');
  report(u);
  await u.context.close();
});

// ======================================================================= the ending period
await step('ending period', async () => {
  const u = await wallet('pass');
  await reset();
  const p = u.page;
  await open(u, cross('ending'), p.getByTestId('ending-notice'));
  const t = await text(p);
  check(/about 1\.475/.test(t) && /More offered than wanted/.test(t), 'ending: the hero shows the nearest price band and a direction, from /indicative');
  check(!/\b1\.4\b/.test(await p.getByTestId('price').innerText()), 'ending: the exact price is not shown');
  const we = await p.getByTestId('worked-example').innerText();
  check(/held back/.test(we) && !/1\.4/.test(we), 'ending: the worked example does not give the exact price away');
  await shot(u, 'ending-1440-light');
  await p.getByRole('tab', { name: 'Book' }).click();
  check((await p.getByTestId('book-coarse').count()) === 1, 'ending: the Book tab does not draw the exact book');
  await p.getByRole('tab', { name: 'Orders' }).click();
  check((await p.getByTestId('orders-coarse').count()) === 1, 'ending: the Orders tab holds the list back');
  await p.getByRole('tab', { name: 'Replay' }).click();
  check((await p.getByTestId('replay-coarse').count()) === 1, 'ending: the Replay tab holds the events back');
  await p.getByRole('tab', { name: 'Overview' }).click();
  await accept(p);
  await order(p, '1.5', '2');
  check(/ending period is open/.test(await p.getByTestId('preview-detail').innerText()), 'ending: the order preview does not compare with the exact book');
  check(await p.getByTestId('place-order').isDisabled(), 'ending: cancellation has closed, so the button waits for an acknowledgement');
  check(/Cancellation closed at/.test(await p.getByTestId('rule-ack').innerText()), 'ending: the acknowledgement says when cancellation closed');
  await p.getByTestId('rule-ack').getByRole('checkbox').check();
  await p.getByTestId('place-order').click();
  check(await placed(p), 'ending: the order is signed after the acknowledgement');
  const tx = await last();
  // A cross with an ending period and no classes places a plain commit_order; it still names the shard of its window.
  const c = ix(tx, 'commit_order') ?? ix(tx, 'commit_order_ext');
  check(!!c, `ending: the wallet sent a commit (${tx?.names.join(', ')})`);
  check(Object.values(addr.endingShards).some((sh) => c?.accounts.includes(sh)), `ending: the order names the shard of its ending window (${c?.accounts.length} accounts)`);
  report(u);
  await u.context.close();

  const b = await wallet('pass');
  await open(b, cross('before-ending'), b.page.getByRole('heading', { name: 'Place an order' }));
  await accept(b.page);
  await order(b.page, '1.5', '2');
  const rc = await b.page.getByTestId('rule-checks').innerText();
  check(/You can cancel this order until/.test(rc) && (await b.page.getByTestId('rule-ack').count()) === 0, 'before the ending period: cancellation is open, so no acknowledgement is asked');
  report(b);
  await b.context.close();
});

// ======================================================================= the draw
await step('draw', async () => {
  const u = await wallet('stranger');
  await reset();
  await open(u, cross('draw'), u.page.getByTestId('draw-panel'));
  check(/draw comes before settlement/i.test(await text(u.page)) && /not a verifiable random function/.test(await text(u.page)), 'draw: the panel says a draw is owed and what kind');
  check((await u.page.getByTestId('settle').count()) === 0, 'draw: the settle button is not offered while a draw is owed');
  await u.page.getByTestId('draw-begin').click();
  await sleep(2500);
  const tx = await last();
  check(!!ix(tx, 'draw_begin'), `draw: the wallet sent draw_begin (${tx?.names.join(', ')})`);
  await shot(u, 'draw-1440-light');
  report(u);
  await u.context.close();
  const v = await wallet('stranger', { ignore: ['status of 4', ' 4'] });
  await reset();
  await open(v, cross('draw-begun'), v.page.getByTestId('draw-panel'));
  check((await v.page.getByTestId('draw-finish').count()) === 1 && (await v.page.getByTestId('draw-begin').count()) === 0, 'draw begun: the next step offered is to finish it');
  await v.context.close();
});

// ======================================================================= after the clear: claims, lockups, challenges
await step('cleared', async () => {
  const u = await wallet('lock');
  await reset();
  await open(u, cross('cleared'), u.page.getByTestId('lockups'));
  const t = await u.page.getByTestId('lockups').innerText();
  check(/100 tokens locked/.test(t) && /Release \d+(\.\d+)? tokens to your wallet/.test(t), 'lockups: the locked fill and what has vested are shown, with a release button');
  await shot(u, 'lockups-1440-light');
  await u.page.getByTestId('release-locked').click();
  await sleep(2500);
  const tx = await last();
  const c = ix(tx, 'release_locked');
  check(!!c && c.accounts.includes(addr.lockup), `lockups: the wallet sent release_locked naming the lockup account (${tx?.names.join(', ')})`);
  report(u);
  await u.context.close();

  const cl = await wallet('claim');
  await reset();
  await open(cl, cross('cleared'), cl.page.getByTestId('claim-order'));
  check(/keeper may refund it before you claim/.test(await text(cl.page)), 'claims: a possibly refund-only order says a keeper may refund it first');
  await cl.page.getByTestId('claim-order').click();
  await sleep(2500);
  check(!!ix(await last(), 'claim'), 'claims: the wallet sent claim');
  report(cl);
  await cl.context.close();

  const s = await wallet('stranger', { ignore: ['status of 4', ' 4'] });
  await reset();
  await open(s, cross('cleared'), s.page.getByTestId('challenges'));
  const ct = await s.page.getByTestId('challenges').innerText();
  check(/bond of 100 quote/.test(ct) && /Challenge 0/.test(ct) && /Open: the arbiter has not ruled/.test(ct), 'challenges: the bond, the window and the open challenge are shown');
  await s.page.getByTestId('challenge-subject').fill(fx.wallets.small);
  await s.page.getByTestId('challenge-evidence').fill('ab'.repeat(32));
  await s.page.getByTestId('challenge-insider').click();
  await sleep(2500);
  const ctx = await last();
  const ch = ix(ctx, 'challenge_insider');
  check(!!ch && ch.accounts.includes(addr.challenge1), `challenges: the wallet sent challenge_insider naming the next challenge account (${ctx?.names.join(', ')})`);
  check(JSON.stringify(ch?.args).includes(fx.wallets.small), 'challenges: the subject is the wallet typed');
  await shot(s, 'challenges-1440-light');
  await s.page.getByTestId('expire-challenge').click();
  await sleep(2000);
  check(/14 days|not yet|still/i.test(await s.page.getByTestId('challenges').innerText()), 'challenges: closing a young challenge is refused with a reason a person can read');
  await s.context.close();
});

await step('no print and pushed refunds', async () => {
  const r = await wallet('refund');
  await reset();
  await open(r, cross('noprint'), r.page.getByTestId('claim-order'));
  check(/amount raised at the clearing price was below the minimum/.test(await text(r.page)), 'no print: the reason the rules added is stated in words');
  await r.page.getByRole('tab', { name: 'Proof' }).click();
  await sleep(1500);
  await shot(r, 'noprint-proof-1440-light');
  await r.page.getByRole('tab', { name: 'Overview' }).click();
  await r.page.getByTestId('claim-order').click();
  await sleep(2500);
  check(!!ix(await last(), 'claim'), 'no print: the wallet sent claim for the refund');
  report(r);
  await r.context.close();

  const p = await wallet('pushed');
  await open(p, cross('noprint'), p.page.getByTestId('order-paid-out'));
  check(/paid out on chain/.test(await p.page.getByTestId('order-paid-out').innerText()) && (await p.page.getByTestId('claim-order').count()) === 0, 'pushed refund: an order refunded by a keeper shows as paid out and offers no claim');
  report(p);
  await p.context.close();

  const o = await wallet('refund');
  await open(o, `${BASE}/orders`, o.page.getByTestId('claim-center'));
  await o.page.getByTestId('claim-row').first().waitFor({ timeout: 40_000 });
  check((await o.page.getByTestId('refund-only').count()) >= 1, '/orders: a refund-only claim says a keeper may send it first');
  await shot(o, 'orders-claim-1440-light');
  report(o);
  await o.context.close();

  const l = await wallet('lock');
  await open(l, `${BASE}/orders`, l.page.getByTestId('claim-center'));
  await l.page.getByTestId('locked-fills').waitFor({ timeout: 40_000 });
  check(/100 tokens locked/.test(await l.page.getByTestId('locked-fills').innerText()), '/orders: locked fills are listed across crosses with a release button');
  check((await l.page.getByTestId('outcome').count()) >= 1, '/orders: a filled order explains its outcome');
  await shot(l, 'orders-locked-1440-light');
  report(l);
  await l.context.close();
});

// ======================================================================= the treasury
await step('treasury holder actions', async () => {
  const u = await wallet('holder');
  await reset();
  const p = u.page;
  await open(u, treasury('extended'), p.getByTestId('position'));
  await p.getByTestId('claimable').waitFor();
  check(/400 coins/.test(await p.getByTestId('held').innerText()) && /100 coins/.test(await p.getByTestId('staked').innerText()), 'treasury: the position shows coins held and staked');
  check(/Votes\./.test(await p.getByTestId('ext-terms').innerText()), 'treasury: the terms fixed at extension are stated');
  await shot(u, 'treasury-actions-1440-light');
  const ax = await axe(u);
  check(ax.length === 0, `axe clean on the treasury page${ax.length ? ': ' + JSON.stringify(ax).slice(0, 400) : ''}`);

  await p.getByTestId('claim-distribution').click();
  await sleep(2500);
  check(!!ix(await last(), 'claim_distribution'), 'treasury: claim distribution sent');

  await p.getByTestId('stake-amount').fill('50');
  await p.getByTestId('stake').click();
  await sleep(2500);
  const st = ix(await last(), 'stake');
  check(!!st && JSON.stringify(st.args).includes('50000000'), `treasury: stake of 50 coins sent (${JSON.stringify(st?.args)})`);

  await p.getByTestId('vote-amount-1').fill('25');
  await p.getByTestId('vote-1').click();
  await sleep(2500);
  const v = ix(await last(), 'vote');
  check(!!v && v.accounts.includes(addr.proposal1) && JSON.stringify(v.args).includes('25000000') && JSON.stringify(v.args).includes('true'), `treasury: a yes vote of 25 coins on proposal 1 (${JSON.stringify(v?.args)})`);

  await p.getByTestId('execute-0').click();
  await sleep(2500);
  check(!!ix(await last(), 'execute_proposal'), 'treasury: execute the passed proposal');

  await p.getByTestId('reclaim-2').click();
  await sleep(2500);
  const rc = ix(await last(), 'reclaim_vote');
  check(!!rc && rc.accounts.includes(addr.proposal2), 'treasury: reclaim the coins locked in the ended vote');

  await p.getByTestId('mark-missed-1').click();
  await sleep(2500);
  check(!!ix(await last(), 'mark_missed'), 'treasury: mark the late revenue round missed');

  check(/Ask the team for a disclosure/.test(await text(p)) && (await p.getByTestId('request-disclosure').count()) === 1, 'treasury: a holder of enough of the supply can request a disclosure');
  await p.getByTestId('request-disclosure').click();
  await sleep(2500);
  check(!!ix(await last(), 'request_disclosure'), 'treasury: request disclosure sent');
  report(u);
  await u.context.close();

  const s = await wallet('small');
  await open(s, treasury('extended'), s.page.getByTestId('disclosure-request'));
  check(/holds 0\.3% of the supply; the minimum is 1%/.test(await s.page.getByTestId('disclosure-why').innerText()), 'treasury: a small holder is told what is short for a disclosure request');
  check((await s.page.getByTestId('request-disclosure').count()) === 0, 'treasury: and is not offered the button');
  await s.context.close();

  const b = await wallet('beneficiary');
  await open(b, treasury('extended'), b.page.getByTestId('grants'));
  await b.page.getByTestId('release-0-0').click();
  await sleep(2500);
  const rm = ix(await last(), 'release_milestone');
  check(!!rm && rm.accounts.includes(addr.grant0), 'treasury: the beneficiary releases a milestone of their grant');
  await b.context.close();
});

await step('treasury NAV', async () => {
  const n = await wallet('holder');
  await reset();
  await open(n, treasury('nav'), n.page.getByTestId('nav'));
  check(/A NAV window is open/.test(await n.page.getByTestId('nav-state').innerText()), 'NAV: an open window is stated with its end');
  await n.page.getByTestId('nav-amount').fill('100');
  await n.page.getByTestId('nav-preview').click();
  await n.page.getByTestId('nav-quote').waitFor();
  const q = await n.page.getByTestId('nav-quote').innerText();
  check(/1,000 quote/.test(q) && /cannot be taken back/.test(q), 'NAV: the payout shown is the program’s own arithmetic (100 of 1,000 coins against 10,000 quote)');
  check((await sent()).length === 0, 'NAV: nothing is signed by the preview');
  await shot(n, 'nav-1440-light');
  await n.page.getByTestId('nav-redeem').click();
  await n.page.getByTestId('nav-done').waitFor({ timeout: 30_000 });
  const tx = await last();
  const c = ix(tx, 'nav_redeem');
  check(!!c && JSON.stringify(c.args).includes('100000000'), `NAV: nav_redeem sent for 100 coins (${JSON.stringify(c?.args)})`);
  report(n);
  await n.context.close();
  const t = await wallet('team');
  await open(t, treasury('nav'), t.page.getByTestId('nav'));
  check((await t.page.getByTestId('nav-insider').count()) === 1, 'NAV: a declared insider is told it cannot redeem');
  await t.context.close();
});

await step('treasury states and releases', async () => {
  const u = await wallet('holder');
  await open(u, treasury('plain'), u.page.getByTestId('holder-actions'));
  check((await u.page.getByTestId('holder-actions').getAttribute('data-availability')) === 'not-extended', 'a treasury that was never extended says so and offers nothing');
  await u.context.close();
  const r = await wallet('holder');
  await open(r, treasury('open-request'), r.page.getByTestId('disclosure-request'));
  check(/asked for a disclosure/.test(await r.page.getByTestId('disclosure-request').innerText()), 'an open disclosure request is shown with its deadline');
  await r.context.close();

  await setRelease('first', 'first');
  const f = await wallet('holder');
  await open(f, treasury('extended'), f.page.getByTestId('holder-actions'));
  check((await f.page.getByTestId('holder-actions').getAttribute('data-availability')) === 'first-release', 'first release: the treasury screen says the program cannot do this yet');
  check(/H27/.test(await f.page.getByTestId('holder-actions').innerText()) && (await f.page.getByTestId('claim-distribution').count()) === 0 && (await f.page.getByTestId('position').count()) === 0, 'first release: no holder action is offered');
  await shot(f, 'treasury-first-release-1440-light');
  await open(f, cross('plain'), f.page.getByRole('heading', { name: 'Place an order' }));
  await f.page.getByRole('tab', { name: 'Rules' }).click();
  await f.page.getByTestId('release-first-release').waitFor();
  check(/still the first release/.test(await f.page.getByTestId('release-first-release').innerText()), 'first release: a cross without rules says the cross program deployed here has no rules extension yet');
  report(f);
  await f.context.close();
  await setRelease('extended', 'extended');
});

// ======================================================================= looks: every key screen, light and dark, 1440 and 390
await step('visual', async () => {
  const shots = [
    ['classes', 'rules-classes', 'pass', cross('classes'), 'rules', 'rules-panel'],
    ['ending', 'ending', 'pass', cross('ending'), null, 'ending-notice'],
    ['cleared', 'cleared', 'lock', cross('cleared'), null, 'lockups'],
    ['treasury', 'treasury', 'holder', treasury('extended'), null, 'holder-actions'],
    ['orders', 'orders', 'lock', `${BASE}/orders`, null, 'locked-fills'],
  ];
  for (const theme of ['light', 'dark']) {
    for (const [w, h, label] of [[1440, 900, '1440'], [390, 844, '390']]) {
      for (const [name, file, who, url, tab, focus] of shots) {
        const u = await wallet(who, { theme, viewport: { width: w, height: h } });
        await u.page.goto(url, { waitUntil: 'domcontentloaded' });
        await connect(u);
        await sleep(3500);
        if (tab) await u.page.getByRole('tab', { name: 'Rules' }).click();
        await sleep(1500);
        await shot(u, `${file}-${label}-${theme}`);
        // A full page is too tall to read at a glance: the part this run is about is also captured on its own.
        const part = u.page.getByTestId(focus).first();
        if (await part.isVisible().catch(() => false)) await part.screenshot({ path: `${OUT}/${file}-part-${label}-${theme}.png` });
        const overflow = await u.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        check(!overflow, `${name} ${label} ${theme}: no horizontal page scroll`);
        const ax = await axe(u);
        check(ax.length === 0, `${name} ${label} ${theme}: axe clean${ax.length ? ' ' + JSON.stringify(ax).slice(0, 300) : ''}`);
        report(u);
        await u.context.close();
      }
    }
  }
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
