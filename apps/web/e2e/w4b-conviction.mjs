// W4B: conviction locks and the soulbound badge (S7). The holder's locks in every state (locked, ready to take back, returned with and without a badge, too small for
// a badge), the lock form with its badge preview, unlock, mint the badge and close, the holder's badges, and a token's totals; each judged on the decoded transaction
// the wallet signed, with the careless states (more than the wallet holds, a lock under a day or over four years, a lock too small for a badge, no wallet) and the
// cluster that does not have the program.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-conviction.mjs
import { act, clean, ensureConnected, failures, fixtures, go, ixOf, launch, log, person, setMode, signerOf, text } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
const C = f.conviction;
const P = f.people;

try {
  const v = await person(browser, { name: 'visitor' });
  await go(v, '/conviction');
  await v.page.getByTestId('connect-hint').waitFor({ timeout: 25000 });
  log(/a promise with no exit/.test(await text(v.page.getByTestId('conviction-promise'))) && /not points, a tier or a payout/.test(await text(v.page.getByTestId('conviction-promise'))), 'the page says a lock has no exit and the badge is not points, a tier or a payout');
  log(await v.page.getByTestId('lock-tokens').isDisabled(), 'with no wallet, Lock is off');
  await v.page.getByLabel('Token', { exact: true }).last().fill(C.mint);
  await v.page.getByTestId('mint-stats').waitFor({ timeout: 15000 });
  log(/5 locks by 1 holder; 300\.001 locked now; 5000 token-days of badges minted/.test(await text(v.page.getByTestId('mint-stats'))), 'a token’s totals: 5 locks, 300.001 locked now, 5000 token-days minted');
  log(clean(v).length === 0, `visitor: no console error or failed request ${clean(v).join(' | ')}`);
  await v.ctx.close();

  const h = await person(browser, { name: 'holder', secret: P.voter.secret });
  await go(h, '/conviction');
  await ensureConnected(h, P.voter.address);
  await h.page.getByTestId('locks').waitFor({ timeout: 25000 });
  log((await h.page.getByTestId('locks').locator('li').count()) === 5, 'the holder sees its five locks');
  const st = async (lock) => h.page.getByTestId(`lock-${lock}`).getAttribute('data-state');
  log((await st(C.locked)) === 'locked' && (await st(C.ready)) === 'unlockable' && (await st(C.unlocked)) === 'unlocked', 'in their states: locked, ready to take back, returned');
  log(/Locked, 2\dd \d+h left/.test(await text(h.page.getByTestId(`lock-${C.locked}`))) && /cannot be ended early/.test(await text(h.page.getByTestId(`wait-${C.locked}`))), 'a lock that has not run says how long is left and that it cannot be ended early');
  log((await h.page.getByTestId(`lock-${C.locked}`).getByRole('button').count()) === 0, 'and offers no button');
  log(/earns a badge of 9000 token-days/.test(await text(h.page.getByTestId(`lock-${C.ready}`))), 'a lock that ran earns a badge of 9000 token-days (100 tokens x 90 days)');
  log(/too small to earn a badge/.test(await text(h.page.getByTestId(`lock-${C.tiny}`))) && (await h.page.getByTestId(`claim-${C.tiny}`).count()) === 0, 'a lock too small for one token-day says so and offers no badge');
  log((await h.page.getByTestId(`unlock-${C.unlocked}`).count()) === 0 && (await h.page.getByTestId(`claim-${C.unlocked}`).count()) === 1, 'tokens already returned: the badge can still be minted, the tokens cannot be taken twice');
  log((await h.page.getByTestId(`close-${C.closable}`).count()) === 1 && (await h.page.getByTestId(`close-${C.unlocked}`).count()) === 0, 'Close appears only once tokens are back and the badge is minted');
  log(/Conviction in .*: 5000 token-days\. Non-transferable/.test(await text(h.page.getByTestId(`badge-${C.mint}`))), 'the badge is listed with its token-days and that it cannot be sent');
  await h.page.screenshot({ path: `${process.env.OUT}/conviction-locks.png`, fullPage: true });
  let r = await act(h, `unlock-${C.ready}`);
  const un = ixOf(r.tx, 'cross_conviction', 'unlock');
  log(r.done && un && signerOf(un, P.voter.address), 'Take the tokens back signs unlock by the holder');
  r = await act(h, `claim-${C.ready}`);
  log(r.done && ixOf(r.tx, 'cross_conviction', 'claim_badge'), `Mint the badge signs claim_badge (${r.shape.join(', ')})`);
  r = await act(h, `close-${C.closable}`);
  log(r.done && ixOf(r.tx, 'cross_conviction', 'close_lock'), 'Close the lock signs close_lock');

  // ------------------------------------------------------------------ the lock form
  await h.page.getByLabel('Token', { exact: true }).first().fill(C.mint);
  await h.page.getByText(/you hold 500/).waitFor({ timeout: 15000 });
  await h.page.getByLabel('Amount', { exact: true }).fill('1000');
  log(/This wallet holds 500/.test(await text(h.page.getByTestId('lock-form'))) && (await h.page.getByTestId('lock-tokens').isDisabled()), 'an amount above the balance is refused in words');
  await h.page.getByLabel('Amount', { exact: true }).fill('100');
  await h.page.getByLabel('Lock for, days').fill('0');
  log(/1 to 1459/.test(await text(h.page.getByTestId('lock-form'))), 'a lock under a day is named');
  await h.page.getByLabel('Lock for, days').fill('2000');
  log(/1 to 1459/.test(await text(h.page.getByTestId('lock-form'))) && (await h.page.getByTestId('lock-tokens').isDisabled()), 'a lock over four years is named');
  await h.page.getByLabel('Lock for, days').fill('90');
  log(/earns a badge of 9000 token-days/.test(await text(h.page.getByTestId('badge-preview'))), 'the form previews the badge: 100 tokens for 90 days is 9000 token-days');
  await h.page.getByLabel('Amount', { exact: true }).fill('0.00001');
  await h.page.getByLabel('Lock for, days').fill('1');
  log(/too small to earn one token-day/.test(await text(h.page.getByTestId('badge-preview'))), 'a lock too small for a badge says so before it is made');
  await h.page.getByLabel('Amount', { exact: true }).fill('100');
  await h.page.getByLabel('Lock for, days').fill('90');
  r = await act(h, 'lock-tokens');
  const lk = ixOf(r.tx, 'cross_conviction', 'lock_tokens');
  console.log('   lock_tokens:', JSON.stringify(lk?.args));
  const want = Math.floor(Date.now() / 1000) + 90 * 86400;
  log(r.done && lk && signerOf(lk, P.voter.address) && String(lk.args?.amount) === '100000000' && Math.abs(Number(lk.args?.unlockTs) - want) < 600, 'Lock the tokens signs lock_tokens for 100 tokens, unlocking in 90 days');
  await h.page.screenshot({ path: `${process.env.OUT}/conviction-form.png`, fullPage: true });
  log(clean(h).length === 0, `holder: no console error or failed request ${clean(h).join(' | ')}`);
  await h.ctx.close();

  await setMode('absent');
  const n = await person(browser, { name: 'absent', secret: P.voter.secret });
  await go(n, '/conviction');
  await ensureConnected(n, P.voter.address);
  const notice = n.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first();
  await notice.waitFor({ timeout: 25000 });
  log(/Built, not on devnet yet/.test(await text(notice)), 'on a cluster without cross_conviction the page says it is built, not on devnet yet');
  await n.page.getByLabel('Token', { exact: true }).first().fill(C.mint);
  await n.page.getByText(/you hold 500/).waitFor({ timeout: 15000 });
  await n.page.getByLabel('Amount', { exact: true }).fill('100');
  log(await n.page.getByTestId('lock-tokens').isDisabled() && /not on devnet yet/.test(await text(n.page.getByTestId('lock-tokens-reason'))), 'locking is off with a valid form, and says why');
  await n.page.screenshot({ path: `${process.env.OUT}/conviction-absent.png`, fullPage: true });
  log(clean(n).length === 0, `absent: no console error or failed request ${clean(n).join(' | ')}`);
  await n.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
