// The native app's web build (react-native-web) at phone width, light and dark: what can be looked at without a device. The wallet
// module is Android-only, so the screens that need a connected wallet show their "connect a wallet" state here.
import { check, launch, person, report, results, shot } from './holder-lib.mjs';

const BASE = process.env.MOBILE_URL ?? 'http://localhost:8090';
const browser = await launch();
for (const theme of ['light', 'dark']) {
  const u = await person(browser, { name: `mobile ${theme}`, theme, viewport: { width: 390, height: 844 }, ignore: ['status of 429'] });
  await u.page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await u.page.waitForTimeout(10000);
  const text = await u.page.locator('body').innerText();
  check(/Opening Bell/.test(text), `mobile web ${theme}: the app renders (${text.slice(0, 60).replace(/\n/g, ' ')})`);
  await shot(u, `mobile-crosses-390-${theme}`);
  report(u);
  await u.context.close();
}
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
