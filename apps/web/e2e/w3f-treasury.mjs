// W3F: what any wallet can do on a treasury's public page beyond voting: open a proposal (the authority, or a holder with enough of the supply),
// add quote tokens to the pot, and pay a revenue round. Each on the decoded transaction, with the careless states: too small a holding, a spend
// over the proposal cap, an amount that would round, an empty description.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-treasury.mjs
import { createHash } from 'node:crypto';
import { BASE, OUT, ensureConnected, eventually, failures, find, fixtures, launch, log, person, reset, sent, setMode, signerOf, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const T = f.treasuries.extended;
const go = (p, path) => p.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
async function act(p, testId, program, instruction) {
  await reset();
  await p.page.getByTestId(testId).click();
  const done = await visible(p.page.locator(`xpath=//*[@data-testid="${testId}"]/ancestor::div[1]//p[@role="status"]`), 1).catch(() => false);
  void done;
  await p.page.waitForTimeout(2500);
  const tx = await sent();
  return { ix: find(tx, program, instruction), tx };
}
const sha = (t) => createHash('sha256').update(t).digest('hex');

try {
  const h = await person(browser, { name: 'authority', secret: f.secret });
  await go(h, `/treasury/${T}`);
  await ensureConnected(h, f.wallet);
  await h.page.getByTestId('propose').waitFor({ timeout: 20000 });
  const propose = h.page.getByTestId('propose');
  log(await h.page.getByTestId('propose-submit').isDisabled(), 'Open the proposal is off while the form is empty');
  await propose.getByTestId('propose-amount').fill('250.5');
  await propose.getByTestId('propose-destination').fill('nope');
  await propose.getByTestId('propose-description').fill('  ');
  log(/Solana address/.test(await text(propose)) && /Say what the money is for/.test(await text(propose)), 'a wrong destination and an empty reason are named');
  await propose.getByTestId('propose-amount').fill('0.0000001');
  log(/6 decimal places/.test(await text(propose)), 'an amount that would round is refused in words');
  await propose.getByTestId('propose-amount').fill('250.5');
  await propose.getByTestId('propose-destination').fill(f.bob);
  const why = 'Pay the auditor for the October review';
  await propose.getByTestId('propose-description').fill(why);
  await h.page.waitForFunction(() => /SHA-256 recorded on chain: [0-9a-f]{64}/.test(document.querySelector('[data-testid="propose"]')?.textContent ?? ''), null, { timeout: 5000 });
  log((await text(propose)).includes(sha(why)), 'the description is hashed in the browser and the hash is shown');
  await propose.getByTestId('propose-submit').click();
  await h.page.waitForTimeout(3500);
  let ix = find(await sent(), 'treasury', 'propose');
  log(Boolean(ix) && String(ix.args?.amount) === '250500000' && ix.args?.destination === f.bob, 'the proposal signs propose for 250.5 quote in atoms to the destination');
  log(JSON.stringify(ix?.args).includes(sha(why)) || Buffer.from(Object.values(ix?.args?.descHash ?? {})).toString('hex') === sha(why) || String(ix?.args?.descHash) === sha(why), 'with the description’s hash');
  console.log('   propose:', JSON.stringify(ix?.args));
  // over the cap: 50% of a 10,000 vault
  await propose.getByTestId('propose-amount').fill('9000');
  await reset();
  await propose.getByTestId('propose-submit').click();
  await h.page.waitForTimeout(2500);
  log(/at most/.test(await text(propose)) && (await sent()).length === 0, 'a spend over the proposal cap is refused by the API with the cap, and nothing is signed');
  // a NAV proposal
  await propose.getByTestId('propose-kind').selectOption('open-nav');
  await propose.getByTestId('propose-description').fill('Open the NAV wall for a week');
  await reset();
  await propose.getByTestId('propose-submit').click();
  await h.page.waitForTimeout(3000);
  ix = find(await sent(), 'treasury', 'propose');
  log(Boolean(ix) && String(ix.args?.amount) === '0', 'a NAV proposal is signed with no amount');

  // deposit
  await h.page.getByTestId('deposit-amount').fill('12.5');
  await reset();
  await h.page.getByTestId('deposit-submit').click();
  await h.page.waitForTimeout(3000);
  ix = find(await sent(), 'treasury', 'deposit_distribution');
  log(Boolean(ix) && String(ix.args?.amount) === '12500000', 'adding 12.5 quote to the pot signs deposit_distribution for 12.5 in atoms');
  await h.page.getByTestId('deposit-amount').fill('0.0000001');
  log(/decimal places/.test(await text(h.page.getByTestId('deposit'))) && (await h.page.getByTestId('deposit-submit').count()) === 0, 'a deposit that would round has no button');

  // pay a round
  const payBtn = h.page.locator('[data-testid^="pay-round-"]');
  log((await payBtn.count()) >= 1, 'a round that is over and inside its payment window offers Pay');
  const roundNo = (await payBtn.first().getAttribute('data-testid')).replace('pay-round-', '');
  await reset();
  await payBtn.first().click();
  await h.page.waitForTimeout(3000);
  ix = find(await sent(), 'treasury', 'pay_round');
  log(Boolean(ix) && String(ix.args?.round) === roundNo, `which signs pay_round for round ${roundNo}`);
  await h.page.screenshot({ path: `${OUT}/treasury-holder-extras.png`, fullPage: true });
  log(h.problems.filter((x) => !/422|409|400/.test(x)).length === 0, `authority: no console error or failed request ${h.problems.join(' | ')}`);
  await h.ctx.close();

  // a wallet with no coins
  const s = await person(browser, { name: 'nocoins', secret: f.arbiter.secret });
  await go(s, `/treasury/${T}`);
  await ensureConnected(s, f.arbiter.address);
  await s.page.getByTestId('propose').waitFor({ timeout: 20000 });
  log(/A proposal needs a holding of at least 10 coins \(1% of the supply\)\. This wallet holds 0/.test(await text(s.page.getByTestId('propose-standing'))), 'a wallet with no coins is told what it would need to propose, with the figures');
  log((await s.page.getByTestId('propose-submit').count()) === 0, 'and gets no form');
  log((await s.page.getByTestId('deposit-amount').count()) === 1, 'but can still add to the pot, which anyone can');
  log((await s.page.locator('[data-testid^="pay-round-"]').count()) >= 1, 'and pay a round');
  log(s.problems.filter((x) => !/422|409|400/.test(x)).length === 0, `no coins: no console error or failed request ${s.problems.join(' | ')}`);
  await s.ctx.close();
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
void signerOf;
void eventually;
void act;
