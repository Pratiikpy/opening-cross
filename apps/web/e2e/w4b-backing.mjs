// W4B: the backing watchdog (F6). The public status of a token's backing (backed, stale, short, missing, halted, no policy), the badge and the stale-statement
// banner on a cross page, the check anyone may run, the issuer's console (a halt state that names the watchdog, the policy, the attester's statement), each judged
// on the decoded transaction the wallet signed; the careless states (a check that would change nothing, a policy out of bounds, a halt state that names another
// venue signer, a wallet that is not the attester) and the cluster that does not have the program.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-backing.mjs
import { act, clean, ensureConnected, failures, fixtures, go, hasAccount, ixOf, launch, log, person, reset, setMode, signerOf, text } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const B = f.backing;
const P = f.people;
const status = async (p, mint) => {
  await go(p, `/backing/${mint}`);
  await p.page.getByTestId('backing-badge').waitFor({ timeout: 25000 });
  return text(p.page.getByTestId('backing-badge'));
};

try {
  const v = await person(browser, { name: 'visitor' });
  await go(v, '/backing');
  await v.page.getByTestId('policies').waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('policies').locator('li').count()) === 5, 'the index lists the five tokens that opted in');
  log(/No statement posted/.test(await text(v.page.getByTestId(`policy-${B.missing}`))) && /Commits to 100%/.test(await text(v.page.getByTestId(`policy-${B.backed}`))), 'with their commitments and whether a statement was posted');

  let t = await status(v, B.backed);
  log(/Backed/.test(t) && /covers 120% of the live supply/.test(t) && /committed to 100%/.test(t), `a backed token says it is backed, and by how much (${t.slice(0, 120)})`);
  log((await v.page.getByTestId('backing-badge').getAttribute('data-tone')) === 'ok', 'in the positive tone');
  log(await v.page.getByTestId('backing-check').isDisabled() && /would change nothing/.test(await text(v.page.getByTestId('backing-check-reason'))), 'the check is off for a backed token: it would change nothing');
  log(/proves nothing about what a custodian holds/.test(await text(v.page.locator('#figures'))), 'and the page says a statement is not an audit');
  await v.page.screenshot({ path: `${process.env.OUT}/backing-backed.png`, fullPage: true });
  t = await status(v, B.stale);
  log(/Statement stale/.test(t) && /older than the 60 minutes the policy allows/.test(t) && /not halted yet/.test(t), 'a stale statement says so, and that the next check halts the token');
  t = await status(v, B.short);
  log(/Under-backed/.test(t) && /covers 50% of the live supply, below the 100%/.test(t), 'a short statement says how short');
  t = await status(v, B.missing);
  log(/Unbacked/.test(t) && /No statement has been posted/.test(t), 'a policy with no statement says it cannot be verified');
  t = await status(v, B.halted);
  log(/halted since/.test(t) && /does not lift it: only a printing resume cross does/.test(t), 'a halted token says a fresh statement does not lift the halt');
  log(await v.page.getByTestId('backing-check').isDisabled() && /already halted/.test(await text(v.page.getByTestId('backing-check-reason'))), 'and the check is off: it is already halted');
  t = await status(v, B.noPolicy);
  log(/No backing policy/.test(t) && (await v.page.getByTestId('backing-view').getAttribute('data-verdict')) === 'none', 'a token with no policy says nothing halts it for backing');
  await v.page.screenshot({ path: `${process.env.OUT}/backing-none.png`, fullPage: true });
  log(clean(v).length === 0, `visitor: no console error or failed request ${clean(v).join(' | ')}`);

  // ------------------------------------------------------------------ the cross page
  await go(v, `/crosses/${B.crosses.stale}`);
  await v.page.getByTestId('backing-banner').waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('backing-banner').getAttribute('data-verdict')) === 'Stale' && /Statement stale/.test(await text(v.page.getByTestId('backing-banner'))), 'a cross of a token with a stale statement carries the warning above its tabs');
  await v.page.screenshot({ path: `${process.env.OUT}/backing-cross-banner.png`, fullPage: true });
  await go(v, `/crosses/${B.crosses.halted}`);
  await v.page.getByTestId('backing-banner').waitFor({ timeout: 25000 });
  log(/halted for this reason/.test(await text(v.page.getByTestId('backing-banner'))), 'and for a halted token, that it is halted for this reason');
  await go(v, `/crosses/${B.crosses.backed}`);
  await v.page.getByTestId('backing-badge-ok').waitFor({ timeout: 25000 });
  log(/Backed/.test(await text(v.page.getByTestId('backing-badge-ok'))), 'a backed token’s cross carries the positive badge');
  await go(v, `/crosses/${B.crosses.noPolicy}`);
  await v.page.getByRole('tab', { name: 'Overview' }).waitFor({ timeout: 25000 });
  log((await v.page.getByTestId('backing-banner').count()) + (await v.page.getByTestId('backing-badge-ok').count()) === 0, 'a token with no policy has neither');
  log(clean(v).length === 0, `cross pages: no console error or failed request ${clean(v).join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ anyone runs the check
  const a = await person(browser, { name: 'anyone', secret: P.other.secret });
  await go(a, `/backing/${B.stale}`);
  await ensureConnected(a, P.other.address);
  await a.page.getByTestId('backing-check').waitFor({ timeout: 25000 });
  log(await a.page.getByTestId('backing-check').isEnabled(), 'for a stale statement the check is on');
  let r = await act(a, 'backing-check');
  const ck = ixOf(r.tx, 'cross_backing', 'check');
  log(r.done && ck, `Run the check signs cross_backing.check, paid for by any wallet (${r.shape.join(', ')})`);
  await a.ctx.close();

  // ------------------------------------------------------------------ the issuer's console
  const c = await person(browser, { name: 'issuer', secret: f.secret });
  await go(c, `/issuer/backing?mint=${B.noHalt}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('init-halt-state').waitFor({ timeout: 25000 });
  log(/No halt state exists/.test(await text(c.page.getByTestId('halt-none'))) && (await c.page.getByTestId('create-policy').isDisabled()), 'a token with no halt state is told to create one first, and the policy is off');
  r = await act(c, 'init-halt-state');
  const ih = ixOf(r.tx, 'cross_core', 'init_halt_state');
  console.log('   init_halt_state:', JSON.stringify(ih?.args));
  log(r.done && ih && signerOf(ih, f.wallet) && JSON.stringify(ih.args).includes('venueSigner'), 'Create the halt state signs init_halt_state by the issuer, naming the watchdog as venue signer');
  await go(c, `/issuer/backing?mint=${B.noPolicy}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('policy-form').waitFor({ timeout: 25000 });
  log(/names the watchdog/.test(await text(c.page.getByTestId('halt-ok'))), 'a halt state that names the watchdog is said to');
  await c.page.getByLabel('Attester').fill(P.attester.address);
  await c.page.getByLabel(/^Coverage committed/).fill('250');
  log(/1 to 200 percent/.test(await text(c.page.getByTestId('policy-form'))) && (await c.page.getByTestId('create-policy').isDisabled()), 'a coverage above 200% is named');
  await c.page.getByLabel(/^Coverage committed/).fill('100');
  await c.page.getByLabel('Longest age of a statement').fill('0');
  log(/1 minute to 30 days/.test(await text(c.page.getByTestId('policy-form'))), 'an age of zero is named');
  await c.page.getByLabel('Longest age of a statement').fill('24');
  r = await act(c, 'create-policy');
  const cp = ixOf(r.tx, 'cross_backing', 'create_policy');
  console.log('   create_policy:', JSON.stringify(cp?.args));
  log(r.done && cp && signerOf(cp, f.wallet) && cp.args?.minCoverageBps === 10000 && String(cp.args?.maxAgeSecs) === '86400', 'Create the policy signs create_policy for 100% coverage and statements no older than 24 hours');
  await c.page.screenshot({ path: `${process.env.OUT}/backing-console.png`, fullPage: true });
  await go(c, `/issuer/backing?mint=${B.other}`);
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('halt-other').waitFor({ timeout: 25000 });
  log(/fixed at creation, so the watchdog cannot be used/.test(await text(c.page.getByTestId('halt-other'))), 'a halt state with another venue signer says the watchdog cannot be used with it');
  log(clean(c, ['404']).length === 0, `issuer: no console error or failed request ${clean(c, ['404']).join(' | ')}`);
  await c.ctx.close();

  const at = await person(browser, { name: 'attester', secret: P.attester.secret });
  await go(at, `/issuer/backing?mint=${B.backed}`);
  await ensureConnected(at, P.attester.address);
  await at.page.getByTestId('attest-box').waitFor({ timeout: 25000 });
  await at.page.getByLabel(/^Backing to state/).fill('1300');
  r = await act(at, 'attest');
  const att = ixOf(r.tx, 'cross_backing', 'attest');
  log(r.done && att && signerOf(att, P.attester.address) && String(att.args?.backingAtoms) === '1300000000', 'the attester’s Post the statement signs attest for 1300 tokens');
  log(/Backing stated1,200/.test((await text(at.page.locator('#statement'))).replace(/\s+/g, '')) || /1,200/.test(await text(at.page.locator('#statement'))), 'beside the statement on record (1,200, 10 minutes old)');
  await at.ctx.close();
  const ot = await person(browser, { name: 'notattester', secret: P.other.secret });
  await go(ot, `/issuer/backing?mint=${B.backed}`);
  await ensureConnected(ot, P.other.address);
  await ot.page.getByTestId('not-attester').waitFor({ timeout: 25000 });
  log((await ot.page.getByTestId('attest').count()) === 0, 'a wallet that is not the attester is not offered a statement');
  await ot.ctx.close();

  // ------------------------------------------------------------------ the program is not on the cluster
  await setMode('absent');
  const n = await person(browser, { name: 'absent', secret: f.secret });
  await go(n, `/backing/${B.backed}`);
  const notice = n.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first();
  await notice.waitFor({ timeout: 25000 });
  log(/Built, not on devnet yet/.test(await text(notice)) && /No backing policy/.test(await text(n.page.getByTestId('backing-badge'))), 'on a cluster without cross_backing the page says it is built, not on devnet yet, and invents no verdict');
  await go(n, `/issuer/backing?mint=${B.noPolicy}`);
  await ensureConnected(n, f.wallet);
  await n.page.getByTestId('policy-form').waitFor({ timeout: 25000 });
  await n.page.getByLabel('Attester').fill(P.attester.address);
  log(await n.page.getByTestId('create-policy').isDisabled(), 'the policy cannot be created');
  await n.page.screenshot({ path: `${process.env.OUT}/backing-absent.png`, fullPage: true });
  log(clean(n).length === 0, `absent: no console error or failed request ${clean(n).join(' | ')}`);
  await n.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
void hasAccount;
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
