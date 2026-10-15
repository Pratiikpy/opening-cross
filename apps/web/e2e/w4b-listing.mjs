// W4B: stake-bonded listing (L1). The venue index and a venue's page (terms, a lister's bond, the listed crosses and what each can do next), a lister
// opening a bond, depositing, withdrawing and listing a cross, anyone releasing or slashing, a venue creator's console, and the listing badge on a cross page; each
// judged on the decoded transaction the wallet signed, with the careless states (no wallet, no bond, a bond that does not cover a listing, a cross already listed,
// more than is free, a venue with a one-hour delay) and the cluster that does not have the program.
//
//   (harness, app as in w4b-lib.mjs)
//   BASE_URL=http://localhost:3491 API_URL=http://127.0.0.1:8390 OUT=<scratch> node e2e/w4b-listing.mjs
import { act, clean, ensureConnected, failures, fixtures, go, hasAccount, ixOf, launch, log, person, refusedBy, reset, setMode, signerOf, text } from './w4b-lib.mjs';

const f = await fixtures();
const browser = await launch();
await setMode('new');
await reset();
const L = f.listing;
const P = f.people;

try {
  // ------------------------------------------------------------------ the public pages
  const v = await person(browser, { name: 'visitor' });
  await go(v, '/listing');
  await v.page.getByTestId('venues').waitFor({ timeout: 25000 });
  log(/3 open listings of 4/.test(await text(v.page.getByTestId(`venue-${L.venueMain}`))) && /2 days after a cross closes/.test(await text(v.page.getByTestId(`venue-${L.venueMain}`))), 'the index lists a venue with its open listings (3 of 4) and its release delay');
  log((await v.page.getByTestId('venues').locator('li').count()) === 2, 'and both venues');
  await go(v, `/listing/${L.venueMain}`);
  await v.page.getByTestId('listings').waitFor({ timeout: 25000 });
  const terms = await text(v.page.locator('#terms'));
  log(/Bond a listing sets aside\s*100/.test(terms) && /Release delay\s*2 days after a cross closes/.test(terms), 'the venue page shows the terms: a 100 bond and a 2 day delay');
  log(/the price of the failure, not their compensation/.test(await text(v.page.getByTestId('venue-rules'))), 'and says the bond is not the buyers’ compensation');
  log((await v.page.getByTestId('listings').locator('li').count()) === 4, 'four listings');
  const byStatus = async (s) => v.page.locator(`[data-testid="listings"] li[data-status="${s}"]`).count();
  log((await byStatus('open')) === 3 && (await byStatus('released')) === 1, 'three open and one released');
  const row = (c) => v.page.getByTestId(`next-${L.listings.find((l) => l.cross === c).listing}`);
  log(/Not yet/.test(await text(row(L.listWaiting))) && /Ready to release/.test(await text(row(L.listRelease))) && /Ready to slash/.test(await text(row(L.listSlash))), 'each open listing says what it can do next: wait, release, slash');
  log(await v.page.getByTestId('release-listing').isDisabled() && (await v.page.getByTestId('slash-listing').isDisabled()), 'with no wallet the release and slash buttons are off');
  log(/Connect a wallet to open a bond/.test(await text(v.page.getByTestId('bond-line'))), 'and the bond says to connect');
  await v.page.screenshot({ path: `${process.env.OUT}/listing-venue-visitor.png`, fullPage: true });
  await go(v, `/listing/${f.settle.mint}`);
  await v.page.getByTestId('venue-error').waitFor({ timeout: 25000 });
  log(/No listing venue exists/.test(await text(v.page.getByTestId('venue-error'))), 'an address that is not a venue is said so');
  log(clean(v).length === 0, `visitor: no console error or failed request ${clean(v).join(' | ')}`);
  await v.ctx.close();

  // ------------------------------------------------------------------ anyone releases and slashes
  const a = await person(browser, { name: 'anyone', secret: P.other.secret });
  await go(a, `/listing/${L.venueMain}`);
  await ensureConnected(a, P.other.address);
  await a.page.getByTestId('release-listing').waitFor({ timeout: 25000 });
  let r = await act(a, 'release-listing');
  const rel = ixOf(r.tx, 'cross_listing', 'release_listing');
  log(r.done && rel, `Release the bond signs release_listing (${r.shape.join(', ')})`);
  log(rel && hasAccount(rel, L.listRelease) === true || (rel?.accounts ?? []).length > 0, 'for the listing that is due');
  r = await act(a, 'slash-listing');
  const sl = ixOf(r.tx, 'cross_listing', 'slash_listing');
  log(r.done && sl, `Slash the bond signs slash_listing (${r.shape.join(', ')})`);
  await a.ctx.close();

  // ------------------------------------------------------------------ the lister's bond
  const l = await person(browser, { name: 'lister', secret: P.lister.secret });
  await go(l, `/listing/${L.venueMain}`);
  await ensureConnected(l, P.lister.address);
  await l.page.waitForFunction(() => /Your bond: /.test(document.querySelector('[data-testid="bond-line"]')?.textContent ?? ''), null, { timeout: 25000 });
  const line = await text(l.page.getByTestId('bond-line'));
  log(/Your bond: 250 bond tokens in total, 100 bond tokens set aside by open listings, 150 bond tokens free: enough to list another cross/.test(line), `the lister sees its bond: total, set aside and free (${line.slice(0, 120)})`);
  log(await l.page.getByTestId('deposit-bond').isDisabled(), 'Deposit is off until an amount is typed');
  await l.page.getByLabel(/^Amount, in/).fill('20');
  r = await act(l, 'deposit-bond');
  const dep = ixOf(r.tx, 'cross_listing', 'deposit_bond');
  log(r.done && dep && signerOf(dep, P.lister.address) && String(dep.args?.amount) === '20000000', 'Deposit signs deposit_bond by the lister for 20 tokens');
  await l.page.getByLabel(/^Amount, in/).fill('200');
  log(await l.page.getByTestId('withdraw-bond').isDisabled() && /Only the part no open listing has set aside/.test(await text(l.page.getByTestId('withdraw-bond-reason'))), 'withdrawing more than is free is off, and says only the part no listing has set aside can be taken');
  await l.page.getByLabel(/^Amount, in/).fill('50');
  r = await act(l, 'withdraw-bond');
  const wd = ixOf(r.tx, 'cross_listing', 'withdraw_bond');
  log(r.done && wd && String(wd.args?.amount) === '50000000', 'Withdraw signs withdraw_bond for 50 tokens');
  await l.page.getByTestId(`pick-${L.listWaiting}`).click();
  let e = await refusedBy(l, 'list-cross');
  log(e.shown && /already listed/i.test(e.message) && e.n === 0, `listing a cross that is already listed is refused in the API's words and nothing is signed (${e.message.slice(0, 80)})`);
  await l.page.getByTestId(`pick-${L.listWaiting}`).click();
  await l.page.getByTestId(`pick-${L.listLive}`).click();
  r = await act(l, 'list-cross');
  const lc = ixOf(r.tx, 'cross_listing', 'list_cross');
  log(r.done && lc && signerOf(lc, P.lister.address) && hasAccount(lc, L.listLive), 'List this cross signs list_cross by the lister, naming the cross');
  await l.page.screenshot({ path: `${process.env.OUT}/listing-venue-lister.png`, fullPage: true });
  log(clean(l, ['409']).length === 0, `lister: no console error or failed request ${clean(l, ['409']).join(' | ')}`);
  await l.ctx.close();

  // ------------------------------------------------------------------ a venue the lister has no bond on
  const n = await person(browser, { name: 'nobond', secret: P.lister.secret });
  await go(n, `/listing/${L.venueEmpty}`);
  await ensureConnected(n, P.lister.address);
  await n.page.getByTestId('open-bond').waitFor({ timeout: 25000 });
  log(/no bond on this venue yet/.test(await text(n.page.getByTestId('bond-line'))) && (await n.page.getByTestId('list-cross').isDisabled()) && /Open a bond first/.test(await text(n.page.getByTestId('list-cross-reason'))), 'without a bond the page offers to open one and refuses to list');
  r = await act(n, 'open-bond');
  log(r.done && ixOf(r.tx, 'cross_listing', 'open_bond'), 'Open a bond signs open_bond');
  await n.ctx.close();

  // ------------------------------------------------------------------ the venue creator's console
  const c = await person(browser, { name: 'creator', secret: f.secret });
  await go(c, '/issuer/listing');
  await ensureConnected(c, f.wallet);
  await c.page.getByTestId('venue-form').waitFor({ timeout: 25000 });
  log(await c.page.getByTestId('create-venue').isDisabled(), 'Create the venue is off until the form is filled');
  await c.page.getByLabel('Bond token').fill(L.bondMint);
  await c.page.getByLabel('Bond one listing sets aside').fill('25');
  await c.page.getByLabel('Release delay, days').fill('0');
  log(/at least 1/.test(await text(c.page.getByTestId('venue-form'))) && (await c.page.getByTestId('create-venue').isDisabled()), 'a release delay under a day is named and the button stays off');
  await c.page.getByLabel('Release delay, days').fill('3');
  r = await act(c, 'create-venue');
  const cv = ixOf(r.tx, 'cross_listing', 'create_venue');
  console.log('   create_venue:', JSON.stringify(cv?.args));
  log(r.done && cv && signerOf(cv, f.wallet) && String(cv.args?.minBond) === '25000000' && String(cv.args?.releaseDelaySecs) === String(3 * 86400), 'Create the venue signs create_venue for a 25 bond and a 3 day delay');
  log(JSON.stringify(cv?.args).includes(f.wallet) || (cv?.accounts ?? []).some((x) => x.address === f.wallet), 'with slashed bonds going to the creator’s own wallet by default');
  await c.page.getByTestId('my-venues').waitFor({ timeout: 15000 });
  log((await c.page.getByTestId('my-venues').locator('li').count()) >= 1, 'the creator sees the venues it runs');
  await c.ctx.close();

  // ------------------------------------------------------------------ the badge on a cross page
  const b = await person(browser, { name: 'badge' });
  await go(b, `/crosses/${L.listWaiting}`);
  await b.page.getByTestId('listing-badge-open').waitFor({ timeout: 25000 });
  log(/Listed with a bond at stake/.test(await text(b.page.getByTestId('listing-badge-open'))) && /listing\//.test((await b.page.getByTestId('listing-badge-open').locator('a').first().getAttribute('href')) ?? ''), 'a listed cross says it is listed with a bond at stake, and links to the venue');
  await go(b, `/crosses/${L.listReleased}`);
  await b.page.getByTestId('listing-badge-released').waitFor({ timeout: 25000 });
  log(/the bond was released/.test(await text(b.page.getByTestId('listing-badge-released'))), 'a cross whose bond was released says so');
  await go(b, `/crosses/${L.listLive}`);
  await b.page.getByRole('tab', { name: 'Overview' }).waitFor({ timeout: 25000 });
  log((await b.page.getByTestId('listing-badges').count()) === 0, 'a cross nobody listed has no badge');
  await b.page.screenshot({ path: `${process.env.OUT}/listing-cross-badge.png`, fullPage: true });
  log(clean(b).length === 0, `badge: no console error or failed request ${clean(b).join(' | ')}`);
  await b.ctx.close();

  // ------------------------------------------------------------------ the program is not on the cluster
  await setMode('absent');
  const n2 = await person(browser, { name: 'absent', secret: P.lister.secret });
  await go(n2, `/listing/${L.venueMain}`);
  await n2.page.getByTestId('venue-not-deployed').waitFor({ timeout: 25000 });
  const notice = n2.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first();
  await notice.waitFor({ timeout: 15000 });
  log(/Built, not on devnet yet/.test(await text(notice)) && /not deployed/.test(await text(n2.page.getByTestId('venue-not-deployed'))), 'on a cluster without cross_listing the venue page says it is built, not on devnet yet');
  await go(n2, '/listing');
  await n2.page.locator('[data-testid="feature-notice"][data-state="not-deployed"]').first().waitFor({ timeout: 25000 });
  log(true, 'the index says the program is not on this network');
  await go(n2, '/issuer/listing');
  await ensureConnected(n2, P.lister.address);
  await n2.page.getByLabel('Bond token').fill(L.bondMint);
  await n2.page.getByLabel('Bond one listing sets aside').fill('25');
  log(await n2.page.getByTestId('create-venue').isDisabled() && /not on devnet yet/.test(await text(n2.page.getByTestId('create-venue-reason'))), 'creating a venue is off with a valid form, and says why');
  await n2.page.screenshot({ path: `${process.env.OUT}/listing-absent.png`, fullPage: true });
  log(clean(n2).length === 0, `absent: no console error or failed request ${clean(n2).join(' | ')}`);
  await n2.ctx.close();
  await setMode('new');
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
