// Insider and treasury alerts in a real browser against real devnet (row F5, ADR-0940): a person looks up a cross on the Alerts page, sees which wallets following it would cover, follows its
// token, turns the insider alert on, and then a real transfer takes part of the creator's holding out: the scan reads the balance over RPC and the feed shows the alert.
//
//   services/api: ALERTS=1 FUNDER_KEYPAIR=... WEB_URL=http://localhost:3451 pnpm exec tsx test/receipt-harness.ts
//   apps/web:     BASE_URL=http://localhost:3451 OUT=docs/evidence/screens/w5-1e node e2e/w5-1e-alerts-movements.mjs
import { spawn } from 'node:child_process';
import { BASE, axe, check, launch, person, report, results, shot, sleep } from './holder-lib.mjs';

const CROSS = process.env.CROSS ?? '2VpFruARynmeEmaxDSh253TB1aLP2nA3945Yzz5hK29H';
const MINT = process.env.MINT ?? '7HHSa4g3BLJo9co2vpquwnzUSRCrgmS6xKcdZhunD8Aa';
const TREASURY = process.env.TREASURY ?? '3SeQFrJ9X3NzNeJzzPFBTGeaE9qvxcsGrNxy4Hidavsw';
// Topics are in the alerts store with the reminder topics; the tokens and treasuries followed are in the watch store with the crosses and markets.
const TOPICS_STORE = 'opening-bell.alerts.v1';
const WATCH_STORE = 'opening-bell.watch.v1';

const browser = await launch();
const u = await person(browser, { name: 'alerts movements', ignore: ['/v1/alerts/subject'] });
const page = u.page;
await page.goto(`${BASE}/alerts`, { waitUntil: 'domcontentloaded' });
const section = page.getByTestId('movement-section');
await section.waitFor({ timeout: 60000 });

// ---- what the deployment can serve
for (const t of ['insider', 'team', 'treasury']) {
  await page.waitForFunction((id) => document.querySelector(`[data-testid="topic-${id}"]`) !== null, t);
  check(await page.getByTestId(`topic-${t}`).isEnabled(), `the ${t} alert can be chosen on this deployment`);
}
check((await section.innerText()).includes('at least 0.1% of the token’s supply'), 'the page says how large a fall is an alert, and that small falls add up');
check((await section.innerText()).includes('not proof of a sale'), 'and that a fall is not proof of a sale');
await shot(u, 'alerts-movements-empty-1440-light');

// ---- look an address up before following it
const lookup = async (address) => {
  await section.getByLabel('Follow a token or a treasury').fill(address);
  await section.getByRole('button', { name: 'Check' }).click();
};
await lookup(CROSS);
const subject = page.getByTestId('subject');
await subject.waitFor({ timeout: 60000 });
check((await subject.getAttribute('data-kind')) === 'cross', 'a cross is recognised as a cross');
const text = await subject.innerText();
check(text.includes('This is a cross selling token 7HHS…D8Aa'), 'it says which token the cross sells');
check(text.includes('DTB3…KEdC') && text.includes('created cross 2VpF…K29H'), 'it lists the creator as an insider, with the fact that says so');
await shot(u, 'alerts-movements-subject-1440-light');

// ---- follow the token and turn the insider alert on
await subject.getByRole('button', { name: 'Follow' }).click();
await page.getByTestId('movement-following').waitFor();
check((await page.getByTestId('movement-following').innerText()).includes('7HHS…D8Aa'), 'the token is listed under what is followed');
await page.getByTestId('topic-insider').check();
await page.getByTestId('movement-note').filter({ hasText: 'Turned on' }).waitFor();
const saved = await page.evaluate(([a, w]) => ({ ...JSON.parse(localStorage.getItem(w) ?? '{}'), topics: JSON.parse(localStorage.getItem(a) ?? '{}').topics }), [TOPICS_STORE, WATCH_STORE]);
check(saved.tokens?.includes(MINT) && saved.topics?.includes('insider'), `this browser kept the choice (${JSON.stringify(saved)})`);

// ---- other addresses
await lookup(TREASURY);
await page.getByTestId('subject').filter({ hasText: 'This is a treasury' }).waitFor({ timeout: 60000 });
check((await subject.getAttribute('data-kind')) === 'treasury', 'a treasury is recognised, with a Follow that covers its payouts');
await lookup('11111111111111111111111111111111');
await page.getByTestId('subject').filter({ hasText: 'Nothing is known about this address' }).waitFor({ timeout: 60000 });
check(true, 'an address that is nothing says so and offers no Follow');
check((await subject.getByRole('button', { name: 'Follow' }).count()) === 0, 'and there is no Follow button for it');
await lookup('0'.repeat(40));
check(await page.getByTestId('movement-note').filter({ hasText: 'base58' }).waitFor({ timeout: 30000 }).then(() => true, () => false), 'junk input is refused with the server’s reason');

// ---- the choice survives a reload, and the feed reads the same follows
await page.reload({ waitUntil: 'domcontentloaded' });
await section.waitFor();
check(await page.getByTestId('topic-insider').isChecked(), 'after a reload the insider alert is still on');
check((await page.getByTestId('movement-following').innerText()).includes('7HHS…D8Aa'), 'and the token is still followed');

// ---- a real transfer takes 3% of the creator's holding out
console.log('waiting for the scan to take its baseline before the transfer');
await sleep(12000);
const child = spawn('pnpm', ['--filter', '@opening-cross/api', 'exec', 'tsx', 'test/alerts-movements-devnet.ts'], { cwd: 'C:/Users/prate/col', env: { ...process.env, TRANSFER_ONLY: '1', HOLD_SECONDS: process.env.HOLD_SECONDS ?? '170', CROSS }, shell: true });
let transferred = null;
let returned = null;
const closed = new Promise((r) => child.on('close', r));
child.stdout.on('data', (d) => {
  const t = String(d);
  process.stdout.write(t);
  const m = /TRANSFERRED .*: ([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(t);
  if (m) transferred = m[1];
  const b = /RETURNED ([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(t);
  if (b) returned = b[1];
});
child.stderr.on('data', (d) => process.stderr.write(String(d)));
const feed = page.getByTestId('feed');
let item = null;
for (let i = 0; i < 40 && !item; i++) {
  await sleep(6000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Needs you now' }).waitFor();
  item = (await feed.isVisible().catch(() => false)) ? await feed.locator('[data-kind="insider"]').first().innerText().catch(() => null) : null;
}
for (let i = 0; i < 30 && !transferred; i++) await sleep(1000);
check(transferred !== null, `the transfer was made on devnet (${transferred?.slice(0, 20)}…)`);
check(item !== null && item.includes('Insider wallet DTB3…KEdC moved 3.00% of token 7HHS…D8Aa out'), `the feed shows the insider alert (${item?.split('\n')[0]})`);
check(item?.includes('not proof of a sale') && item.includes('created cross 2VpF…K29H'), 'with its reason and its limit');
check(/just now|min ago/.test(item ?? ''), 'and when it was seen, in words');
check((await feed.locator('[data-kind="insider"] a').first().getAttribute('href')) === `/crosses/${CROSS}`, 'the alert opens the cross');
await shot(u, 'alerts-movements-feed-1440-light');
const bad = (await axe(u)).filter((x) => x.impact === 'serious' || x.impact === 'critical');
check(bad.length === 0, `axe finds no serious or critical violation${bad.length ? ` ${JSON.stringify(bad)}` : ''}`);
report(u);
await u.context.close();

// ---- dark and a phone, same state (the choice is in this browser only, so follow again)
for (const [theme, viewport, tag] of [['dark', { width: 1440, height: 900 }, '1440-dark'], ['light', { width: 390, height: 844 }, '390-light'], ['dark', { width: 390, height: 844 }, '390-dark']]) {
  const v = await person(browser, { name: `alerts ${tag}`, theme, viewport, ignore: ['/v1/alerts/subject'] });
  await v.context.addInitScript(([a, w, mint]) => { localStorage.setItem(a, JSON.stringify({ push: null, telegram: null, topics: ['claimable', 'closing', 'insider', 'treasury'] })); localStorage.setItem(w, JSON.stringify({ crosses: [], markets: [], tokens: [mint], treasuries: [] })); }, [TOPICS_STORE, WATCH_STORE, MINT]);
  await v.page.goto(`${BASE}/alerts`, { waitUntil: 'domcontentloaded' });
  await v.page.getByTestId('feed').waitFor({ timeout: 60000 }).catch(() => undefined);
  const overflow = await v.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${tag}: no horizontal overflow (${overflow}px)`);
  await shot(v, `alerts-movements-${tag}`);
  report(v);
  await v.context.close();
}
// The script returns the tokens to the creator after its hold; wait for it, never kill it first (the fresh wallet's key would be lost with the tokens in it).
await closed;
check(returned !== null, `the tokens were returned to the creator (${returned?.slice(0, 20)}…)`);
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
