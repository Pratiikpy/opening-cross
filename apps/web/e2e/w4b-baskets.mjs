// W4B: basket tokens (S5). The index, a basket's page (what one share is, what backs it now, whether every vault covers the shares outstanding, a component whose issuer
// can freeze, the exact quote with its rounding), minting and redeeming, and creating a basket; each judged on the decoded transaction the wallet signed, with the
// careless states (more shares than held, components the wallet does not hold, the same token twice, a token with a transfer fee, a vault that is short) and the cluster
// that does not have the program.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-baskets.mjs
import { act, clean, ensureConnected, failures, fixtures, go, ixOf, launch, log, person, refusedBy, reset, setMode, signerOf, sleep, text } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const K = f.basket;
const P = f.people;
const quote = async (p, side, shares) => {
  await p.page.getByTestId(`side-${side}`).click();
  await p.page.getByRole('textbox', { name: 'Shares' }).fill(shares);
  await p.page.locator(`[data-testid="quote"][data-side="${side}"]`).waitFor({ timeout: 15000 });
  await sleep(400);
};

try {
  const v = await person(browser, { name: 'visitor' });
  await go(v, '/baskets');
  await v.page.getByTestId('baskets').waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('baskets').locator('li').count()) === 2 && /3 shares outstanding/.test(await text(v.page.getByTestId(`basket-${K.main}`))), 'the index lists both baskets with their shares outstanding');
  await go(v, `/baskets/${K.main}`);
  await v.page.getByTestId('basket-view').waitFor({ timeout: 25000 });
  log(/majors: what one share is/.test(await text(v.page.locator('#parts-h'))), 'the basket page is titled by its label');
  log((await v.page.getByTestId('basket-view').getAttribute('data-solvent')) === 'true' && /Every vault covers the shares outstanding/.test(await text(v.page.getByTestId('solvent'))), 'it says every vault covers the shares outstanding');
  log((await v.page.getByTestId('components').locator('li').count()) === 3, 'three components, each with its amount per share and what the vault holds');
  await v.page.getByTestId(`freeze-${K.a}`).waitFor({ timeout: 15000 });
  log(/issuer can freeze accounts/.test(await text(v.page.getByTestId(`freeze-${K.a}`))) && (await v.page.getByTestId(`freeze-${K.c}`).count()) === 0, 'a component whose issuer can freeze says so; the others do not');
  log(/no manager, fee, rebalance or pause/.test(await text(v.page.getByTestId('basket-rules'))) && /rounding always favours the basket/.test(await text(v.page.getByTestId('basket-rules'))), 'and the page says there is no manager, fee, rebalance or pause, and which way rounding goes');
  await quote(v, 'mint', '1.5');
  log(/3 /.test(await text(v.page.getByTestId(`line-${K.a}`))) && /1\.125/.test(await text(v.page.getByTestId(`line-${K.b}`))) && (await v.page.getByTestId(`line-${K.c}`).getAttribute('data-exact')) === 'false' && /0\.000011 .*\(rounded\)/.test(await text(v.page.getByTestId(`line-${K.c}`))), 'a mint of 1.5 shares needs 3, 1.125 and 0.000011, the last rounded up from 0.0000105');
  await quote(v, 'redeem', '1.5');
  log(/0\.00001 .*\(rounded\)/.test(await text(v.page.getByTestId(`line-${K.c}`))) && /rounded down/.test(await text(v.page.getByTestId('quote'))), 'a redemption of 1.5 pays 0.00001, rounded down');
  log(await v.page.getByTestId('basket-redeem').isDisabled() && /Connect a wallet to sign this/.test(await text(v.page.getByTestId('section-trade'))), 'with no wallet the button is off and says to connect');
  await v.page.screenshot({ path: `${process.env.OUT}/basket-view.png`, fullPage: true });
  await go(v, `/baskets/${K.short}`);
  await v.page.getByTestId('basket-view').waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('basket-view').getAttribute('data-solvent')) === 'false' && /A vault is short/.test(await text(v.page.getByTestId('solvent'))), 'a basket whose vault is short of the shares outstanding says so');
  await go(v, `/baskets/${f.settle.mint}`);
  await v.page.getByTestId('basket-error').waitFor({ timeout: 25000 });
  log(/No basket is known/.test(await text(v.page.getByTestId('basket-error'))), 'an address that is not a basket is said so');
  log(clean(v).length === 0, `visitor: no console error or failed request ${clean(v).join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ minting and redeeming
  const h = await person(browser, { name: 'holder', secret: P.voter.secret });
  await go(h, `/baskets/${K.main}`);
  await ensureConnected(h, P.voter.address);
  await h.page.getByTestId('basket-view').waitFor({ timeout: 25000 });
  await h.page.getByText(/You hold 1\.5 shares/).waitFor({ timeout: 15000 });
  await quote(h, 'mint', '1.5');
  await h.page.getByText(/you hold 100/).first().waitFor({ timeout: 15000 });
  let r = await act(h, 'basket-mint');
  const mt = ixOf(r.tx, 'cross_basket', 'mint_shares');
  console.log('   mint_shares:', JSON.stringify(mt?.args));
  log(r.done && mt && signerOf(mt, P.voter.address) && String(mt.args?.shares) === '1500000', 'Mint the shares signs mint_shares by the holder for 1.5 shares');
  await quote(h, 'mint', '1000');
  await h.page.getByText(/not enough/).first().waitFor({ timeout: 15000 });
  const rf = await refusedBy(h, 'basket-mint');
  log(rf.shown && /holds/.test(rf.message) && rf.n === 0, `minting more than the components allow is marked on the quote and refused in the API’s words (${rf.message.slice(0, 80)})`);
  await quote(h, 'redeem', '1');
  r = await act(h, 'basket-redeem');
  const rd = ixOf(r.tx, 'cross_basket', 'redeem_shares');
  log(r.done && rd && String(rd.args?.shares) === '1000000', 'Redeem signs redeem_shares for 1 share');
  await quote(h, 'redeem', '2');
  log(await h.page.getByTestId('basket-redeem').isDisabled() && /You hold 1\.5 shares/.test(await text(h.page.getByTestId('basket-redeem-reason'))), 'redeeming more shares than held is off, and says how many are held');
  await h.page.getByRole('textbox', { name: 'Shares' }).fill('0.0000001');
  log(/at most 6 decimals/.test(await text(h.page.getByTestId('section-trade'))), 'a share amount finer than six decimals is named');
  log(clean(h, ['422']).length === 0, `holder: no console error or failed request ${clean(h, ['422']).join(' | ')}`);
  await h.ctx.close();

  // ------------------------------------------------------------------ creating a basket
  const c = await person(browser, { name: 'creator', secret: P.voter.secret });
  await go(c, '/baskets/new');
  await ensureConnected(c, P.voter.address);
  await c.page.getByTestId('basket-form').waitFor({ timeout: 25000 });
  log(/neither can a token with a transfer fee/.test(await text(c.page.getByTestId('basket-warning'))) && /freeze authority/.test(await text(c.page.getByTestId('basket-warning'))), 'the page warns what cannot be a component and about a freeze authority');
  log(await c.page.getByTestId('create-basket').isDisabled(), 'Create is off until the form is filled');
  await c.page.getByLabel('Label').fill('duo');
  await c.page.getByLabel('Component 1: token').fill(K.ok);
  await c.page.getByText(/Token with 6 decimals/).first().waitFor({ timeout: 15000 });
  await c.page.getByLabel('Component 1: per share').fill('1');
  await c.page.getByLabel('Component 2: token').fill(K.ok);
  await c.page.getByLabel('Component 2: per share').fill('1');
  log(/A token is a component once/.test(await text(c.page.getByTestId('row-1'))), 'the same token twice is named');
  await c.page.getByLabel('Component 2: token').fill(K.unsafe);
  await c.page.getByTestId('row-1').getByText(/has a transfer fee/).waitFor({ timeout: 15000 });
  log(/has a transfer fee/.test(await text(c.page.getByTestId('row-1'))) && (await c.page.getByTestId('create-basket').isDisabled()), 'a token with a transfer fee is refused as a component, in words, before anything is built');
  await c.page.getByLabel('Component 2: token').fill(K.fresh);
  await c.page.getByLabel('Component 2: per share').fill('0.5');
  await c.page.getByTestId('row-1').getByText(/Token with 6 decimals/).waitFor({ timeout: 15000 });
  await c.page.getByTestId('add-component').click();
  for (let i = 4; i <= 6; i++) await c.page.getByTestId('add-component').click();
  log(/address lookup table/.test(await text(c.page.getByTestId('many-note'))), 'more than five components says a lookup table may be needed');
  for (let i = 6; i >= 3; i--) await c.page.getByLabel(`Remove component ${i}`).click();
  r = await act(c, 'create-basket');
  const cb = ixOf(r.tx, 'cross_basket', 'create_basket');
  console.log('   create_basket:', JSON.stringify(cb?.args));
  log(r.done && cb && signerOf(cb, P.voter.address) && JSON.stringify(cb.args).includes('duo'), 'Create the basket signs create_basket by the creator');
  log(JSON.stringify(cb?.args).includes('1000000') && JSON.stringify(cb?.args).includes('500000'), 'with 1 and 0.5 tokens per share in atoms');
  await c.page.getByTestId('made').waitFor();
  await c.page.screenshot({ path: `${process.env.OUT}/basket-new.png`, fullPage: true });
  log(clean(c).length === 0, `creator: no console error or failed request ${clean(c).join(' | ')}`);
  await c.ctx.close();

  // ------------------------------------------------------------------ the program is not on the cluster
  await setMode('absent');
  const n = await person(browser, { name: 'absent', secret: P.voter.secret });
  await go(n, `/baskets/${K.main}`);
  await n.page.getByTestId('basket-not-deployed').waitFor({ timeout: 25000 });
  const notice = n.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first();
  await notice.waitFor({ timeout: 15000 });
  log(/Built, not on devnet yet/.test(await text(notice)), 'on a cluster without cross_basket the page says it is built, not on devnet yet');
  await go(n, '/baskets/new');
  await ensureConnected(n, P.voter.address);
  await n.page.getByLabel('Label').fill('duo');
  await n.page.getByLabel('Component 1: token').fill(K.ok);
  await n.page.getByText(/Token with 6 decimals/).first().waitFor({ timeout: 15000 });
  await n.page.getByLabel('Component 1: per share').fill('1');
  await n.page.getByLabel('Component 2: token').fill(K.fresh);
  await n.page.getByLabel('Component 2: per share').fill('1');
  log(await n.page.getByTestId('create-basket').isDisabled() && /not on devnet yet/.test(await text(n.page.getByTestId('create-basket-reason'))), 'creating one is off with a valid form, and says why');
  await n.page.screenshot({ path: `${process.env.OUT}/basket-absent.png`, fullPage: true });
  log(clean(n).length === 0, `absent: no console error or failed request ${clean(n).join(' | ')}`);
  await n.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
