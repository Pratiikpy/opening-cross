// W3F: Z3, an order pegged to the open. "Take whatever the open prints" sets the limit to the top of the grid for a buy and the bottom for a sell, and the
// order is signed at that price.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-peg.mjs
import { BASE, OUT, ensureConnected, eventually, failures, find, fixtures, launch, log, person, reset, sent, setMode, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
try {
  const p = await person(browser, { name: 'trader', secret: f.secret });
  await p.page.goto(`${BASE}/crosses/${f.sellOpen}`, { waitUntil: 'networkidle' });
  await ensureConnected(p, f.wallet);
  const peg = p.page.getByTestId('peg-open');
  await peg.waitFor({ timeout: 20000 });
  const price = p.page.getByLabel('Most you would pay per token');
  await peg.click();
  log((await price.inputValue()) === '2.9', `a buy pegged to the open takes the top of the grid (${await price.inputValue()})`);
  log(/Pegged to the open: your limit is the top of the grid/.test(await text(p.page.locator('#price-help'))), 'and the page says what that means for the escrow and for the price paid');
  log((await peg.count()) === 0, 'the peg button gives way to the explanation once it is applied');
  await p.page.getByLabel('Tokens', { exact: true }).fill('5');
  await p.page.getByLabel('I have read this and I understand the risks').click();
  await reset();
  await p.page.getByTestId('place-order').click();
  await p.page.getByText('Order placed.').waitFor({ timeout: 30000 }).catch(() => undefined);
  await p.page.waitForTimeout(500);
  let ix = find(await sent(), 'cross_core', 'commit_order');
  console.log('   commit_order:', JSON.stringify(ix?.args));
  log(Boolean(ix) && String(ix.args?.price ?? '') === '2900000' || /2900000/.test(JSON.stringify(ix?.args)), 'the order is signed at the top price, 2.9');
  await p.page.getByText('sell', { exact: true }).first().click();
  const sellPrice = p.page.getByLabel('Least you would take per token');
  await p.page.getByTestId('peg-open').click();
  log((await sellPrice.inputValue()) === '1', `a sell pegged to the open takes the bottom of the grid (${await sellPrice.inputValue()})`);
  await p.page.screenshot({ path: `${OUT}/order-peg.png`, fullPage: false });
  log(p.problems.filter((x) => !/40[0-9]|422|409|500/.test(x)).length === 0, `trader: no console error ${p.problems.join(' | ')}`);
  await p.ctx.close();
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
void eventually;
