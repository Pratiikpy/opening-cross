// Every page of the issuer area, light and dark, at 1440 and 390: no console or page errors, no horizontal overflow, no axe violations
// (WCAG 2.1 A and AA), and a screenshot of each for a person to read. Pages that need a wallet are visited once without and once with one.
//
//   ISSUER_KEY=issuer.json CROSS=<an issuer cross> DRAFT=<a draft id> BASE_URL=http://localhost:3210 OUT=../../docs/evidence/screens/w2b/visual \
//   CHROME=... node e2e/issuer-visual.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const key = JSON.parse(readFileSync(process.env.ISSUER_KEY, 'utf8'));
const BASE = process.env.BASE_URL ?? 'http://localhost:3210';
const OUT = process.env.OUT ?? 'e2e/screens/w2b-visual';
const CROSS = process.env.CROSS ?? '';
const DRAFT = process.env.DRAFT ?? '';
mkdirSync(OUT, { recursive: true });
const WALLET_JS = readFileSync(new URL('./issuer-wallet.js', import.meta.url), 'utf8');
const failures = [];
const log = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const PAGES = [
  { path: '/issue', name: 'issue', wallet: false },
  { path: '/issue', name: 'issue-wallet', wallet: true },
  { path: '/issuer', name: 'overview', wallet: true },
  { path: '/issuer/simulator', name: 'simulator', wallet: false },
  { path: '/issuer/demand', name: 'demand', wallet: true },
  ...(DRAFT ? [{ path: `/issuer/draft/${DRAFT}`, name: 'draft', wallet: false }] : []),
  { path: '/issuer/treasury', name: 'treasury', wallet: true },
  { path: '/issuer/treasury/new', name: 'treasury-new', wallet: true },
  { path: '/issuer/disclosures', name: 'disclosures', wallet: true },
  { path: '/issuer/apply', name: 'apply', wallet: true },
  { path: '/issuer/growth', name: 'growth', wallet: true },
  { path: '/issuer/accelerators', name: 'accelerators', wallet: false },
  ...(CROSS ? [{ path: `/issuer/qa/${CROSS}`, name: 'qa', wallet: false }] : []),
];

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
// COMBOS="1440:light,390:light,1440:dark,390:dark" (default) picks which width and theme pairs to run.
const COMBOS = (process.env.COMBOS ?? '1440:light,390:light,1440:dark,390:dark').split(',').map((c) => c.split(':'));
for (const theme of ['light', 'dark']) {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    if (!COMBOS.some(([w, t]) => Number(w) === width && t === theme)) continue;
    for (const p of PAGES) {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, timezoneId: 'UTC' });
      await ctx.addInitScript(`window.__E2E_WALLET__ = ${JSON.stringify({ name: 'E2E Test Wallet', secret: key, chain: 'solana:devnet' })};`);
      await ctx.addInitScript(WALLET_JS);
      const page = await ctx.newPage();
      const problems = [];
      page.on('console', (m) => m.type() === 'error' && !/429/.test(m.text()) && problems.push(m.text().slice(0, 140)));
      page.on('pageerror', (e) => problems.push(e.message.slice(0, 140)));
      const label = `${p.name} ${width} ${theme}`;
      page.setDefaultTimeout(25_000);
      const work = (async () => {
        await page.goto(`${BASE}${p.path}`, { waitUntil: 'load' });
        await page.waitForTimeout(1500);
        if (p.wallet) {
          await page.getByRole('button', { name: 'Connect wallet' }).click();
          await page.getByRole('button', { name: /E2E Test Wallet/ }).click();
          await page.getByRole('button', { name: 'Connect wallet' }).waitFor({ state: 'detached', timeout: 20_000 });
          await page.waitForTimeout(3500);
        } else await page.waitForTimeout(1500);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        const bad = axe.violations.map((v) => `${v.id}(${v.nodes.length})`);
        await page.screenshot({ path: `${OUT}/${p.name}-${width}-${theme}.png`, fullPage: false });
        log(overflow <= 0 && bad.length === 0 && problems.length === 0, `${label}${overflow > 0 ? ` overflow ${overflow}px` : ''}${bad.length ? ` axe ${bad.join(',')}` : ''}${problems.length ? ` errors ${problems.slice(0, 2).join(' | ')}` : ''}`);
      })();
      // A page that does not finish in a minute is a failure to report, not a reason to stop the sweep.
      await Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 60 s')), 60_000))]).catch((e) => log(false, `${label}: ${e instanceof Error ? e.message.split(String.fromCharCode(10))[0] : String(e)}`));
      await ctx.close();
    }
  }
}
await browser.close();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
