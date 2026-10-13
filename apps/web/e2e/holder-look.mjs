// A first look at holder pages: screenshots at 1440 and 390, light and dark, with a connected wallet and without.
import { BASE, axe, check, connect, keyFile, launch, person, report, results, shot, sleep } from './holder-lib.mjs';

const pages = (process.env.PAGES ?? '/alerts,/portfolio').split(',');
const walletKey = process.env.WALLET_KEY ?? 'live-buyer.json';
const browser = await launch();
for (const [vp, theme] of [[{ width: 1440, height: 900 }, 'light'], [{ width: 390, height: 844 }, 'dark'], [{ width: 1440, height: 900 }, 'dark'], [{ width: 390, height: 844 }, 'light']]) {
  const u = await person(browser, { name: `holder ${vp.width} ${theme}`, secret: keyFile(walletKey), theme, viewport: vp });
  for (const p of pages) {
    await u.page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
    await connect(u);
    await u.page.waitForTimeout(p === '/portfolio' ? 9000 : 4000);
    await shot(u, `look${p.replace(/\//g, '-')}-${vp.width}-${theme}`);
    const v = await axe(u);
    check(v.length === 0, `${p} ${vp.width} ${theme}: axe WCAG 2.2 AA ${v.length === 0 ? 'clean' : JSON.stringify(v).slice(0, 600)}`);
  }
  report(u);
  await u.context.close();
}
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
