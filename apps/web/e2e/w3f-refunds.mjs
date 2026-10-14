// W3F: pushed refunds (B5). A cross that did not print holds fourteen open orders; anyone can send them back to their owners in batches of
// twelve. The panel, the transaction it signs (twelve orders, each with its owner and the owner's own token account), what it does not offer
// (a live cross, a cross with nothing refund-only) and the first release.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-refunds.mjs
import { BASE, OUT, ensureConnected, eventually, failures, find, fixtures, launch, log, person, reset, sent, setMode, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const go = (p, path) => p.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });

try {
  const v = await person(browser, { name: 'visitor' });
  await go(v, `/crosses/${f.refundCross}`);
  await v.page.waitForTimeout(1500);
  log((await v.page.getByTestId('refund-panel').count()) === 0, 'with no wallet connected the page does not offer to send refunds');
  await v.ctx.close();

  const s = await person(browser, { name: 'stranger', secret: f.strangerWallet.secret });
  await go(s, `/crosses/${f.refundCross}`);
  await ensureConnected(s, f.strangerWallet.address);
  await s.page.getByTestId('refund-panel').waitFor({ timeout: 20000 });
  log((await s.page.getByTestId('refund-panel').getAttribute('data-count')) === '14', 'a stranger sees 14 refund-only orders (the fifteenth is already paid out)');
  log(/14 orders are refund-only and still waiting.*2 transactions of up to 12 orders/.test(await text(s.page.getByTestId('refund-sentence'))), 'the panel says how many and in how many transactions');
  log(/Refund the next 12 orders \(2 more after\)/.test(await text(s.page.getByTestId('push-refunds'))), 'the button names the batch');
  await reset();
  await s.page.getByTestId('push-refunds').click();
  const done = await visible(s.page.getByTestId('push-refunds-done'), 20000);
  const tx = await sent();
  const ix = find(tx, 'cross_core', 'push_refunds');
  log(done && Boolean(ix) && tx[0].feePayer === f.strangerWallet.address, 'push_refunds is signed by the stranger, who pays the fee');
  const groups = (ix?.accounts ?? []).slice(-36);
  const orderAddrs = f.refundOrders.slice(0, 12).map((o) => o.address);
  log(groups.length === 36 && orderAddrs.every((a, i) => groups[i * 3]?.address === a), 'it names the first twelve orders, in order');
  log(f.refundOrders.slice(0, 12).every((o, i) => groups[i * 3 + 1]?.address === o.owner), 'each followed by its own owner');
  log(groups.filter((_, i) => i % 3 === 2).every((a) => a.writable && !a.signer), 'and a destination token account, which the program checks is the owner’s');
  log(!(ix?.accounts ?? []).some((a) => a.address === f.strangerWallet.address && a.writable && !a.signer), 'the stranger’s own wallet is not a destination of anything');
  await s.page.screenshot({ path: `${OUT}/refunds.png`, fullPage: true });
  log(s.problems.length === 0, `stranger: no console error or failed request ${s.problems.join(' | ')}`);
  await s.ctx.close();

  // nothing to send on a cross that printed and has no refund-only orders, and none on a live cross
  const t = await person(browser, { name: 'other', secret: f.strangerWallet.secret });
  await go(t, `/crosses/${f.challengeCross}`);
  await ensureConnected(t, f.strangerWallet.address);
  await t.page.waitForTimeout(1500);
  log((await t.page.getByTestId('push-refunds').count()) === 0, 'a settled cross with no refund-only order offers no button');
  await go(t, `/crosses/${f.haltedCross}`);
  await ensureConnected(t, f.strangerWallet.address);
  await t.page.waitForTimeout(1500);
  log((await t.page.getByTestId('refund-panel').count()) === 0, 'a live cross offers no refunds');
  await t.ctx.close();

  // the first release has push_refunds? it does not: the dry run says so
  await setMode('old');
  const o = await person(browser, { name: 'old', secret: f.strangerWallet.secret });
  await go(o, `/crosses/${f.refundCross}`);
  await ensureConnected(o, f.strangerWallet.address);
  await o.page.getByTestId('refund-panel').waitFor({ timeout: 20000 });
  await reset();
  await o.page.getByTestId('push-refunds').click();
  const msg = await eventually(o.page.getByTestId('refund-panel'), /does not have this instruction yet|first release/, 15000);
  log(msg && (await sent()).length === 0, 'on the first release the program has no push_refunds: the dry run says so in words and nothing is signed');
  await o.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
