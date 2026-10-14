// W3F: the treasury wind-down window (E7) in every state a person can find it in, and what a holder, or anyone, can do in each. Redeeming,
// sweepable, swept, no window, the first release, a lapse inside its grace period, a lapse past it, and a treasury that is simply active; the
// holder redeeming (all, some, too many), anyone triggering the liquidation and sweeping the remainder, each on the decoded transaction.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-winddown.mjs
import { BASE, OUT, ensureConnected, eventually, failures, find, fixtures, hasAccount, launch, log, person, reset, sent, setMode, signerOf, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const W = f.windDown;
const T = f.treasuries;

const go = (p, path) => p.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
const wind = (p) => p.page.getByTestId('wind-down');
async function open(p, address) {
  await go(p, `/treasury/${address}`);
  await wind(p).waitFor({ timeout: 20000 });
  // the section reads the extension after the page loads: wait for the phase to settle past "Reading"
  await p.page.waitForFunction(() => document.querySelector('[data-testid="wind-down"]')?.getAttribute('data-mode') !== null, null, { timeout: 15000 });
}
async function act(p, testId, program, instruction) {
  await reset();
  await p.page.getByTestId(testId).click();
  const done = await visible(p.page.getByTestId(`${testId}-done`), 20000);
  const tx = await sent();
  return { done, ix: find(tx, program, instruction), tx };
}
const attr = (p, name) => wind(p).getAttribute(name);
const step = (p, id) => p.page.getByTestId(`step-${id}`);

try {
  const v = await person(browser, { name: 'visitor' });

  // ------------------------------------------------------------------ redeeming
  await open(v, W.redeeming);
  log((await attr(v, 'data-phase')) === 'redeeming' && (await attr(v, 'data-mode')) === 'window', 'a treasury inside its window is "Redemption open"');
  log(/Redemption open/.test(await text(v.page.getByTestId('winddown-phase'))), 'the pill says so');
  log(/Liquidating. Holders can redeem; nothing can be swept yet/.test(await text(v.page.getByTestId('winddown-headline'))), 'the headline says what can and cannot happen');
  log(/1[56]\d days .*until the redemption window ends/.test(await text(v.page.getByTestId('winddown-countdown'))), 'and counts down to the end of the window (about 160 days)');
  const states = await Promise.all(['lapse', 'liquidation', 'redemption', 'sweep'].map((id) => step(v, id).getAttribute('data-state')));
  log(states.join(',') === 'done,done,now,next', `the four steps read ${states.join(', ')}`);
  log(/Holders redeem for at least 180 days/.test(await text(step(v, 'redemption'))) && /nothing is pushed to anyone/.test(await text(step(v, 'redemption'))), 'the window is 180 days and nothing is pushed to anyone');
  log(new RegExp(f.recovery.slice(0, 4)).test(await text(step(v, 'sweep'))) && /Sweeping early is refused/.test(await text(step(v, 'sweep'))), 'the sweep step names the recovery account and that sweeping early is refused');
  log(/Redeem before the window ends/.test(await text(v.page.getByTestId('winddown-holder'))), 'a holder is told to redeem before the window ends');
  log(/Connect the wallet that holds/.test(await text(v.page.getByTestId('winddown-holder'))), 'with no wallet the page asks for the holder’s wallet');
  log((await v.page.getByTestId('sweep-unclaimed').isDisabled()) && /Holders can still redeem; the sweep opens when the window ends/.test(await text(v.page.getByTestId('sweep-box'))), 'the sweep is off, and says holders can still redeem');
  log((await v.page.getByTestId('trigger-box').count()) === 0, 'there is no trigger to press on a treasury that is already liquidating');
  await v.page.screenshot({ path: `${OUT}/winddown-redeeming.png`, fullPage: true });

  // ------------------------------------------------------------------ sweepable, swept
  await open(v, T.liquidating);
  log((await attr(v, 'data-phase')) === 'sweepable', 'a treasury past its window is "Window over"');
  log(/Anyone can sweep what is left to the recovery account/.test(await text(v.page.getByTestId('winddown-headline'))) && /redemption still works/.test(await text(v.page.getByTestId('winddown-holder'))), 'it says anyone can sweep, and that redemption still works until someone does');
  log((await step(v, 'sweep').getAttribute('data-state')) === 'now', 'the sweep is the current step');
  await open(v, W.swept);
  log((await attr(v, 'data-phase')) === 'swept' && /Wound down/.test(await text(v.page.getByTestId('winddown-headline'))), 'a swept treasury is "Wound down"');
  log(/Redemption is closed/.test(await text(v.page.getByTestId('winddown-holder'))), 'and says redemption is closed');
  log((await v.page.getByTestId('sweep-unclaimed').isDisabled()) && /Already swept/.test(await text(v.page.getByTestId('sweep-box'))), 'sweeping again is off, and says it was swept');
  log((await v.page.getByTestId('redeem').count()) === 0, 'there is nothing to redeem');

  // ------------------------------------------------------------------ no window, first release, lapse, active
  await open(v, W.noWindow);
  log((await attr(v, 'data-mode')) === 'no-window' && /never expires/.test(await text(v.page.getByTestId('winddown-headline'))), 'a treasury extended without a window says redemption never expires');
  log((await v.page.locator('[data-testid^="step-"]').count()) === 3 && (await v.page.getByTestId('sweep-box').count()) === 0, 'it has no sweep step and no sweep button');
  await open(v, W.first);
  log((await attr(v, 'data-mode')) === 'first-release' && /first release.*no wind-down window/.test(await text(step(v, 'redemption'))), 'a first-release treasury says it has no wind-down window');
  await open(v, W.lapsing);
  log((await attr(v, 'data-phase')) === 'lapsing' && /grace period is running/.test(await text(v.page.getByTestId('winddown-headline'))), 'a lapse inside its grace period says the grace period is running');
  log(/until the liquidation can be triggered/.test(await text(v.page.getByTestId('winddown-countdown'))), 'with a countdown to the earliest liquidation');
  log((await v.page.getByTestId('trigger-liquidation').isDisabled()) && /grace period is still running/.test(await text(v.page.getByTestId('trigger-box'))), 'the trigger is off, and says why');
  await open(v, W.grace);
  log(/Anyone can trigger the liquidation/.test(await text(v.page.getByTestId('winddown-headline'))), 'a lapse past its grace says anyone can trigger the liquidation');
  log((await v.page.getByTestId('trigger-liquidation').isDisabled()) && /Anyone can do this once the grace period is over/.test(await text(v.page.getByTestId('trigger-box'))), 'with no wallet the button is off and says anyone can use it');
  await open(v, T.extended);
  log((await attr(v, 'data-phase')) === 'active' && /Nothing is winding down/.test(await text(v.page.getByTestId('winddown-headline'))), 'an active treasury is not winding down, and the page says so');
  log((await v.page.getByTestId('trigger-liquidation').isDisabled()) && /has not lapsed/.test(await text(v.page.getByTestId('trigger-box'))), 'and the trigger says the attestation has not lapsed');
  log(v.problems.length === 0, `visitor: no console error or failed request ${v.problems.join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ a holder
  const h = await person(browser, { name: 'holder', secret: f.secret });
  await open(h, W.redeeming);
  await ensureConnected(h, f.wallet);
  log(await eventually(h.page.getByTestId('entitlement'), /You hold 200 coins\. At the snapshot they redeem for 2,000 quote/), 'a holder sees what their coins redeem for: 200 coins of 1,000 over a 10,000 vault is 2,000 quote');
  let r = await act(h, 'redeem', 'treasury', 'redeem');
  log(r.done && signerOf(r.ix, f.wallet) && String(r.ix?.args?.amount) === '200000000', 'Redeem with the box empty signs redeem for all 200 coins');
  console.log('   redeem:', JSON.stringify(r.ix?.args));
  await h.page.getByLabel('Coins to redeem').fill('50');
  r = await act(h, 'redeem', 'treasury', 'redeem');
  log(r.done && String(r.ix?.args?.amount) === '50000000', 'with 50 typed it signs redeem for 50');
  await h.page.getByLabel('Coins to redeem').fill('500');
  log(/holds only 200 coins/.test(await text(wind(h))) && (await h.page.getByTestId('redeem').isDisabled()), 'more than the wallet holds is named, with what it holds, and Redeem is off');
  await h.page.getByLabel('Coins to redeem').fill('0.0000001');
  log(/decimal places/.test(await text(wind(h))) && (await h.page.getByTestId('redeem').isDisabled()), 'an amount that would round is refused in words');

  // anyone sweeps a treasury past its window
  await open(h, T.liquidating);
  await ensureConnected(h, f.wallet);
  r = await act(h, 'sweep-unclaimed', 'treasury', 'sweep_unclaimed');
  log(r.done && Boolean(r.ix) && r.tx[0].feePayer === f.wallet, 'Sweep signs sweep_unclaimed for a treasury past its window, the wallet paying the fee');
  log(r.ix?.accounts.some((x) => x.writable && x.address !== f.wallet), 'naming the recovery account’s token account');
  // anyone triggers a liquidation past its grace
  await open(h, W.grace);
  await ensureConnected(h, f.wallet);
  r = await act(h, 'trigger-liquidation', 'treasury', 'trigger_liquidation');
  log(r.done && Boolean(r.ix) && r.tx[0].feePayer === f.wallet, 'Trigger signs trigger_liquidation once the grace period is over, the wallet paying the fee');
  await open(h, W.lapsing);
  await ensureConnected(h, f.wallet);
  log(await h.page.getByTestId('trigger-liquidation').isDisabled(), 'and is off while the grace period is running, for the same wallet');
  log(h.problems.filter((x) => !/422|409|400/.test(x)).length === 0, `holder: no console error or failed request ${h.problems.join(' | ')}`);
  await h.ctx.close();

  // ------------------------------------------------------------------ the first release of the program
  await setMode('old');
  const o = await person(browser, { name: 'old', secret: f.secret });
  await open(o, T.liquidating);
  await ensureConnected(o, f.wallet);
  await o.page.waitForFunction(() => document.querySelector('[data-testid="sweep-unclaimed"]') !== null, null, { timeout: 10000 });
  log((await o.page.getByTestId('sweep-unclaimed').isDisabled()) && /first release/.test(await text(o.page.getByTestId('sweep-box'))), 'on the first release the sweep is off and the page says why');
  await open(o, W.redeeming);
  await ensureConnected(o, f.wallet);
  log(await eventually(o.page.getByTestId('entitlement'), /redeem for 2,000 quote/), 'but redeeming a liquidating treasury works on the first release, which has that instruction');
  r = await act(o, 'redeem', 'treasury', 'redeem');
  log(r.done, 'and is signed');
  await o.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
void hasAccount;
