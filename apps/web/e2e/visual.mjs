// Visual and runtime pass over every route: light and dark, desktop and mobile. For each it saves
// a full-page screenshot and fails on any console error, page error, failed request, horizontal
// overflow or axe-core violation (WCAG 2.1 AA rules).
//   BASE_URL=http://localhost:3000 OUT=../../docs/evidence/screens node e2e/visual.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.OUT ?? 'e2e/screens';
const ROUTES = (process.env.ROUTES ?? '/').split(',');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const failures = [];
for (const route of ROUTES) {
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const problems = [];
      page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      const actual = await page.evaluate(() => document.documentElement.dataset.theme);
      if (actual !== theme) problems.push(`theme: expected ${theme}, page applied ${actual}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`horizontal overflow: ${overflow}px`);
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of axe.violations) problems.push(`axe ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
      const name = `${route === '/' ? 'home' : route.replace(/\//g, '_').replace(/^_/, '')}-${device}-${theme}.png`;
      await page.screenshot({ path: `${OUT}/${name}`, fullPage: true });
      console.log(`${problems.length ? 'FAIL' : 'PASS'} ${route} ${device} ${theme} -> ${OUT}/${name}`);
      for (const p of problems) console.log(`  ${p}`);
      if (problems.length) failures.push(name);
      await ctx.close();
    }
  }
}
await browser.close();
process.exit(failures.length ? 1 : 0);
