// Screenshots (read by a person), axe, overflow and console errors for every state of the W3B screens, light and dark, 1440 and 390.
import { BASE, OUT, connect, failures, fixtures, launch, log, setMode, settle, visualPass } from './issuer-w3b-lib.mjs';

const f = await fixtures();
const browser = await launch();
const only = process.env.ONLY;
const run = (name, opts) => (!only || only === name ? visualPass(browser, { name, secret: f.secret, ...opts }) : null);
const wallet = async (p) => {
  await connect(p, f.wallet);
  await settle(p.page);
};
const mints = async (page) => {
  await page.getByLabel('Token being sold (base mint)').fill(f.baseMint);
  await page.getByLabel('Paid in (quote mint)').fill(f.quoteMint);
  await page.getByRole('button', { name: 'Check mint' }).first().click();
  await page.getByRole('button', { name: 'Check mint' }).nth(1).click();
  await page.getByTestId('autofill').waitFor({ timeout: 20000 });
  await page.getByLabel('Step 1: price').fill('1.20');
  await page.getByLabel('Tokens offered').fill('1000');
};
const openAll = (page) => page.evaluate(() => document.querySelectorAll('[data-testid^="rules-group-"]').forEach((d) => d.setAttribute('open', '')));

try {
  await setMode('new');
  await run('wizard-rules', {
    route: '/issue',
    setup: async (p) => {
      await wallet(p);
      await mints(p.page);
      await p.page.getByTestId('rule-preset-hard-to-game-ending').click();
      await p.page.getByTestId('size-wait').waitFor({ timeout: 100 }).catch(() => undefined);
      await p.page.locator('[data-testid="rules-size"] [data-state]').first().waitFor({ timeout: 20000 });
      await openAll(p.page);
      await p.page.locator('#rules').scrollIntoViewIfNeeded();
    },
  });
  await run('treasury-extended', { route: `/issuer/treasury/${f.treasuries.extended}`, setup: wallet });
  await run('treasury-extend', { route: `/issuer/treasury/${f.treasuries.plain}`, setup: async (p) => { await wallet(p); await p.page.getByTestId('terms-preset-governed').click(); await p.page.getByTestId('term-field-recovery').locator('input').fill(f.recovery); await p.page.getByTestId('terms-verdict').locator('[data-state]').waitFor(); } });
  await run('treasury-liquidating', { route: `/issuer/treasury/${f.treasuries.liquidating}`, setup: wallet });
  await run('settle', { route: `/issuer/settle?cross=${f.crosses.bids}`, setup: async (p) => { await wallet(p); await p.page.getByTestId('greenshoe-state').waitFor({ timeout: 15000 }); } });
  await run('settle-fresh', { route: `/issuer/settle?cross=${f.crosses.fresh}`, setup: async (p) => { await wallet(p); await p.page.getByTestId('greenshoe-create').waitFor({ timeout: 15000 }); } });
  await setMode('old');
  await run('wizard-first-release', {
    route: '/issue',
    setup: async (p) => {
      await wallet(p);
      await mints(p.page);
      await p.page.getByTestId('rule-preset-hard-to-game-ending').click();
      await p.page.locator('[data-testid="program-notice"][data-release="first-release"]').first().waitFor({ timeout: 15000 });
      await p.page.locator('#rules').scrollIntoViewIfNeeded();
    },
  });
  await run('treasury-first-release', { route: `/issuer/treasury/${f.treasuries.extended}`, setup: wallet });
} catch (e) {
  log(false, `the run stopped: ${e.stack ?? e}`);
}
await setMode('new');
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
void BASE; void OUT;
