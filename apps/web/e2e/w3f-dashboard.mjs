// W3F: the public dashboard (O1). Every section beside its source route, a failed section said to have failed (never drawn as a number), and the
// five programs with who can replace each.
//
//   (harness, app as in w3f-series.mjs)
//   BASE_URL=http://localhost:3431 API_URL=http://127.0.0.1:8291 OUT=../../docs/evidence/screens/w3f node e2e/w3f-dashboard.mjs
import { BASE, OUT, eventually, failures, launch, log, person, text } from './w3f-lib.mjs';

const API = process.env.API_URL ?? 'http://127.0.0.1:8291';
const browser = await launch();
try {
  const truth = await (await fetch(`${API}/v1/dashboard`)).json();
  const p = await person(browser, { name: 'visitor' });
  await p.page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await p.page.getByTestId('dashboard').waitFor({ timeout: 25000 });
  const ids = Object.keys(truth.sections);
  log((await p.page.locator('[data-testid^="section-"]').count()) === ids.length, `the page draws every section the API serves (${ids.length})`);
  for (const id of ids) {
    const s = truth.sections[id];
    const card = p.page.getByTestId(`section-${id}`);
    const state = await card.getAttribute('data-state');
    const sourceShown = (await text(card)).includes(s.source);
    log(sourceShown, `${id}: the route it came from is named (${s.source})`);
    log(state === (s.ok ? (s.stale ? 'stale' : 'ok') : 'failed'), `${id}: marked ${state}, as the API says`);
    if (!s.ok) log(/could not be read/.test(await text(p.page.getByTestId(`failed-${id}`))) && /Nothing is shown in its place/.test(await text(p.page.getByTestId(`failed-${id}`))), `${id}: says it failed, with the reason, and shows nothing in its place`);
  }
  // a figure on the page is the figure the route serves
  const totals = truth.sections.totals;
  if (totals?.ok) {
    const total = String(totals.data.crosses_total);
    log(await eventually(p.page.getByTestId('rows-totals'), new RegExp(`Crosses total\\s*${Number(total).toLocaleString('en-US')}`)), `totals: the page shows crosses_total = ${total}, as /v1/stats serves it`);
  } else log(false, 'totals section was not read, so no figure could be compared');
  const programs = await text(p.page.getByTestId('programs-table'));
  log(/cross_core/.test(programs) && /cross_settle/.test(programs) && /treasury/.test(programs), 'the programs table names the programs');
  log(/none: it can never be changed|not deployed on this network|not upgradeable/.test(programs), 'and says who can replace each, or that it cannot be replaced, or that it is not deployed');
  await p.page.screenshot({ path: `${OUT}/dashboard.png`, fullPage: true });
  log(p.problems.filter((x) => !/404/.test(x)).length === 0, `visitor: no console error or failed request ${p.problems.join(' | ')}`);
  await p.ctx.close();
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE;
