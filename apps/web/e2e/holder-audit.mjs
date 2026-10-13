// A WCAG 2.2 AA audit over every route of the web app: axe-core with the 2.0, 2.1 and 2.2 A and AA rule sets plus its best-practice rules,
// at 1440 and 390, light and dark, with console errors, page errors and failed requests recorded for each page. Dynamic routes are given
// real addresses from the live index. Rate-limit answers (HTTP 429) from the shared public cluster endpoints are counted separately: they
// are an external flake (HUMAN_TASKS H26), not a page fault.
//
//   BASE_URL=http://localhost:3413 node e2e/holder-audit.mjs   (use a production build: the development server adds its own overlay)
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BASE, OUT, axe, launch, person, sleep } from './holder-lib.mjs';

const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const SRC = new URL('../src/app', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const pages = walk(SRC).filter((f) => /page\.tsx$/.test(f)).map((f) => '/' + relative(SRC, f).split(sep).slice(0, -1).join('/')).map((r) => (r === '/' ? '/' : r));

const j = async (path) => (await fetch(`${API}${path}`)).json();
const crosses = (await j('/v1/crosses?limit=50')).crosses;
const finalized = crosses.find((c) => c.state === 'Finalized' && c.clearing_price);
const live = crosses.find((c) => c.state === 'Live');
const treasury = (await j('/v1/treasuries')).treasuries[0];
const owner = finalized ? (await j(`/v1/crosses/${finalized.address}/orders`)).orders[0]?.owner : null;
const fill = (r) =>
  r
    .replace('[address]/[owner]', `${finalized?.address}/${owner}`)
    .replace('[address]', r.startsWith('/treasury') ? treasury.address : (finalized?.address ?? ''));
const routes = [...new Set(pages.map(fill))].filter((r) => !r.includes('['));
if (live) routes.push(`/crosses/${live.address}`);
if (process.env.ONLY) {
  const keep = new RegExp(process.env.ONLY);
  routes.splice(0, routes.length, ...routes.filter((r) => keep.test(r)));
}
console.log(`${routes.length} routes`);

const browser = await launch();
const report = [];
const SKIP = (t) => /status of 429| 429 https?:\/\//.test(t);
for (const [w, h, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
  const u = await person(browser, { name: `${w}-${theme}`, theme, viewport: { width: w, height: h } });
  for (const r of routes) {
    u.problems.length = 0;
    const rows = { route: r, width: w, theme, status: null, violations: [], problems: [], rateLimited: 0 };
    try {
      const resp = await u.page.goto(`${BASE}${r}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      rows.status = resp?.status() ?? null;
      await u.page.waitForLoadState('load').catch(() => undefined);
      await sleep(r.startsWith('/crosses/') || r === '/markets' ? 6000 : 2500);
      rows.violations = await axe(u);
      if (r === routes[0] || r.startsWith('/portfolio') || r.startsWith('/alerts') || r.startsWith('/markets') || r.startsWith('/practice') || r.startsWith('/crosses/')) {
        mkdirSync(OUT + '/audit', { recursive: true });
        await u.page.screenshot({ path: `${OUT}/audit/${r.replace(/\//g, '_').slice(0, 60) || '_home'}-${w}-${theme}.png`, fullPage: true });
      }
    } catch (e) {
      rows.problems.push(`navigation failed: ${String(e).slice(0, 120)}`);
    }
    rows.rateLimited = u.problems.filter(SKIP).length;
    rows.problems.push(...u.problems.filter((p) => !SKIP(p)));
    report.push(rows);
    console.log(`${rows.violations.length === 0 && rows.problems.length === 0 ? 'PASS' : 'FAIL'} ${w} ${theme} ${r} ${rows.status} axe:${rows.violations.length} problems:${rows.problems.length} 429s:${rows.rateLimited}`);
  }
  await u.context.close();
}
await browser.close();
writeFileSync(`${OUT}/../../${process.env.REPORT ?? 'W2C-M10-audit.json'}`, JSON.stringify({ at: new Date().toISOString(), base: BASE, axeTags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'], routes, results: report }, null, 1));
const bad = report.filter((x) => x.violations.length || x.problems.length);
console.log(`${report.length} page loads, ${bad.length} with findings`);
process.exit(bad.length ? 1 : 0);
