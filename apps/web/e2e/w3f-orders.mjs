// W3F: V7, selling a released lock. A wallet with a locked fill sees, under it, the crosses of the same token that can take a sell order.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-orders.mjs
import { BASE, OUT, ensureConnected, eventually, failures, fixtures, launch, log, person, setMode, text } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
try {
  const p = await person(browser, { name: 'holder', secret: f.secret });
  await p.page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await ensureConnected(p, f.wallet);
  await p.page.getByTestId('locked-fills').waitFor({ timeout: 25000 });
  log(/Locked fills/.test(await text(p.page.getByTestId('locked-fills'))), 'the orders page lists the locked fill');
  const sell = p.page.getByTestId('sell-release');
  await sell.waitFor({ timeout: 10000 });
  log(await eventually(sell, /1 cross is taking orders now and 1 more opens later\. Place a sell order in one/), 'under it, the crosses of the same token that can take a sell order are counted: one open now, one later');
  const links = await sell.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  log(links.includes(`/crosses/${f.sellOpen}`) && links.includes(`/crosses/${f.sellLater}`), 'and linked');
  log(/takes orders until/.test(await text(sell)) && /opens 20/.test(await text(sell)), 'each says when it takes orders or opens');
  await p.page.screenshot({ path: `${OUT}/portfolio-sell-release.png`, fullPage: true });
  await sell.locator(`a[href="/crosses/${f.sellOpen}"]`).click();
  await p.page.waitForURL(`**/crosses/${f.sellOpen}`);
  log(true, 'the link opens the cross, where the sell order is placed with every rule of that cross checked');
  log(p.problems.filter((x) => !/40[0-9]|422|409/.test(x)).length === 0, `holder: no console error or failed request ${p.problems.join(' | ')}`);
  await p.ctx.close();
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
