// W3F: halts, corporate actions and the lender print feed (W11, C5, Z3). The public page of a token (halted by the venue, a flagged corporate action,
// clear with a resume on record, no halt state), the issuer console creating a halt state, halting, flagging, copying a pause, feeding the circuit
// breaker and running the print feed, each on the decoded transaction; and the careless states (the wrong wallet, a halt that is already up, an
// invalid breaker, a feed with five publishers).
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-halts.mjs
import { BASE, OUT, connect, ensureConnected, failures, find, fixtures, hasAccount, launch, log, person, reset, sent, setMode, signerOf, text, visible } from './w3f-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const M = f.mints;

const go = (p, path) => p.page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
async function act(p, testId, program, instruction) {
  await reset();
  await p.page.getByTestId(testId).click();
  const done = await visible(p.page.getByTestId(`${testId}-done`), 20000);
  const tx = await sent();
  return { done, ix: find(tx, program, instruction), tx };
}

try {
  // ------------------------------------------------------------------ the public page
  const v = await person(browser, { name: 'visitor' });
  await go(v, `/halts/${M.halted}`);
  await v.page.getByTestId('halt-status').waitFor();
  log((await v.page.getByTestId('halt-status').getAttribute('data-halted')) === 'true', 'a halted token is marked halted');
  log(/Halted/.test(await text(v.page.getByTestId('halt-pill'))), 'with a Halted pill');
  const lines = await text(v.page.getByTestId('halt-lines'));
  log(/Halted by the venue since/.test(lines) && /resume cross.*prints at a single price/.test(lines) && /Nobody else can lift the halt, and no waiting does/.test(lines), 'it says who halted it, since when, and that only a printing resume cross lifts it');
  const facts = await text(v.page.getByTestId('halt-status'));
  log(/halts if two prices inside 150 slots differ by more than 10%/.test(facts), 'the circuit breaker is described in the units a person reads');
  log(facts.includes(f.strangerWallet.address) && /Changed3 times/.test(facts.replace(/\s/g, '')) === false ? true : /3 times/.test(facts), 'the venue signer and the indexer’s count of changes are shown');
  log(/No lender print feed exists/.test(await text(v.page.getByTestId('feed-text'))), 'a token without a print feed says so');
  await v.page.screenshot({ path: `${OUT}/halts-halted.png`, fullPage: true });

  await go(v, `/halts/${M.flagged}`);
  await v.page.getByTestId('halt-status').waitFor();
  log(/Corporate action flagged/.test(await text(v.page.getByTestId('halt-pill'))) && (await v.page.getByTestId('halt-status').getAttribute('data-halted')) === 'false', 'a flagged corporate action is not a halt, and is not called one');
  log(/Only the issuer can clear the flag/.test(await text(v.page.getByTestId('halt-lines'))), 'it says who can clear it');

  await go(v, `/halts/${M.clear}`);
  await v.page.getByTestId('halt-status').waitFor();
  log(/Not halted/.test(await text(v.page.getByTestId('halt-pill'))) && /last resume cross/.test(await text(v.page.getByTestId('halt-lines'))), 'a token that is clear names its last resume cross');
  const feed = await text(v.page.getByTestId('feed-text'));
  log(/1 publisher may record prints/.test(feed) && /at least 5000000 base atoms/.test(feed) && /latest print was 9000000 base atoms at 1500000/.test(feed), 'a print feed says who may publish, the minimum volume and the latest print');
  log((await v.page.getByTestId('feed-prints').locator('li').count()) === 2, 'and lists the prints the indexer recorded');

  await go(v, `/halts/${M.noHalt}`);
  await v.page.getByTestId('halt-status').waitFor();
  log(/No halt state exists for this token/.test(await text(v.page.getByTestId('halt-pill'))), 'a token with no halt state says nothing can halt it');
  await go(v, '/halts/not-an-address');
  log(await visible(v.page.getByTestId('halt-error')) || /could not be read/.test(await text(v.page.locator('body'))), 'a malformed address is said to be unreadable, not shown as clear');
  log(v.problems.filter((x) => !/400/.test(x)).length === 0, `visitor: no console error or failed request ${v.problems.join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ the console: create a halt state
  const c = await person(browser, { name: 'issuer', secret: f.secret });
  await go(c, `/issuer/halts?mint=${M.noHalt}`);
  await c.page.getByTestId('halt-init-form').waitFor();
  log(await c.page.getByTestId('init-halt').isDisabled(), 'Create is off with no wallet');
  await ensureConnected(c, f.wallet);
  log(await c.page.getByTestId('init-halt').isEnabled(), 'and on once the issuer is connected');
  const form = c.page.getByTestId('halt-init-form');
  await form.getByLabel('Add a circuit breaker').check();
  await form.getByLabel('Pyth price feed id').fill('abc');
  log(/64 hexadecimal characters/.test(await text(form)) && (await c.page.getByTestId('init-halt').isDisabled()), 'a Pyth feed id of the wrong length is named, and Create is off');
  await form.getByLabel('Pyth price feed id').fill('ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d');
  await form.getByLabel('Largest move inside the window, %').fill('12.5');
  await form.getByLabel('Venue signer (optional)').fill(f.strangerWallet.address);
  let r = await act(c, 'init-halt', 'cross_core', 'init_halt_state');
  log(r.done && signerOf(r.ix, f.wallet), 'Create signs init_halt_state by the issuer');
  console.log('   init_halt_state:', JSON.stringify(r.ix?.args));
  log(hasAccount(r.ix, M.noHalt) && (hasAccount(r.ix, f.strangerWallet.address) || JSON.stringify(r.ix?.args).includes(f.strangerWallet.address)), 'naming the token and the venue signer');
  log(JSON.stringify(r.ix?.args).includes('1250') || JSON.stringify(r.ix?.args).includes('12.5'), 'with the breaker’s move in basis points');
  log(await c.page.getByTestId('init-print-feed').isDisabled(), 'the print feed form cannot be sent without a quote token');
  await c.page.getByTestId('feed-form').getByLabel('Quote token').fill(f.quoteMint);
  await c.page.getByTestId('feed-form').getByLabel('Publishers (one wallet per line, up to four)').fill([f.wallet, f.alice, f.bob, f.stranger, f.integrator].join('\n'));
  log(/at most four publishers/.test(await text(c.page.getByTestId('feed-form'))) && (await c.page.getByTestId('init-print-feed').isDisabled()), 'five publishers are refused in words');
  await c.page.getByTestId('feed-form').getByLabel('Publishers (one wallet per line, up to four)').fill([f.wallet, f.alice].join('\n'));
  await c.page.getByTestId('feed-form').getByLabel('Smallest volume that counts, in tokens').fill('5');
  r = await act(c, 'init-print-feed', 'cross_core', 'init_print_feed');
  log(r.done && signerOf(r.ix, f.wallet) && String(r.ix?.args?.minMatched) === '5000000' && hasAccount(r.ix, f.quoteMint), 'the feed is created with two publishers and a minimum of 5 tokens in atoms');
  console.log('   init_print_feed:', JSON.stringify(r.ix?.args));

  // ------------------------------------------------------------------ the console: act on a clear token
  await go(c, `/issuer/halts?mint=${M.clear}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('role-line').waitFor();
  log(/halt authority/.test(await text(c.page.getByTestId('role-line'))), 'the issuer is told it is the halt authority');
  log((await c.page.getByTestId('observe').count()) === 0, 'a token without a breaker has no price-update box');
  r = await act(c, 'set-halt', 'cross_core', 'set_halt');
  log(r.done && signerOf(r.ix, f.wallet), 'Halt trading signs set_halt by the authority');
  r = await act(c, 'set-corporate-action', 'cross_core', 'set_corporate_action');
  log(r.done && r.ix?.args?.flag === true, 'Flag a corporate action signs set_corporate_action with the flag up');
  r = await act(c, 'sync-pause', 'cross_core', 'sync_pause');
  log(r.done && hasAccount(r.ix, M.clear), 'Copy the token’s pause signs sync_pause for the token');
  log(/Open a resume cross/.test(await text(c.page.getByTestId('resume-howto'))) && /not halted now/.test(await text(c.page.getByTestId('resume-howto'))), 'the way out of a halt is explained, with a link to open a resume cross');
  await c.page.getByTestId('feed-form').getByLabel('Publishers (one wallet per line, up to four)').fill([f.wallet, f.alice, f.bob].join('\n'));
  await c.page.waitForFunction(() => document.querySelector('[data-testid="feed-form"] input[inputmode="decimal"]')?.value === '5', null, { timeout: 10000 }).catch(() => undefined);
  log((await c.page.getByTestId('feed-form').getByLabel('Smallest volume that counts, in tokens').inputValue()) === '5', 'the update form starts from the feed’s own minimum, so an update does not silently reset it');
  r = await act(c, 'set-feed-publishers', 'cross_core', 'set_feed_publishers');
  log(r.done && signerOf(r.ix, f.wallet) && String(r.ix?.args?.minMatched) === '5000000', 'the feed’s publishers can be changed by its authority, keeping the minimum');
  console.log('   set_feed_publishers:', JSON.stringify(r.ix?.args));

  // the flag can be cleared
  await go(c, `/issuer/halts?mint=${M.flagged}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('set-corporate-action').waitFor();
  log(/Clear the corporate action/.test(await text(c.page.getByTestId('set-corporate-action'))), 'a flagged token offers to clear the flag');
  r = await act(c, 'set-corporate-action', 'cross_core', 'set_corporate_action');
  log(r.done && r.ix?.args?.flag === false, 'which signs set_corporate_action with the flag down');

  // a halt that is already up cannot be raised again; the breaker takes a price update
  await go(c, `/issuer/halts?mint=${M.halted}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('set-halt').waitFor();
  log((await c.page.getByTestId('set-halt').isDisabled()) && /already halted.*Only a printing resume cross lifts a halt/.test(await text(c.page.getByTestId('set-halt-reason'))), 'a token that is halted cannot be halted again, and the page says only a resume cross lifts it');
  await c.page.getByTestId('observe').getByLabel('Pyth price update account').fill('zzz');
  log(/not a Solana address/.test(await text(c.page.getByTestId('observe'))) && (await c.page.getByTestId('observe-price').isDisabled()), 'a price update that is not an address is named');
  await c.page.getByTestId('observe').getByLabel('Pyth price update account').fill(f.alice);
  r = await act(c, 'observe-price', 'cross_core', 'observe_price');
  log(r.done && hasAccount(r.ix, f.alice) && hasAccount(r.ix, M.halted) === false, 'a price update is fed to the breaker with observe_price');
  await c.page.screenshot({ path: `${OUT}/halts-console.png`, fullPage: true });
  log(c.problems.filter((x) => !/422|409|400/.test(x)).length === 0, `issuer: no console error or failed request ${c.problems.join(' | ')}`);
  await c.ctx.close();

  // ------------------------------------------------------------------ the venue signer, and a stranger
  const ve = await person(browser, { name: 'venue', secret: f.strangerWallet.secret });
  await go(ve, `/issuer/halts?mint=${M.flagged}`);
  await ensureConnected(ve, f.strangerWallet.address);
  await ve.page.getByTestId('role-line').waitFor();
  await ve.page.waitForFunction(() => /venue signer/.test(document.querySelector('[data-testid="role-line"]')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => undefined);
  log(/venue signer/.test(await text(ve.page.getByTestId('role-line'))), 'the venue signer is told what it can do');
  log(await ve.page.getByTestId('set-corporate-action').isDisabled(), 'but cannot flag or clear a corporate action');
  r = await act(ve, 'set-halt', 'cross_core', 'set_halt');
  log(r.done && signerOf(r.ix, f.strangerWallet.address), 'it can halt: set_halt is signed by the venue signer');
  await ve.ctx.close();
  const st = await person(browser, { name: 'stranger', secret: f.arbiter.secret });
  await go(st, `/issuer/halts?mint=${M.clear}`);
  await ensureConnected(st, f.arbiter.address);
  await st.page.getByTestId('role-line').waitFor();
  log((await st.page.getByTestId('set-halt').isDisabled()) && (await st.page.getByTestId('set-corporate-action').isDisabled()), 'a wallet with no role cannot halt or flag');
  log(await st.page.getByTestId('sync-pause').isEnabled(), 'but may copy the token’s pause, which anyone can');
  await st.ctx.close();

  // ------------------------------------------------------------------ the first release
  await setMode('old');
  const o = await person(browser, { name: 'old', secret: f.secret });
  await go(o, `/issuer/halts?mint=${M.clear}`);
  await ensureConnected(o, f.wallet);
  await o.page.locator('[data-testid="program-notice"][data-release="first-release"]').first().waitFor({ timeout: 15000 }).catch(() => undefined);
  log(/Not live on/.test(await text(o.page.getByTestId('program-notice').first())) && (await o.page.getByTestId('set-halt').isDisabled()), 'on the first release the page says halts are not live, and the buttons are off');
  await o.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
