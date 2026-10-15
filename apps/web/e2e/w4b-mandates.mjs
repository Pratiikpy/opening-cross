// W4B: auto-invest mandates (S4, J2) and the agents page. The owner's side (create with limits and a first funding, fund, change the limits, withdraw, revoke), the
// agent's side (place an order inside the limits, a sealed cross's salt, cancel), anyone's sweep, the mandate page for a visitor in every state (active, empty,
// revoked, expired), and the agent guard; each judged on the decoded transaction the wallet signed, with the careless states (the owner as its own agent, limits out
// of bounds, a price off the grid, a mandate that cannot place an order, an order that does not exist, a transaction an agent key must not sign) and the cluster that
// does not have the program.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-mandates.mjs
import { act, clean, ensureConnected, failures, fixtures, go, hasAccount, ixOf, launch, log, person, refusedBy, reset, setMode, signerOf, text } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const M = f.mandate;
const P = f.people;
const API = process.env.API_URL;
const post = async (path, body) => (await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const view = async (p, mandate, as) => {
  await go(p, `/mandates/${mandate}`);
  if (as) await ensureConnected(p, as);
  await p.page.getByTestId('mandate-view').waitFor({ timeout: 25000 });
};

try {
  // ------------------------------------------------------------------ a visitor reads each state
  const v = await person(browser, { name: 'visitor' });
  await view(v, M.active);
  const facts = (await text(v.page.locator('#terms'))).replace(/\s+/g, ' ');
  log((await v.page.getByTestId('mandate-status').textContent()) === 'active' && /Committed so far120, 380 left under the cap/.test(facts.replace(/ /g, ' ').replace('Committed so far', 'Committed so far')) || /Committed so far\s*120, 380 left under the cap/.test(facts), `an active mandate shows its limits, what it committed and what is left under the cap (${facts.slice(0, 150)})`);
  log(/Share of a cross’s supply\s*5% per order/.test(facts) && /Vault balance\s*300/.test(facts), 'its share limit and its vault');
  log((await v.page.getByTestId('allow-view').locator('li').count()) === 2 && /a creator/.test(await text(v.page.getByTestId('allow-view'))) && /a base token/.test(await text(v.page.getByTestId('allow-view'))), 'and what the agent may buy: a creator and a base token');
  log(/The agent can place an order now/.test(await text(v.page.getByTestId('can-place'))), 'it says the agent can place an order now');
  log(/What is not enforced/.test(await text(v.page.getByTestId('not-enforced'))) && /worst case small and known/.test(await text(v.page.getByTestId('not-enforced'))), 'and says plainly what is not enforced');
  log(/Connect the owner’s wallet/.test(await text(v.page.getByTestId('connect-hint'))) && (await v.page.getByTestId('revoke-mandate').count()) === 0, 'a visitor is offered no control of it');
  log((await v.page.getByTestId('orders').locator('li').count()) === 2, 'two orders it placed are listed');
  await v.page.screenshot({ path: `${process.env.OUT}/mandate-visitor.png`, fullPage: true });
  await view(v, M.empty);
  const bl = await text(v.page.getByTestId('blockers'));
  log(/vault is empty/.test(bl) && /needs SOL to pay the rent/.test(bl), 'an empty mandate says why no order can be placed: no tokens, no SOL for rent');
  await view(v, M.revoked);
  log((await v.page.getByTestId('mandate-status').textContent()) === 'revoked' && /revoked this mandate for good/.test(await text(v.page.getByTestId('blockers'))), 'a revoked mandate says it is revoked for good');
  await view(v, M.expired);
  log(/has expired/.test(await text(v.page.getByTestId('blockers'))), 'an expired mandate says so');
  await go(v, `/mandates/${f.settle.mint}`);
  await v.page.getByTestId('mandate-error').waitFor({ timeout: 25000 });
  log(/No mandate is known/.test(await text(v.page.getByTestId('mandate-error'))), 'an address that is not a mandate is said so');
  await go(v, '/mandates');
  await v.page.getByTestId('connect-hint').waitFor({ timeout: 25000 });
  log(/It does not make an agent.s judgement good/.test(await text(v.page.getByTestId('mandate-promise'))), 'the mandates page says a mandate does not make an agent’s judgement good');
  log(await v.page.getByTestId('create-mandate').isDisabled(), 'and with no wallet Create is off');
  log(clean(v).length === 0, `visitor: no console error or failed request ${clean(v).join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ the owner creates a mandate
  const o = await person(browser, { name: 'owner', secret: f.secret });
  await go(o, '/mandates');
  await ensureConnected(o, f.wallet);
  await o.page.getByTestId('owned-list').waitFor({ timeout: 25000 });
  log((await o.page.getByTestId('owned-list').locator('li').count()) === 4, 'the owner sees the four mandates it owns');
  await o.page.getByLabel('Agent’s key').fill(f.wallet);
  log(/different key from the owner/.test(await text(o.page.getByTestId('create-form'))), 'naming itself as the agent is refused in words');
  await o.page.getByLabel('Agent’s key').fill(P.agent.address);
  await o.page.getByLabel('Quote token').fill(f.quoteMint);
  await o.page.getByText('Quote token with 6 decimals').or(o.page.getByText(/Token with 6 decimals/)).first().waitFor({ timeout: 15000 });
  await o.page.getByLabel(/^Most one order may escrow/).fill('50');
  await o.page.getByLabel(/^Lifetime cap/).fill('20');
  log(/at least the most one order may escrow/.test(await text(o.page.getByTestId('limits-form'))), 'a cap below the per-order limit is named');
  await o.page.getByLabel(/^Lifetime cap/).fill('200');
  await o.page.getByLabel(/^Most of a cross/).fill('30');
  log(/at most 25 percent/.test(await text(o.page.getByTestId('limits-form'))), 'a share above 25% is named');
  await o.page.getByLabel(/^Most of a cross/).fill('10');
  await o.page.getByLabel('Expires in, days').fill('14');
  await o.page.getByLabel('Address of entry 1').fill(f.wallet);
  await o.page.getByTestId('add-allow').click();
  await o.page.getByLabel('Address of entry 2').fill(M.baseMint);
  await o.page.getByLabel('Kind of entry 2').selectOption('base_mint');
  await o.page.getByLabel('Remove entry 1').click();
  log((await o.page.getByTestId('allow-list').getByLabel(/^Address of entry/).count()) === 1, 'allow-list entries can be added and removed');
  await o.page.getByTestId('add-allow').click();
  await o.page.getByLabel('Address of entry 2').fill(f.wallet);
  await o.page.getByLabel('Fund the vault now', { exact: false }).fill('100');
  await o.page.getByLabel('SOL for the agent’s order rent').fill('0.05');
  let r = await act(o, 'create-mandate');
  const cm = ixOf(r.tx, 'cross_mandate', 'create_mandate');
  console.log('   create_mandate:', JSON.stringify(cm?.args).slice(0, 500));
  log(r.done && cm && signerOf(cm, f.wallet), `Create signs create_mandate by the owner (${r.shape.join(', ')})`);
  const lim = cm?.args?.limits;
  log(String(lim?.maxPerOrder) === '50000000' && String(lim?.totalCap) === '200000000' && lim?.maxShareBps === 1000 && lim?.allow?.length === 2, 'with a 50 per-order limit, a 200 cap, a 10% share and two allow entries');
  const fx = ixOf(r.tx, 'cross_mandate', 'fund');
  log(fx && String(fx.args?.amount) === '100000000' && String(fx.args?.lamports) === '50000000', 'and the first funding in the same transaction: 100 tokens and 0.05 SOL');
  await o.page.getByTestId('made').waitFor();
  await o.page.screenshot({ path: `${process.env.OUT}/mandate-create.png`, fullPage: true });
  log(clean(o).length === 0, `create: no console error or failed request ${clean(o).join(' | ')}`);

  // ------------------------------------------------------------------ the owner manages one
  await view(o, M.active, f.wallet);
  await o.page.getByTestId('fund-box').waitFor({ timeout: 15000 });
  log(await o.page.getByTestId('fund-mandate').isDisabled(), 'Fund is off until an amount is given');
  await o.page.getByLabel(/^Quote tokens/).first().fill('25');
  r = await act(o, 'fund-mandate');
  const fu = ixOf(r.tx, 'cross_mandate', 'fund');
  log(r.done && fu && String(fu.args?.amount) === '25000000', 'Fund signs fund for 25 tokens');
  await o.page.getByLabel(/^Quote tokens to take out/).fill('400');
  log(await o.page.getByTestId('withdraw-mandate').isDisabled() && /The vault holds 300/.test(await text(o.page.getByTestId('withdraw-box'))), 'withdrawing more than the vault holds is refused in words');
  await o.page.getByLabel(/^Quote tokens to take out/).fill('10');
  r = await act(o, 'withdraw-mandate');
  const wd = ixOf(r.tx, 'cross_mandate', 'withdraw');
  log(r.done && wd && String(wd.args?.amount) === '10000000', 'Withdraw signs withdraw for 10 tokens');
  r = await act(o, 'withdraw-lamports');
  log(r.done && ixOf(r.tx, 'cross_mandate', 'withdraw_lamports'), 'Withdraw the SOL signs withdraw_lamports');
  await o.page.getByTestId('limits-details').locator('summary').click();
  await o.page.getByLabel(/^Lifetime cap/).fill('250');
  r = await act(o, 'set-limits');
  const sl = ixOf(r.tx, 'cross_mandate', 'set_limits');
  log(r.done && sl && String(sl.args?.limits?.totalCap) === '250000000', 'Save the limits signs set_limits with a 250 cap');
  r = await act(o, 'revoke-mandate');
  const rv = ixOf(r.tx, 'cross_mandate', 'revoke');
  log(r.done && rv && signerOf(rv, f.wallet), 'Revoke signs revoke by the owner');
  await o.page.screenshot({ path: `${process.env.OUT}/mandate-owner.png`, fullPage: true });
  await view(o, M.revoked, f.wallet);
  log(await o.page.getByTestId('revoke-mandate').isDisabled() && /stays revoked/.test(await text(o.page.getByTestId('revoke-box'))) && (await o.page.getByTestId('limits-details').count()) === 0, 'a revoked mandate can be revoked no more, cannot be re-limited, and can still be withdrawn from');
  log(await o.page.getByTestId('withdraw-mandate').isEnabled(), 'its vault can still be withdrawn');
  await view(o, M.other, f.wallet);
  log(/Only the owner/.test(await text(o.page.getByTestId('not-owner'))) && (await o.page.getByTestId('revoke-mandate').count()) === 0, 'on someone else’s mandate the owner’s controls are not shown');
  log(clean(o).length === 0, `owner: no console error or failed request ${clean(o).join(' | ')}`);
  await o.ctx.close();

  // ------------------------------------------------------------------ the agent places orders
  const a = await person(browser, { name: 'agent', secret: P.agent.secret });
  await go(a, '/mandates');
  await ensureConnected(a, P.agent.address);
  await a.page.getByTestId('agent-list').waitFor({ timeout: 25000 });
  log((await a.page.getByTestId('agent-list').locator('li').count()) === 5, 'the agent sees the five mandates it acts for');
  await view(a, M.active, P.agent.address);
  await a.page.getByTestId('order-box').waitFor({ timeout: 15000 });
  await a.page.getByLabel('Cross', { exact: true }).fill(M.cross);
  await a.page.getByText(/Live, open book/).waitFor({ timeout: 15000 });
  await a.page.getByLabel('Price per token').fill('1.35');
  await a.page.getByLabel('Tokens to buy').fill('10');
  log(/not on the cross.s grid/.test(await text(a.page.getByTestId('order-box'))) && (await a.page.getByTestId('place-order').isDisabled()), 'a price off the cross’s grid is named and the order is off');
  await a.page.getByLabel('Price per token').fill('1.3');
  r = await act(a, 'place-order');
  const po = ixOf(r.tx, 'cross_mandate', 'place_order');
  console.log('   place_order:', JSON.stringify(po?.args));
  log(r.done && po && signerOf(po, P.agent.address), 'Place the order signs place_order by the agent');
  log(hasAccount(po, M.active) && hasAccount(po, M.cross), 'naming the mandate and the cross');
  log(String(po?.args?.price) === '1300000' && String(po?.args?.quantity) === '10000000', 'at 1.3 for 10 tokens');
  await a.page.getByTestId('placed').waitFor();
  log(/Order placed with nonce 0/.test(await text(a.page.getByTestId('placed'))), 'and shows the nonce');
  const g = await post('/v1/tx/mandate-place-order', { agent: P.agent.address, mandate: M.active, cross: M.cross, price: '1300000', quantity: '10000000' });
  await a.page.getByLabel('Cross', { exact: true }).fill(M.sealedCross);
  await a.page.getByText(/Live, sealed book/).waitFor({ timeout: 15000 });
  await a.page.getByTestId('salt').waitFor();
  const salt = (await text(a.page.getByTestId('salt'))).match(/[0-9a-f]{64}/)?.[0];
  log(Boolean(salt), 'a sealed cross shows a fresh salt to keep for the reveal');
  await a.page.getByLabel('Price per token').fill('1.3');
  await a.page.getByLabel('Tokens to buy').fill('5');
  r = await act(a, 'place-order');
  log(r.done && ixOf(r.tx, 'cross_mandate', 'place_order'), 'a sealed order is placed with that salt');
  await a.page.getByLabel('Order nonce').fill('7');
  await a.page.getByLabel('Cross of the order').fill(M.cross);
  const rf = await refusedBy(a, 'cancel-order');
  log(rf.shown && rf.n === 0, `cancelling an order that does not exist is refused in the API’s words and nothing is signed (${rf.message.slice(0, 90)})`);
  await a.page.screenshot({ path: `${process.env.OUT}/mandate-agent.png`, fullPage: true });
  await view(a, M.empty, P.agent.address);
  await a.page.getByTestId('order-box').waitFor();
  await a.page.getByLabel('Cross', { exact: true }).fill(M.cross);
  await a.page.getByText(/Live, open book/).waitFor({ timeout: 15000 });
  await a.page.getByLabel('Price per token').fill('1.3');
  await a.page.getByLabel('Tokens to buy').fill('10');
  log(await a.page.getByTestId('place-order').isDisabled() && /vault is empty/.test(await text(a.page.getByTestId('place-order-reason'))), 'a mandate that cannot place an order says why on the order button');
  await view(a, M.active, P.agent.address);
  log((await a.page.getByTestId('fund-mandate').count()) === 0, 'the agent is offered no funding or withdrawal');
  await a.ctx.close();
  void g;

  // ------------------------------------------------------------------ anyone sweeps
  const s = await person(browser, { name: 'anyone', secret: P.other.secret });
  await view(s, M.active, P.other.address);
  await s.page.getByLabel('Base token to sweep').fill(M.baseMint);
  const sw = await refusedBy(s, 'sweep-mandate');
  log(sw.shown && sw.n === 0, `sweeping when the signer account holds nothing is refused in words and nothing is signed (${sw.message.slice(0, 90)})`);
  await s.ctx.close();

  // ------------------------------------------------------------------ the agents page and the guard
  const place = await post('/v1/tx/mandate-place-order', { agent: P.agent.address, mandate: M.active, cross: M.cross, price: '1300000', quantity: '10000000' });
  const wdraw = await post('/v1/tx/mandate-withdraw', { owner: f.wallet, mandate: M.active });
  const gp = await person(browser, { name: 'guard', secret: P.agent.secret });
  await go(gp, '/agents');
  await ensureConnected(gp, P.agent.address);
  await gp.page.getByTestId('guard-input').waitFor({ timeout: 25000 });
  log(/three instructions of the mandate program/.test(await text(gp.page.getByTestId('agent-rules'))) && /cannot sell/.test(await text(gp.page.getByTestId('agent-rules'))), 'the agents page says what a key can and cannot do');
  log((await gp.page.getByTestId('mcp-tools').locator('li').count()) === 5, 'and lists the five draft tools, none of which creates or empties a mandate');
  await gp.page.getByTestId('guard-input').fill(place.transaction);
  await gp.page.getByTestId('guard-check').click();
  await gp.page.getByTestId('guard-verdict').waitFor({ timeout: 15000 });
  log((await gp.page.getByTestId('guard-verdict').getAttribute('data-ok')) === 'true' && /Safe to sign/.test(await text(gp.page.getByTestId('guard-verdict'))) && /place_order/.test(await text(gp.page.getByTestId('guard-verdict'))), 'the guard passes a place-order draft');
  await gp.page.getByTestId('guard-input').fill(wdraw.transaction);
  await gp.page.getByTestId('guard-check').click();
  await gp.page.waitForFunction(() => document.querySelector('[data-testid="guard-verdict"]')?.getAttribute('data-ok') === 'false', null, { timeout: 15000 });
  log(/Do not sign/.test(await text(gp.page.getByTestId('guard-verdict'))) && /an agent key signs only/.test(await text(gp.page.getByTestId('guard-verdict'))), 'and refuses a withdrawal: an agent key signs only place, cancel and reveal');
  await gp.page.getByTestId('guard-input').fill('AAAA');
  await gp.page.getByTestId('guard-check').click();
  await gp.page.waitForFunction(() => /not a Solana transaction/.test(document.querySelector('[data-testid="guard-verdict"]')?.textContent ?? ''), null, { timeout: 15000 });
  log(true, 'and garbage: not a transaction it can read');
  await gp.page.screenshot({ path: `${process.env.OUT}/agents.png`, fullPage: true });
  log((await gp.page.getByTestId('agent-mandates').locator('li').count()) === 5, 'the agent’s mandates are listed');
  log(clean(gp).length === 0, `agents: no console error or failed request ${clean(gp).join(' | ')}`);
  await gp.ctx.close();

  // ------------------------------------------------------------------ the program is not on the cluster
  await setMode('absent');
  const n = await person(browser, { name: 'absent', secret: f.secret });
  await go(n, `/mandates/${M.active}`);
  await n.page.getByTestId('mandate-not-deployed').waitFor({ timeout: 25000 });
  const notice = n.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first();
  await notice.waitFor({ timeout: 15000 });
  log(/Built, not on devnet yet/.test(await text(notice)), 'on a cluster without cross_mandate the mandate page says it is built, not on devnet yet');
  await go(n, '/mandates');
  await ensureConnected(n, f.wallet);
  await n.page.getByLabel('Agent’s key').fill(P.agent.address);
  await n.page.getByLabel('Quote token').fill(f.quoteMint);
  await n.page.getByLabel(/^Most one order may escrow/).fill('50');
  await n.page.getByLabel(/^Lifetime cap/).fill('200');
  await n.page.getByLabel('Address of entry 1').fill(f.wallet);
  log(await n.page.getByTestId('create-mandate').isDisabled() && /not on devnet yet/.test(await text(n.page.getByTestId('create-mandate-reason'))), 'creating one is off with a valid form, and says why');
  await n.page.screenshot({ path: `${process.env.OUT}/mandate-absent.png`, fullPage: true });
  log(clean(n).length === 0, `absent: no console error or failed request ${clean(n).join(' | ')}`);
  await n.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
