// W3F: the arbiter's ruling (VM7). Who the arbiter is, the challenges waiting for a ruling, the ruling itself on the decoded transaction, a stranger
// closing an unanswered challenge, the admin naming the arbiter, and the states nobody demos: no arbiter named, a slash above the bond, a
// rejection that names a slash, the wrong wallet.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-arbiter.mjs
import { BASE, OUT, api, connect, ensureConnected, failures, find, fixtures, hasAccount, launch, log, person, reset, sent, setMode, signerOf, sleep, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
await api('/__arbiter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ named: true }) });
const C = f.challengeCross;
const id = (n) => `${C}-${n}`;
/** Amounts are shown in quote tokens once the quote mint’s decimals have been read: wait for the sentence instead of the clock. */
const eventually = async (loc, re, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(await text(loc))) return true;
    await sleep(250);
  }
  return false;
};

const go = (p, path) => p.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
async function act(p, testId, program, instruction) {
  await reset();
  await p.page.getByTestId(testId).click();
  const done = await visible(p.page.getByTestId(`${testId}-done`), 20000);
  const tx = await sent();
  return { done, ix: find(tx, program, instruction), tx };
}
const ready = async (p) => {
  await p.page.getByTestId(`challenge-${C}-0`).waitFor({ timeout: 20000 });
  await p.page.waitForFunction(() => !/Reading the arbiter/.test(document.querySelector('[data-testid="standing"]')?.textContent ?? ''), null, { timeout: 15000 });
};

try {
  // ------------------------------------------------------------------ anyone can read
  const v = await person(browser, { name: 'visitor' });
  await go(v, '/arbiter');
  await ready(v);
  log(/Connect a wallet to see whether it is the arbiter/.test(await text(v.page.getByTestId('standing'))), 'a visitor is told to connect a wallet to see whether it is the arbiter');
  log(/2 challenges are waiting for a ruling/.test(await text(v.page.getByTestId('queue-count'))), 'the queue counts the two open challenges');
  log(await eventually(v.page.getByTestId(`cross-${C}`), /bond posted 100 quote, held now 100 quote; 1 declared insider/), 'the cross shows the bond posted and held, and its declared insiders');
  const ch0 = await text(v.page.getByTestId(`challenge-${id(0)}`));
  log(/Challenge 0/.test(ch0) && /Waiting for the arbiter/.test(ch0) && /Evidence hash 0707/.test(ch0) && /Only the hash is on chain/.test(ch0), 'an open challenge shows the wallet accused, the evidence hash and that the document is off chain');
  log((await eventually(v.page.getByTestId(`challenge-${id(2)}`), /Upheld: part of the bond was slashed/)) && (await eventually(v.page.getByTestId(`challenge-${id(2)}`), /Slashed 40 quote/)), 'an upheld challenge shows what was slashed');
  log(/Only the arbiter can rule on this/.test(await text(v.page.getByTestId(`not-arbiter-${id(0)}`))), 'a visitor who is not the arbiter sees no ruling form, and is told why');
  log(await v.page.getByTestId(`expire-${id(0)}`).isDisabled(), 'closing an unanswered challenge needs a wallet');
  log(/Connect the protocol admin wallet/.test(await text(v.page.getByTestId('not-admin'))), 'naming the arbiter asks for the protocol admin');
  await v.page.screenshot({ path: `${OUT}/arbiter-visitor.png`, fullPage: true });
  log(v.problems.length === 0, `visitor: no console error or failed request ${v.problems.join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ a stranger
  const st = await person(browser, { name: 'stranger', secret: f.strangerWallet.secret });
  await go(st, '/arbiter');
  await connect(st, f.strangerWallet.address);
  await ready(st);
  log(/not the arbiter/.test(await text(st.page.getByTestId('standing'))), 'a stranger is told this wallet is not the arbiter');
  log((await st.page.getByTestId(`ruling-${id(0)}`).count()) === 0, 'and gets no ruling form');
  let r = await act(st, `expire-${id(0)}`, 'cross_core', 'expire_challenge');
  log(r.done && hasAccount(r.ix, C) && r.tx[0].feePayer === f.strangerWallet.address, 'anyone can close an unanswered challenge: expire_challenge is signed by the stranger for challenge 0');
  log(/This wallet is not the protocol admin/.test(await text(st.page.getByTestId('not-admin'))), 'the stranger cannot name the arbiter');
  log(st.problems.length === 0, `stranger: no console error or failed request ${st.problems.join(' | ')}`);
  await st.ctx.close();

  // ------------------------------------------------------------------ the arbiter rules
  const a = await person(browser, { name: 'arbiter', secret: f.arbiter.secret });
  await go(a, '/arbiter');
  await connect(a, f.arbiter.address);
  await ready(a);
  log(/This wallet is the arbiter/.test(await text(a.page.getByTestId('standing'))), 'the arbiter is told it is the arbiter');
  const form = a.page.getByTestId(`ruling-${id(0)}`);
  await form.waitFor();
  log(/Rejecting sends the challenger’s deposit to the protocol and slashes nothing/.test(await text(a.page.getByTestId(`ruling-sentence-${id(0)}`))), 'the default ruling is a rejection, and says what it does with the money');
  r = await act(a, `resolve-${id(0)}`, 'cross_core', 'resolve_challenge');
  log(r.done && signerOf(r.ix, f.arbiter.address) && r.ix?.args?.upheld === false, 'Sign the ruling signs resolve_challenge with upheld false by the arbiter');
  console.log('   resolve (reject):', JSON.stringify(r.ix?.args));
  // uphold challenge 1
  await a.page.getByTestId(`decision-uphold-${id(1)}`).check();
  const f1 = a.page.getByTestId(`ruling-${id(1)}`);
  await f1.getByLabel('Slash from the bond, in quote tokens').fill('150');
  log(await eventually(f1, /at most the bond still held, 100 quote/), 'a slash above the bond is named with the bond');
  log(await a.page.getByTestId(`resolve-${id(1)}`).isDisabled(), 'and the ruling cannot be signed');
  await f1.getByLabel('Slash from the bond, in quote tokens').fill('30');
  log(await eventually(a.page.getByTestId(`ruling-sentence-${id(1)}`), /slashes 30 quote from the bond: 15 quote to the challenger and the rest to the protocol/), 'a valid slash says where the money goes');
  r = await act(a, `resolve-${id(1)}`, 'cross_core', 'resolve_challenge');
  log(r.done && r.ix?.args?.upheld === true && String(r.ix?.args?.slash) === '30000000', 'upholding with 30 signs resolve_challenge with upheld true and a slash of 30 quote in atoms');
  console.log('   resolve (uphold):', JSON.stringify(r.ix?.args));
  // a rejection that names a slash
  await a.page.getByTestId(`decision-uphold-${id(0)}`).check();
  await a.page.getByTestId(`ruling-${id(0)}`).getByLabel('Slash from the bond, in quote tokens').fill('5');
  await a.page.getByTestId(`decision-reject-${id(0)}`).check();
  log(/slashes nothing/.test(await text(a.page.getByTestId(`ruling-${id(0)}`))) && (await a.page.getByTestId(`resolve-${id(0)}`).isDisabled()), 'a rejection that names a slash is refused in words before anything is signed');
  log(/This wallet is not the protocol admin/.test(await text(a.page.getByTestId('not-admin'))), 'the arbiter is not the admin');
  await a.page.screenshot({ path: `${OUT}/arbiter-ruling.png`, fullPage: true });
  log(a.problems.length === 0, `arbiter: no console error or failed request ${a.problems.join(' | ')}`);
  await a.ctx.close();

  // ------------------------------------------------------------------ the admin names the arbiter
  const ad = await person(browser, { name: 'admin', secret: f.secret });
  await go(ad, '/arbiter');
  await connect(ad, f.wallet);
  await ready(ad);
  await ad.page.getByTestId('name-form').waitFor();
  log(await ad.page.getByTestId('set-arbiter').isDisabled(), 'Name the arbiter is off until an address is entered');
  await ad.page.getByTestId('name-form').getByLabel('Arbiter wallet').fill('nope');
  log(/not a Solana address/.test(await text(ad.page.getByTestId('name-form'))), 'a wrong address is named as such');
  await ad.page.getByTestId('name-form').getByLabel('Arbiter wallet').fill(f.strangerWallet.address);
  r = await act(ad, 'set-arbiter', 'cross_core', 'set_arbiter');
  console.log('   set_arbiter:', JSON.stringify(r.ix?.args), r.ix?.accounts.length);
  log(r.done && signerOf(r.ix, f.wallet) && (hasAccount(r.ix, f.strangerWallet.address) || r.ix?.args?.arbiter === f.strangerWallet.address), 'the admin signs set_arbiter naming the new arbiter');
  log(/Replaces/.test(await text(ad.page.getByTestId('name-form'))), 'and is told it replaces the current one');
  log(ad.problems.length === 0, `admin: no console error or failed request ${ad.problems.join(' | ')}`);
  await ad.ctx.close();

  // ------------------------------------------------------------------ no arbiter named yet
  await api('/__arbiter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ named: false }) });
  const n = await person(browser, { name: 'unnamed', secret: f.arbiter.secret });
  await go(n, '/arbiter');
  await connect(n, f.arbiter.address);
  await ready(n);
  log(/No arbiter has been named yet/.test(await text(n.page.getByTestId('standing'))), 'with no arbiter named, the page says so');
  log(/No arbiter has been named, so nobody can rule on this yet/.test(await text(n.page.getByTestId(`not-arbiter-${id(0)}`))), 'no ruling form is offered, and the challenge says nobody can rule yet');
  log(/Expired|Closed|Waiting/.test(await text(n.page.getByTestId(`challenge-${id(1)}`))) && (await n.page.getByTestId(`expire-${id(1)}`).isEnabled()), 'closing a challenge unanswered is still possible');
  await n.page.screenshot({ path: `${OUT}/arbiter-unnamed.png`, fullPage: true });
  log(n.problems.length === 0, `unnamed: no console error or failed request ${n.problems.join(' | ')}`);
  await n.ctx.close();
  await api('/__arbiter', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ named: true }) });

  // ------------------------------------------------------------------ the first release
  await setMode('old');
  const o = await person(browser, { name: 'old', secret: f.arbiter.secret });
  await go(o, '/arbiter');
  await connect(o, f.arbiter.address);
  await ready(o);
  await o.page.locator('[data-testid="program-notice"][data-release="first-release"]').first().waitFor({ timeout: 15000 }).catch(() => undefined);
  log(/Not live on/.test(await text(o.page.getByTestId('program-notice').first())), 'on the first release the page says challenges are not live');
  log((await o.page.getByTestId(`resolve-${id(0)}`).isDisabled()) && /first release/.test(await text(o.page.getByTestId(`resolve-${id(0)}-reason`))), 'the ruling button is off on the first release, and says why');
  await setMode('new');
  await o.ctx.close();
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
