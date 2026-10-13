// Opens every page of the deployed site in light and dark, desktop and phone, and fails on any console error, page error,
// failed request (other than aborted prefetches) or horizontal overflow.
//   BASE_URL=https://opening-bell-psi.vercel.app API_URL=https://98-87-59-136.sslip.io node e2e/live-smoke.mjs
import { chromium } from '@playwright/test';
const BASE = process.env.BASE_URL ?? 'https://opening-bell-psi.vercel.app';
const API = process.env.API_URL ?? 'https://98-87-59-136.sslip.io';
const crosses = (await (await fetch(`${API}/v1/crosses?limit=200`)).json()).crosses;
const settled = crosses.find((c) => c.state === 'Finalized' && c.clearing_price);
const closed = crosses.find((c) => c.state === 'Live');
const pages = ['/', '/crosses', '/accuracy', '/premium', '/developers', '/status', '/calendar', '/orders', '/issue', '/no-such-page', `/crosses/${settled.address}`, ...(closed ? [`/crosses/${closed.address}`] : [])];
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const problems = [];
let n = 0;
for (const theme of ['light', 'dark']) for (const [w, h] of [[1440, 900], [390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  for (const p of pages) {
    const page = await ctx.newPage();
    const tag = `${p.slice(0, 40)} ${theme} ${w}`;
    page.on('console', (m) => { if (m.type() === 'error' && !/the server responded with a status of 404/.test(m.text()) || (m.type() === 'error' && p !== '/no-such-page')) problems.push(`${tag} console: ${m.text().slice(0, 140)}`); });
    page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message.slice(0, 140)}`));
    page.on('requestfailed', (r) => { if (!(/[?&]_rsc=/.test(r.url()) && r.failure()?.errorText === 'net::ERR_ABORTED')) problems.push(`${tag} requestfailed: ${r.url().slice(0, 100)} ${r.failure()?.errorText}`); });
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => problems.push(`${tag} goto: ${e.message.slice(0, 80)}`));
    await page.waitForTimeout(3500);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 0) problems.push(`${tag}: horizontal overflow ${over}px`);
    const txt = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    if (/unreachable|could not reach|undefined|NaN/.test(txt) && p !== '/no-such-page') problems.push(`${tag}: suspicious text ${(txt.match(/.{30}(unreachable|could not reach|undefined|NaN).{20}/) ?? [''])[0]}`);
    n++;
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(`${n} page views`);
console.log(problems.length ? problems.join('\n') : 'NO PROBLEMS');
process.exit(problems.length ? 1 : 0);
