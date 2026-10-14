// W3F: recurring series. The public pages (the list, one series, the cross page's note), the spawn button for any wallet, the authority's pause,
// resume and withdraw, and the creation form, each checked on the decoded transaction the wallet signed; the careless states (a form with nothing
// in it, a series number already used, a stranger on the authority's controls); and the first release.
//
//   cd services/api && W3F_PORT=8291 W3F_KEY_FILE=<scratch>/key.json npx tsx test/w3f-harness.ts
//   cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:8291 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8291/rpc NEXT_DIST_DIR=.next-w3f npx next dev -p 3431
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-series.mjs
import { BASE, OUT, api, connect, ensureConnected, failures, find, fixtures, hasAccount, launch, log, person, reset, sent, setMode, signerOf, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const S = f.series;

const go = async (p, path) => {
  await p.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
};
async function act(p, id, program, instruction) {
  await reset();
  await p.page.getByTestId(id).click();
  const done = await visible(p.page.getByTestId(`${id}-done`), 20000);
  const tx = await sent();
  return { done, ix: find(tx, program, instruction), tx };
}
async function refused(p, id) {
  await reset();
  await p.page.getByTestId(id).click();
  const shown = await visible(p.page.getByTestId(`${id}-error`), 15000);
  return { shown, message: shown ? await text(p.page.getByTestId(`${id}-error`)) : '', n: (await sent()).length };
}

try {
  // ------------------------------------------------------------------ the public list
  const v = await person(browser, { name: 'visitor' });
  await go(v, '/series');
  log(await visible(v.page.getByTestId('series-list')), 'the list shows every series on the network');
  log((await v.page.getByTestId('series-list').locator('li').count()) === 6, 'all six');
  const rowDue = await text(v.page.getByTestId(`series-${S.due}`));
  log(/One cross every 1 day/.test(rowDue) && /3 spawned, no limit/.test(rowDue) && /Next close/.test(rowDue), 'a running series says its schedule, how many it spawned and when the next cross closes');
  log(/Paused/.test(await text(v.page.getByTestId(`series-${S.paused}`))) && /Spawning is paused/.test(await text(v.page.getByTestId(`series-${S.paused}`))), 'a paused series says it is paused');
  log(/Finished/.test(await text(v.page.getByTestId(`series-${S.done}`))) && /ran its last cross/.test(await text(v.page.getByTestId(`series-${S.done}`))), 'a series that ran its last cross says so');
  log(/each session of the calendar/.test(await text(v.page.getByTestId(`series-${S.calendar}`))), 'a series on a calendar says whose sessions it follows');

  // ------------------------------------------------------------------ one series, no wallet
  await go(v, `/series/${S.due}`);
  await v.page.getByTestId('series-detail').waitFor();
  log(/Waiting for the next slot/.test(await text(v.page.getByTestId('series-status'))), 'the series page names the state');
  log(/It can be spawned now/.test(await text(v.page.getByTestId('spawn-verdict'))), 'the next cross can be spawned now (it opens within 24 hours)');
  log(await v.page.getByTestId('spawn-next').isDisabled(), 'with no wallet the spawn button is off, and says any wallet can use it');
  const list = await text(v.page.getByTestId('series-crosses'));
  log(/Cross 0/.test(list) && /Did not print: trading in the asset was halted/.test(list), 'a cross that did not print says why, in words');
  log(/Cross 1[\s\S]*Printed at 1.5 quote per token/.test(list) && /Printed at 1.62 quote per token/.test(list), 'a cross that printed shows its price');
  log(/1.62 quote per token; the next grid centres on it/.test(await text(v.page.getByTestId('series-detail'))), 'the last printed price is shown, and that the next grid centres on it');
  log(/Connect the authority wallet/.test(await text(v.page.getByTestId('not-authority'))), 'pause and withdraw are not offered without the authority wallet');
  const rows = [
    ['early', 'too early', /It is too early.*24 hours before it opens/],
    ['paused', 'paused', /series is paused/],
    ['busy', 'one at a time', /has not settled yet.*one cross at a time/],
    ['done', 'finished', /run its last cross/],
  ];
  for (const [key, what, re] of rows) {
    await go(v, `/series/${S[key]}`);
    await v.page.getByTestId('spawn-reason').waitFor();
    const reason = await text(v.page.getByTestId('spawn-reason'));
    log(re.test(reason) && (await v.page.getByTestId('spawn-next').isDisabled()), `a series that is ${what}: Not yet, with the program’s reason, and the button is off`);
  }
  await go(v, `/series/${S.early}`);
  log(/will open .* and close .*; it can be spawned from/.test(await text(v.page.getByTestId('spawn-reason'))), 'a series that is too early says when its next cross opens, closes and can be spawned');
  await go(v, `/series/${S.calendar}`);
  await v.page.getByTestId('spawn-verdict').waitFor();
  let cal = await text(v.page.getByTestId('spawn-verdict'));
  if (!/It can be spawned now/.test(cal)) {
    // The API gives up on a slow chain read and opens a 15 second breaker; on a loaded machine that can hit the first read. Harness, not product: ask again.
    await new Promise((r) => setTimeout(r, 16000));
    await go(v, `/series/${S.calendar}`);
    await v.page.getByTestId('spawn-verdict').waitFor();
    cal = await text(v.page.getByTestId('spawn-verdict'));
  }
  log(/It can be spawned now/.test(cal), 'a series on a calendar can spawn when the next session start is near');
  const sessionIso = new Date(f.sessionStart * 1000).toISOString().replace('T', ' ').slice(0, 16);
  log(cal.includes(sessionIso), `and it closes at that session’s start, ${sessionIso} UTC, the calendar’s own time`);
  await go(v, '/series/11111111111111111111111111111112');
  log(await visible(v.page.getByTestId('series-error')), 'a series that does not exist says so');
  await go(v, '/calendar');
  log(await visible(v.page.getByTestId('series-list')), 'the calendar page lists the series too');

  // ------------------------------------------------------------------ the cross pages
  const crossOfSeries = (await api(`/v1/series/${S.due}`)).crosses.find((c) => String(c.idx) === '2').cross_address;
  await go(v, `/crosses/${crossOfSeries}`);
  await v.page.getByTestId('series-note').waitFor();
  const note = await text(v.page.getByTestId('series-note'));
  log(/Cross 2 of the recurring series/.test(note) && /One cross every 1 day/.test(note) && /The series is running/.test(note), 'the cross page says it is cross 2 of its series, and when the series repeats');
  await go(v, `/crosses/${f.haltedCross}`);
  await v.page.getByTestId('halt-banner').waitFor();
  const banner = await text(v.page.getByTestId('halt-banner'));
  log(/halted: halted by the venue/i.test(banner) && /will not print, and every order is refunded in full/.test(banner), 'a cross that honours a halt says the token is halted, by whom, and what that does to it');
  await go(v, `/crosses/${f.haltedNoPrint}`);
  await v.page.getByTestId('halt-banner').waitFor();
  log(/This cross did not print/.test(await text(v.page.getByTestId('halt-banner'))), 'the cross that did not print for the halt says so');
  await go(v, `/crosses/${f.crosses.fresh}`);
  await v.page.waitForTimeout(800);
  log((await v.page.getByTestId('series-halt-note').count()) === 0, 'a plain cross shows neither note');
  log(v.problems.length === 0, `visitor: no console error or failed request ${v.problems.join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ a stranger spawns the next cross
  const st = await person(browser, { name: 'stranger', secret: f.strangerWallet.secret });
  await go(st, `/series/${S.due}`);
  await connect(st, f.strangerWallet.address);
  await st.page.getByTestId('spawn-verdict').waitFor();
  let r = await act(st, 'spawn-next', 'cross_core', 'spawn_next');
  log(r.done && hasAccount(r.ix, S.due) && signerOf(r.ix, f.strangerWallet.address) && r.tx[0].feePayer === f.strangerWallet.address, 'any wallet can spawn: spawn_next is signed by the stranger, naming the series');
  log(/not the series’ authority/.test(await text(st.page.getByTestId('not-authority'))), 'the stranger is told pausing and withdrawing are the authority’s');
  await go(st, `/series/${S.early}`);
  await st.page.getByTestId('spawn-reason').waitFor();
  r = await refused(st, 'spawn-next').catch(() => ({ shown: false }));
  log((await st.page.getByTestId('spawn-next').isDisabled()) && (await sent()).length === 0, 'a series that is too early offers nothing to sign');
  log(st.problems.length === 0, `stranger: no console error or failed request ${st.problems.join(' | ')}`);
  await st.ctx.close();

  // ------------------------------------------------------------------ the authority
  const a = await person(browser, { name: 'authority', secret: f.secret });
  await go(a, `/series/${S.due}`);
  await connect(a, f.wallet);
  await a.page.getByTestId('set-active').waitFor();
  r = await act(a, 'set-active', 'cross_core', 'set_series_active');
  log(r.done && r.ix?.args?.active === false && signerOf(r.ix, f.wallet), 'the authority’s Pause signs set_series_active with active false');
  await go(a, `/series/${S.paused}`);
  await a.page.getByTestId('set-active').waitFor();
  log(/Resume the series/.test(await text(a.page.getByTestId('set-active'))), 'a paused series offers Resume');
  r = await act(a, 'set-active', 'cross_core', 'set_series_active');
  log(r.done && r.ix?.args?.active === true, 'Resume signs set_series_active with active true');

  await go(a, `/series/${S.due}`);
  await a.page.getByTestId('withdraw').waitFor();
  await a.page.waitForFunction(() => /The series holds 50 quote/.test(document.querySelector('[data-testid="withdraw"]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => undefined);
  log(/The series holds 50 quote/.test(await text(a.page.getByTestId('withdraw'))), 'the withdraw panel reads the series’ balance from the chain');
  log(await a.page.getByTestId('series-withdraw').isDisabled(), 'Withdraw is off until an amount is entered');
  await a.page.getByTestId('withdraw').getByLabel('Amount').fill('12.5');
  r = await act(a, 'series-withdraw', 'cross_core', 'series_withdraw');
  log(r.done && r.ix?.args?.amount === '12500000' && signerOf(r.ix, f.wallet) && hasAccount(r.ix, f.quoteMint), 'Withdraw signs series_withdraw for 12.5 quote in atoms, naming the quote mint');
  const walletQuoteAta = r.ix?.accounts.find((x) => x.writable && x.address !== S.due)?.address;
  log(Boolean(walletQuoteAta), 'and a destination token account');
  await a.page.getByTestId('withdraw').getByLabel('Amount').fill('70');
  log(/The series holds only 50 quote/.test(await text(a.page.getByTestId('withdraw'))) && (await a.page.getByTestId('series-withdraw').isDisabled()), 'more than the series holds is named, with the balance, and Withdraw is off');
  await a.page.getByTestId('withdraw').getByLabel('Send to wallet').fill('nonsense');
  log(/not a Solana address/.test(await text(a.page.getByTestId('withdraw'))), 'a destination that is not an address is named as such');
  log(a.problems.filter((x) => !/422|409|400/.test(x)).length === 0, `authority: no console error or failed request ${a.problems.join(' | ')}`);
  await a.ctx.close();

  // ------------------------------------------------------------------ the console and its creation form
  const c = await person(browser, { name: 'issuer', secret: f.secret });
  await go(c, '/issuer/series');
  log(await visible(c.page.getByTestId('connect-for-series')), 'the console asks for a wallet to list the series');
  await connect(c, f.wallet);
  await c.page.getByTestId('my-series').waitFor();
  log((await c.page.getByTestId('my-series').locator('li').count()) === 6, 'the wallet’s six series are listed');
  await c.page.getByTestId(`pick-${S.paused}`).click();
  await c.page.getByTestId('selected-series').waitFor();
  log(/Paused by its authority/.test(await text(c.page.getByTestId('series-status'))), 'picking one opens its page in the console');
  const form = c.page.getByTestId('series-form');
  log(await c.page.getByTestId('create-series').isDisabled(), 'Create is off while the form is empty');
  await form.getByLabel('Token', { exact: true }).fill(f.baseMint);
  await form.getByLabel('Quote token').fill(f.quoteMint);
  await form.getByLabel('First slot closes').fill('2026-12-01T12:00');
  await form.getByLabel('First centre price, per token').fill('1.5');
  await form.getByLabel('Series number').fill('1');
  await c.page.getByTestId('series-summary').waitFor();
  const sum = await text(c.page.getByTestId('series-summary'));
  log(/every 7 days/.test(sum) && /41 steps of 1% of the last price, centred on 1.5/.test(sum) && /Only the authority can pause the series and withdraw/.test(sum) && /Anyone can spawn the next cross/.test(sum), 'the summary says what is committed, from the built request');
  r = await refused(c, 'create-series');
  log(r.shown && /already exists/.test(r.message) && r.n === 0, `series number 1 is taken: the API says so in words and nothing is signed (${r.message.slice(0, 80)})`);
  await form.getByLabel('Series number').fill('7');
  await form.getByLabel('The call lasts, minutes').fill('0');
  log(/at least 1/.test(await text(form)) && (await c.page.getByTestId('create-series').isDisabled()), 'a call of 0 minutes is named as wrong and Create is off');
  await form.getByLabel('The call lasts, minutes').fill('180');
  await form.getByLabel('Rules for every cross').selectOption('ending');
  await form.getByLabel('Stop after, crosses').fill('12');
  r = await act(c, 'create-series', 'cross_core', 'create_series');
  const cfg = r.ix?.args?.config;
  log(r.done && r.ix?.args?.seriesId === '7' && signerOf(r.ix, f.wallet), 'a valid form signs create_series for series 7');
  log(cfg?.kind === 1 || cfg?.kind === 3 || cfg?.kind !== undefined, 'with a config');
  log(String(cfg?.callSecs) === '10800' && String(cfg?.intervalSecs) === '604800' && String(cfg?.maxCrosses) === '12' && String(cfg?.grid?.tickBps) === '100' && String(cfg?.grid?.ticks) === '41' && String(cfg?.grid?.center) === '1500000', 'the config carries the call, the interval, the limit and the grid in the program’s units');
  log(String(cfg?.rules?.ending?.endingSecs) === '1800' && String(cfg?.rules?.ending?.buckets) === '6', 'and the hard-to-game ending as the rules of every cross');
  const atas = r.tx[0].transaction.filter((x) => x.program !== 'cross_core');
  log(atas.length === 2, 'with the two token accounts the series holds its proceeds in, created in the same transaction');
  log(await visible(c.page.getByTestId('created-series')), 'the new series’ address is shown');
  await c.page.screenshot({ path: `${OUT}/series-console.png`, fullPage: true });

  // the first release
  await setMode('old');
  await go(c, '/issuer/series');
  await connect(c, f.wallet).catch(() => undefined);
  await c.page.locator('[data-testid="program-notice"][data-release="first-release"]').first().waitFor({ timeout: 15000 }).catch(() => undefined);
  log(/Not live on/.test(await text(c.page.getByTestId('program-notice').first())) && /first release/.test(await text(c.page.getByTestId('program-notice').first())), 'on the first release the page says recurring series are not live yet');
  log(await c.page.getByTestId('create-series').isDisabled(), 'and Create is off');
  await setMode('new');
  log(c.problems.filter((x) => !/422|409|400/.test(x)).length === 0, `issuer: no console error or failed request ${c.problems.join(' | ')}`);
  await c.ctx.close();
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void setMode;
